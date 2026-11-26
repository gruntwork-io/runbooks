/**
 * The contract every `SessionDatabase` keeps. It runs against the in-memory
 * one (`TestSessionDatabase.test.ts`) and the SQLite one (platform-node's
 * `NodeSessionDatabase.test.ts`), so the fake the engine's tests use cannot
 * drift from the database the app ships.
 */
import { describe, expect, it } from "bun:test"
import { Effect, type Layer, Option } from "effect"
import { SessionDatabaseError } from "../errors/index.ts"
import {
  type EventRow,
  MAX_SESSION_EVENTS,
  SessionDatabase,
  type SessionRow,
} from "../services/SessionDatabase.ts"

/** A database a test has to itself, and how to release it. */
export interface OpenedDatabase {
  readonly layer: Layer.Layer<SessionDatabase>
  readonly release: () => Promise<void>
}

const HASH = `sha256:${"a".repeat(64)}`

const session = (id: string, over: Partial<SessionRow> = {}): SessionRow => ({
  id,
  runbook: "/rb/a.mdx",
  createdAt: 1,
  usedAt: 1,
  trusted: Option.none(),
  nextSequence: 0,
  ...over,
})

const event = (
  sessionId: string,
  block: string,
  kind: string,
  over: Partial<EventRow> = {},
): EventRow => ({
  session: sessionId,
  block,
  kind,
  version: 1,
  at: 1,
  runbookHash: HASH,
  fileHashes: {},
  payload: Uint8Array.of(1, 2, 3),
  ...over,
})

/** Each event's block and kind, in order. */
const placesOf = (events: ReadonlyArray<EventRow>) => events.map((e) => `${e.block}/${e.kind}`)

export function sessionDatabaseContract(name: string, open: () => Promise<OpenedDatabase>): void {
  const withDatabase = async <A>(
    program: Effect.Effect<A, SessionDatabaseError, SessionDatabase>,
  ): Promise<A> => {
    const opened = await open()
    try {
      return await Effect.runPromise(Effect.provide(program, opened.layer))
    } finally {
      await opened.release()
    }
  }

  describe(`${name}: the sessions database`, () => {
    it("finds a runbook's most recently used session by its path, the later of two used at once", async () => {
      const found = await withDatabase(
        Effect.gen(function* () {
          const db = yield* SessionDatabase
          yield* db.putSession(session("s1", { usedAt: 10 }))
          yield* db.putSession(session("s2", { usedAt: 20 }))
          yield* db.putSession(session("s3", { usedAt: 30, runbook: "/rb/b.mdx" }))
          yield* db.putSession(session("s4", { usedAt: 20 }))
          return {
            a: yield* db.latest("/rb/a.mdx"),
            b: yield* db.latest("/rb/b.mdx"),
            c: yield* db.latest("/rb/c.mdx"),
          }
        }),
      )
      expect(found).toEqual({
        a: Option.some(session("s4", { usedAt: 20 })),
        b: Option.some(session("s3", { usedAt: 30, runbook: "/rb/b.mdx" })),
        c: Option.none(),
      })
    })

    it("replaces a session's row, and keeps its events", async () => {
      // A sequence past 32 bits, as a session that did not save its close leaves.
      const trusted = session("s1", {
        usedAt: 50,
        trusted: Option.some(HASH),
        nextSequence: 2 ** 40,
      })
      const found = await withDatabase(
        Effect.gen(function* () {
          const db = yield* SessionDatabase
          yield* db.putSession(session("s1"))
          yield* db.putEvent(event("s1", "a", "values"))
          yield* db.putSession(trusted)
          return { latest: yield* db.latest("/rb/a.mdx"), events: yield* db.events("s1") }
        }),
      )
      expect(found).toEqual({ latest: Option.some(trusted), events: [event("s1", "a", "values")] })
    })

    it("keeps each block's latest event of each kind, where it was first saved, every field as given", async () => {
      const latest = event("s1", "a", "values", {
        version: 2,
        at: 1_764_000_000_123,
        runbookHash: `sha256:${"b".repeat(64)}`,
        fileHashes: { "scripts/deploy.sh": HASH, "templates/vpc": HASH },
        payload: Uint8Array.of(0, 255, 7, 0),
      })
      const events = await withDatabase(
        Effect.gen(function* () {
          const db = yield* SessionDatabase
          yield* db.putSession(session("s1"))
          yield* db.putEvent(event("s1", "a", "values"))
          yield* db.putEvent(event("s1", "b", "run"))
          yield* db.putEvent(event("s1", "a", "run"))
          yield* db.putEvent(latest)
          return yield* db.events("s1")
        }),
      )
      expect(placesOf(events)).toEqual(["a/values", "b/run", "a/run"])
      expect(events[0]).toEqual(latest)
    })

    it("keeps sessions' events apart, and refuses an event for a session it does not have", async () => {
      const found = await withDatabase(
        Effect.gen(function* () {
          const db = yield* SessionDatabase
          yield* db.putSession(session("s1"))
          yield* db.putSession(session("s2"))
          yield* db.putEvent(event("s1", "a", "values"))
          yield* db.putEvent(event("s2", "a", "values", { payload: Uint8Array.of(9) }))
          const refused = yield* Effect.match(db.putEvent(event("gone", "a", "values")), {
            onFailure: (error) => error,
            onSuccess: () => undefined,
          })
          return { s2: yield* db.events("s2"), gone: yield* db.events("gone"), refused }
        }),
      )
      expect(found.s2).toEqual([event("s2", "a", "values", { payload: Uint8Array.of(9) })])
      expect(found.gone).toEqual([])
      expect(found.refused).toBeInstanceOf(SessionDatabaseError)
    })

    it("deletes one event, or a session with its events; deleting what is not there does nothing", async () => {
      const found = await withDatabase(
        Effect.gen(function* () {
          const db = yield* SessionDatabase
          yield* db.putSession(session("s1"))
          yield* db.putSession(session("s2", { usedAt: 0 }))
          yield* db.putEvent(event("s1", "a", "values"))
          yield* db.putEvent(event("s1", "a", "run"))
          yield* db.putEvent(event("s2", "a", "run"))
          yield* db.deleteEvent("s1", "a", "run")
          yield* db.deleteEvent("s1", "a", "credential")
          const afterOne = placesOf(yield* db.events("s1"))
          yield* db.deleteSession("s1")
          yield* db.deleteSession("gone")
          return {
            afterOne,
            s1: yield* db.events("s1"),
            s2: placesOf(yield* db.events("s2")),
            latest: yield* db.latest("/rb/a.mdx"),
          }
        }),
      )
      expect(found).toEqual({
        afterOne: ["a/values"],
        s1: [],
        s2: ["a/run"],
        latest: Option.some(session("s2", { usedAt: 0 })),
      })
    })

    it("names the sessions unused since a time and beyond a count, least recently used first, up to a limit", async () => {
      const found = await withDatabase(
        Effect.gen(function* () {
          const db = yield* SessionDatabase
          for (const [id, usedAt] of [
            ["s1", 10],
            ["s2", 20],
            ["s3", 30],
            ["s4", 40],
            ["s5", 30],
          ] as const)
            yield* db.putSession(session(id, { usedAt }))
          return {
            unusedSince25: yield* db.expired({ before: 25, keep: 10, limit: 10 }),
            beyondTwo: yield* db.expired({ before: 0, keep: 2, limit: 10 }),
            both: yield* db.expired({ before: 15, keep: 3, limit: 10 }),
            limited: yield* db.expired({ before: 35, keep: 5, limit: 2 }),
            none: yield* db.expired({ before: 0, keep: 5, limit: 10 }),
          }
        }),
      )
      expect(found).toEqual({
        unusedSince25: ["s1", "s2"],
        beyondTwo: ["s1", "s2", "s3"],
        both: ["s1", "s2"],
        limited: ["s1", "s2"],
        none: [],
      })
    })

    it(`reads at most ${MAX_SESSION_EVENTS} of a session's events`, async () => {
      const read = await withDatabase(
        Effect.gen(function* () {
          const db = yield* SessionDatabase
          yield* db.putSession(session("s1"))
          for (let i = 0; i <= MAX_SESSION_EVENTS; i += 1)
            yield* db.putEvent(event("s1", `b${i}`, "values"))
          return yield* db.events("s1")
        }),
      )
      expect(read).toHaveLength(MAX_SESSION_EVENTS)
      expect(read[0]?.block).toBe("b0")
    })
  })
}
