/**
 * The sessions database: the only storage the session store reads and
 * writes. platform-node's `nodeSessionDatabase` keeps it in SQLite in the
 * app's data folder; tests use `../test-utils/TestSessionDatabase.ts`, and
 * `../test-utils/sessionDatabaseContract.ts` holds both to one contract.
 *
 * It keeps what it is given: the store encrypts every payload before it
 * gets here, so the database holds no secret in clear. Times are epoch
 * milliseconds.
 */
import { Context, type Effect, type Option } from "effect"
import type { SessionDatabaseError } from "../errors/index.ts"

/** The most events `events` returns for one session: three kinds for each of a few thousand blocks. */
export const MAX_SESSION_EVENTS = 10_000

export interface SessionRow {
  readonly id: string
  /** The runbook file, as an absolute path: a session is found by it. */
  readonly runbook: string
  readonly createdAt: number
  /** When the session was last opened or closed. Retention goes by it. */
  readonly usedAt: number
  /** The content hash the person trusted the session for, if they did. */
  readonly trusted: Option.Option<string>
  /** The event sequence a later session of this id starts from. */
  readonly nextSequence: number
}

/** A block's latest event of one kind. Saving another of the same block and kind replaces it. */
export interface EventRow {
  readonly session: string
  readonly block: string
  readonly kind: string
  /** The saved-session version the payload was written in. */
  readonly version: number
  readonly at: number
  /** The runbook's content hash when the event was saved. */
  readonly runbookHash: string
  /** The content hash of each file the block names, by path, when the event was saved. */
  readonly fileHashes: Readonly<Record<string, string>>
  /** Encrypted. */
  readonly payload: Uint8Array
}

export interface SessionDatabaseShape {
  /** The runbook's most recently used session. None when it has none. */
  readonly latest: (
    runbook: string,
  ) => Effect.Effect<Option.Option<SessionRow>, SessionDatabaseError>
  /** Adds the session, or replaces its row. Its events stay. */
  readonly putSession: (row: SessionRow) => Effect.Effect<void, SessionDatabaseError>
  /** The session's events, oldest first, at most `MAX_SESSION_EVENTS`. */
  readonly events: (session: string) => Effect.Effect<ReadonlyArray<EventRow>, SessionDatabaseError>
  /** Saves the event in place of the block's last one of its kind. Its session must exist. */
  readonly putEvent: (row: EventRow) => Effect.Effect<void, SessionDatabaseError>
  /** Deletes the block's event of `kind`. Deleting one that does not exist does nothing. */
  readonly deleteEvent: (
    session: string,
    block: string,
    kind: string,
  ) => Effect.Effect<void, SessionDatabaseError>
  /**
   * The sessions retention drops: each last used before `before`, and each
   * beyond the `keep` most recently used. Least recently used first, at
   * most `limit`.
   */
  readonly expired: (options: {
    readonly before: number
    readonly keep: number
    readonly limit: number
  }) => Effect.Effect<ReadonlyArray<string>, SessionDatabaseError>
  /** Deletes the session and its events. Deleting one that does not exist does nothing. */
  readonly deleteSession: (id: string) => Effect.Effect<void, SessionDatabaseError>
}

export class SessionDatabase extends Context.Service<SessionDatabase, SessionDatabaseShape>()(
  "@runbooks/core/services/SessionDatabase",
) {}
