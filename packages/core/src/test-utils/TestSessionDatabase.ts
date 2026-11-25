/**
 * An in-memory `SessionDatabase` for tests. `sessionDatabaseContract.ts`
 * holds it to the same contract as the SQLite one. A test reads back every
 * row as saved, writes rows as another version would, and can make any
 * call fail as the disk would.
 */
import { Effect, Layer, Option } from "effect"
import { SessionDatabaseError } from "../errors/index.ts"
import {
  type EventRow,
  MAX_SESSION_EVENTS,
  SessionDatabase,
  type SessionDatabaseShape,
  type SessionRow,
} from "../services/SessionDatabase.ts"

export interface MemorySessionDatabase {
  readonly layer: Layer.Layer<SessionDatabase>
  /** Every session's row, in the order first saved. */
  readonly sessions: () => ReadonlyArray<SessionRow>
  /** Every session's events, in the order first saved. */
  readonly events: () => ReadonlyArray<EventRow>
  /** Saves an event as another version of the app would have. False when its session does not exist. */
  readonly put: (row: EventRow) => boolean
  /** The calls that fail from now on, as a disk error would. */
  readonly failing: Set<keyof SessionDatabaseShape>
}

const eventKey = (session: string, block: string, kind: string) =>
  JSON.stringify([session, block, kind])

export function memorySessionDatabase(): MemorySessionDatabase {
  // A Map keeps each key in the place it was first set, as SQLite keeps a replaced row's rowid.
  const sessions = new Map<string, SessionRow>()
  const events = new Map<string, EventRow>()
  const failing = new Set<keyof SessionDatabaseShape>()

  const call = <A>(name: keyof SessionDatabaseShape, run: () => A) =>
    Effect.suspend(() =>
      failing.has(name)
        ? Effect.fail(new SessionDatabaseError({ action: name, cause: new Error("disk error") }))
        : Effect.sync(run),
    )

  /** Most recently used first; a later session first among those used at once. */
  const byUse = () =>
    Array.from(sessions.values())
      .map((row, place) => ({ row, place }))
      .sort((a, b) => b.row.usedAt - a.row.usedAt || b.place - a.place)

  /** Whether the event was saved: its session must exist, as a foreign key requires. */
  const put = (row: EventRow): boolean => {
    if (!sessions.has(row.session)) return false
    events.set(eventKey(row.session, row.block, row.kind), row)
    return true
  }

  const shape: SessionDatabaseShape = {
    latest: (runbook) =>
      call("latest", () =>
        Option.fromUndefinedOr(byUse().find(({ row }) => row.runbook === runbook)?.row),
      ),
    putSession: (row) => call("putSession", () => void sessions.set(row.id, row)),
    events: (session) =>
      call("events", () =>
        Array.from(events.values())
          .filter((row) => row.session === session)
          .slice(0, MAX_SESSION_EVENTS),
      ),
    putEvent: (row) =>
      Effect.flatMap(
        call("putEvent", () => put(row)),
        (saved) =>
          saved
            ? Effect.void
            : Effect.fail(
                new SessionDatabaseError({
                  action: "putEvent",
                  cause: new Error(`There is no session ${row.session}.`),
                }),
              ),
      ),
    deleteEvent: (session, block, kind) =>
      call("deleteEvent", () => void events.delete(eventKey(session, block, kind))),
    expired: ({ before, keep, limit }) =>
      call("expired", () =>
        byUse()
          .filter(({ row }, rank) => row.usedAt < before || rank >= keep)
          .reverse()
          .slice(0, limit)
          .map(({ row }) => row.id),
      ),
    deleteSession: (id) =>
      call("deleteSession", () => {
        sessions.delete(id)
        for (const [key, row] of events) if (row.session === id) events.delete(key)
      }),
  }

  return {
    layer: Layer.succeed(SessionDatabase, SessionDatabase.of(shape)),
    sessions: () => Array.from(sessions.values()),
    events: () => Array.from(events.values()),
    put,
    failing,
  }
}
