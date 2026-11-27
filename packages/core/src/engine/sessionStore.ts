/**
 * The session store (work product 2.8): what a session saves, so a person
 * who closes the app and opens the same runbook again finds it as they left
 * it, and what a resumed session may take back.
 *
 * - A session is one row, found by its runbook's path, and each block's
 *   latest state of each kind: a form's values (`values`), a run or a
 *   submit (`run`), a Ready credential's login (`credential`). Saving one
 *   replaces the block's last of its kind: the engine resumes only the
 *   latest, so nothing older is kept.
 * - Each payload is JSON in `SAVED_SESSION_VERSION`'s schema, encrypted by
 *   `SessionCipher`. Where the system cannot encrypt, no payload is saved:
 *   only the session's row, which holds its path and trusted hash and no
 *   secret.
 * - Each state saved records the runbook's content hash and the hash of
 *   each file its block names (`resumeOf`).
 * - Nothing here fails a session: a save or read the database refuses is
 *   logged, and the session goes on as if nothing were saved.
 */
import { Clock, Context, DateTime, Effect, Layer, Option, Redacted, Schema } from "effect"
import { type BlockId, TaskError } from "@runbooks/blocks-core/contract"
import { FieldValue } from "@runbooks/blocks-core/form"
import { type Registry, resolveTag } from "@runbooks/blocks-core/registry"
import { Outcome } from "@runbooks/blocks-core/status"
import { Target } from "../credential/provider.ts"
import { ContentHash, type RunbookDocument } from "../document/document.ts"
import type { SessionDatabaseError } from "../errors/index.ts"
import { SessionCipher } from "../services/SessionCipher.ts"
import { type EventRow, SessionDatabase, type SessionRow } from "../services/SessionDatabase.ts"
import { LogLine, type ResumeProblem, type Resumed, SessionId } from "./protocol.ts"

/**
 * The schema version of what this Runbooks saves. A later version adds to
 * the schemas and raises it; it reads what an older one saved as its own.
 */
export const SAVED_SESSION_VERSION = 1
/** The longest payload saved or read, in characters of JSON, as today's app allows. */
export const MAX_SAVED_PAYLOAD_CHARS = 1_048_576
/** A run's log is saved as its last lines, at most this many... */
export const MAX_SAVED_LOG_LINES = 500
/** ...and at most this many characters, as today's app saves it. */
export const MAX_SAVED_LOG_CHARS = 65_536
/**
 * The event sequences a session reserves when it opens. A later session of
 * its id starts where it ended, once its close is saved, and past the
 * reserve if it never is: an app that stops without closing. One session
 * logs fewer events than this (4 billion; at 1,000 a second, 50 days).
 */
export const SEQUENCE_RESERVE = 2 ** 32
/** A session not used for this long goes, with its folders, at the next start. */
export const MAX_SESSION_AGE_MILLIS = 90 * 24 * 60 * 60 * 1000
/** The most sessions kept: beyond them, the least recently used go at the next start. */
export const MAX_KEPT_SESSIONS = 100
/** The most sessions that go at one start, so a start does bounded work; the rest go at the next. */
export const MAX_EXPIRED_PER_START = 50

// ---------------------------------------------------------------------------
// What is saved
// ---------------------------------------------------------------------------

export const SavedValues = Schema.Struct({
  /** By field name: null for a field left empty. */
  values: Schema.Record(Schema.String, Schema.NullOr(FieldValue)),
})
export type SavedValues = typeof SavedValues.Type

/** The end of a run's log. */
export const SavedLog = Schema.Struct({
  /** How many lines came before the ones kept. */
  omitted: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  lines: Schema.Array(LogLine).check(Schema.isMaxLength(MAX_SAVED_LOG_LINES)),
})
export type SavedLog = typeof SavedLog.Type

/**
 * A run's log as it is saved: its last `MAX_SAVED_LOG_LINES` lines, no more
 * than `MAX_SAVED_LOG_CHARS` characters, whole lines: a line is never longer
 * (`LIMITS.maxLogLineLength`). `last` is the end of the log the session
 * holds, and `total` how many lines the run has written.
 */
export function savedLogOf(last: ReadonlyArray<LogLine>, total: number): SavedLog {
  const lines: LogLine[] = []
  let chars = 0
  for (const line of last.slice(-MAX_SAVED_LOG_LINES).reverse()) {
    chars += line.text.length
    if (chars > MAX_SAVED_LOG_CHARS) break
    lines.push(line)
  }
  return { omitted: total - lines.length, lines: lines.reverse() }
}

export const SavedRun = Schema.Union([
  /** A form block, submitted. */
  Schema.TaggedStruct("Submitted", {}),
  /** A run the app stopped on before it ended. */
  Schema.TaggedStruct("Running", {}),
  Schema.TaggedStruct("Done", {
    outcome: Outcome,
    outputs: Schema.Array(
      Schema.Struct({ key: Schema.String, value: Schema.String, sensitive: Schema.Boolean }),
    ),
    /** What the script wrote to `$RUNBOOK_ENV`. */
    env: Schema.Record(Schema.String, Schema.String),
    repository: Schema.NullOr(
      Schema.Struct({ path: Schema.String, remoteUrl: Schema.NullOr(Schema.String) }),
    ),
    log: SavedLog,
  }),
  Schema.TaggedStruct("Failed", { error: TaskError, log: SavedLog }),
])
export type SavedRun = typeof SavedRun.Type

/** A Ready credential block's login: what its provider checks again when the session resumes. */
export const SavedCredential = Schema.Struct({
  /** The provider the block named. A block that names another one now does not take it back. */
  provider: Schema.String,
  /** Where the login came from, as the Ready state showed it. */
  source: Schema.String,
  targets: Schema.Record(Schema.String, Schema.NullOr(Target)),
  /** What the provider's `env` gave, by name, and whether it marked each one sensitive. */
  values: Schema.Record(
    Schema.String,
    Schema.Struct({ value: Schema.String, secret: Schema.Boolean }),
  ),
})
export type SavedCredential = typeof SavedCredential.Type

export type Saved =
  | { readonly kind: "values"; readonly payload: SavedValues }
  | { readonly kind: "run"; readonly payload: SavedRun }
  | { readonly kind: "credential"; readonly payload: SavedCredential }
export type SavedKind = Saved["kind"]

/** A JSON text holding `schema`'s value. */
const jsonOf = <S extends Schema.Top>(schema: S) =>
  Schema.fromJsonString(Schema.toCodecJson(schema))

const valuesJson = jsonOf(SavedValues)
const runJson = jsonOf(SavedRun)
const credentialJson = jsonOf(SavedCredential)

function encodePayload(saved: Saved): string {
  switch (saved.kind) {
    case "values":
      return Schema.encodeSync(valuesJson)(saved.payload)
    case "run":
      return Schema.encodeSync(runJson)(saved.payload)
    case "credential":
      return Schema.encodeSync(credentialJson)(saved.payload)
  }
}

function decodePayload(kind: string, json: string): Option.Option<Saved> {
  switch (kind) {
    case "values":
      return Option.map(Schema.decodeUnknownOption(valuesJson)(json), (payload): Saved => ({
        kind,
        payload,
      }))
    case "run":
      return Option.map(Schema.decodeUnknownOption(runJson)(json), (payload): Saved => ({
        kind,
        payload,
      }))
    case "credential":
      return Option.map(Schema.decodeUnknownOption(credentialJson)(json), (payload): Saved => ({
        kind,
        payload,
      }))
    default:
      return Option.none()
  }
}

// ---------------------------------------------------------------------------
// What is read back
// ---------------------------------------------------------------------------

/** One block's saved state of one kind, as read back. */
export interface SavedEvent {
  readonly block: string
  readonly kind: string
  readonly version: number
  readonly runbookHash: string
  readonly fileHashes: Readonly<Record<string, string>>
  /**
   * `Newer`: a newer Runbooks saved it, so it was not read. `Unreadable`: it
   * could not be decrypted, or is not what its kind holds.
   */
  readonly content:
    | { readonly _tag: "Read"; readonly saved: Saved }
    | { readonly _tag: "Newer" }
    | { readonly _tag: "Unreadable" }
}

/** A runbook's saved session, as read back. */
export interface SavedSession {
  readonly id: SessionId
  readonly createdAt: number
  readonly usedAt: number
  /** The content hash the person trusted it for, if they did. */
  readonly trusted: Option.Option<ContentHash>
  /** The event sequence it resumes from (`SEQUENCE_RESERVE`). */
  readonly nextSequence: number
  readonly events: ReadonlyArray<SavedEvent>
}

/** What a resumed session takes back, by block, and what it does not. */
export interface Resume {
  readonly values: ReadonlyMap<BlockId, SavedValues>
  readonly runs: ReadonlyMap<BlockId, SavedRun>
  readonly credentials: ReadonlyMap<BlockId, SavedCredential>
  readonly resumed: Resumed
}

/** The hash of each file each block names, by path, as `document` holds them. A misconfigured block names none. */
export function fileHashesOf(
  document: RunbookDocument,
  registry: Registry,
): ReadonlyMap<BlockId, Readonly<Record<string, string>>> {
  return new Map(
    document.blocks.flatMap((node) => {
      if (node.id === undefined) return []
      const block = node.errors.length > 0 ? undefined : resolveTag(registry, node.tag)?.block
      const files = block?.runbookFiles(node.props) ?? []
      const hashes = files.flatMap((file) => {
        const hash = document.hash.files[file]
        return hash === undefined ? [] : [[file, hash] as const]
      })
      return [[node.id, Object.fromEntries(hashes)] as const]
    }),
  )
}

const sameRecord = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>) => {
  const keys = Object.keys(a)
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key])
  )
}

/**
 * What a resumed session of `document` takes back from `saved`, by open
 * decision 6's recommendation:
 * - Form values and credentials, saved by this version or an older one.
 * - A run or submit only if this version saved it, for the runbook as it
 *   is now and the files its block names as they are now.
 * - Nothing a newer version saved, nothing that cannot be read, and
 *   nothing for a block the runbook no longer has.
 *
 * Trust is not taken back here: the session checks the hash it was saved
 * with against its own (`Session.trust`). A trusted session whose content
 * changed is `RunbookChanged`, so a client can say why it asks again.
 */
export function resumeOf(
  document: RunbookDocument,
  registry: Registry,
  saved: SavedSession,
): Resume {
  const files = fileHashesOf(document, registry)
  const ids = new Map<string, BlockId>(
    document.blocks.flatMap((node) => (node.id === undefined ? [] : [[node.id, node.id] as const])),
  )
  const values = new Map<BlockId, SavedValues>()
  const runs = new Map<BlockId, SavedRun>()
  const credentials = new Map<BlockId, SavedCredential>()
  const older = new Map<number, Set<BlockId>>()
  const newer = new Map<number, Set<BlockId>>()
  const changed = new Set<BlockId>()
  const unreadable = new Set<BlockId>()
  const add = (by: Map<number, Set<BlockId>>, version: number, block: BlockId) =>
    by.set(version, (by.get(version) ?? new Set<BlockId>()).add(block))

  for (const event of saved.events) {
    const block = ids.get(event.block)
    if (block === undefined) continue
    const { content } = event
    if (content._tag === "Newer") {
      add(newer, event.version, block)
      continue
    }
    if (content._tag === "Unreadable") {
      unreadable.add(block)
      continue
    }
    const { saved: state } = content
    switch (state.kind) {
      case "values":
        values.set(block, state.payload)
        break
      case "credential":
        credentials.set(block, state.payload)
        break
      case "run":
        if (event.version < SAVED_SESSION_VERSION) add(older, event.version, block)
        else if (
          event.runbookHash !== document.hash.runbook ||
          !sameRecord(event.fileHashes, files.get(block) ?? {})
        )
          changed.add(block)
        else runs.set(block, state.payload)
        break
    }
  }

  const byVersion = (by: Map<number, Set<BlockId>>) =>
    Array.from(by)
      .sort(([a], [b]) => a - b)
      .map(([version, blocks]) => ({ version, blocks: Array.from(blocks) }))
  const trustLost = Option.isSome(saved.trusted) && saved.trusted.value !== document.hash.combined
  const problems: ReadonlyArray<ResumeProblem> = [
    ...byVersion(older).map(({ version, blocks }) => ({
      _tag: "OlderVersion" as const,
      version,
      blocks,
    })),
    ...byVersion(newer).map(({ version, blocks }) => ({
      _tag: "NewerVersion" as const,
      version,
      blocks,
    })),
    ...(changed.size > 0 || trustLost
      ? [{ _tag: "RunbookChanged" as const, blocks: Array.from(changed) }]
      : []),
    ...(unreadable.size > 0
      ? [{ _tag: "Unreadable" as const, blocks: Array.from(unreadable) }]
      : []),
  ]
  return {
    values,
    runs,
    credentials,
    resumed: { lastUsed: DateTime.makeUnsafe(saved.usedAt), problems },
  }
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** Where one session saves what it holds. No call fails: one the database refuses is logged. */
export interface SessionSaver {
  /** Saves `saved` as the block's latest of its kind, with the hash of each file the block names. */
  readonly put: (
    block: BlockId,
    saved: Saved,
    files: Readonly<Record<string, string>>,
  ) => Effect.Effect<void>
  /** Deletes the block's saved state of `kind`. */
  readonly drop: (block: BlockId, kind: SavedKind) => Effect.Effect<void>
  /** Saves that the person trusted the session for `hash`. */
  readonly trust: (hash: ContentHash) => Effect.Effect<void>
  /** Marks the session used now, as it closes, and saves the sequence a later session of it starts from. */
  readonly close: (nextSequence: number) => Effect.Effect<void>
}

export interface SessionStoreShape {
  /** The runbook's most recently used saved session, read. None when it has none, or it cannot be read. */
  readonly latest: (runbook: string) => Effect.Effect<Option.Option<SavedSession>>
  /**
   * Saves the session's row, used now, trusted for nothing until the session
   * saves that it is, and reserving `SEQUENCE_RESERVE` sequences from
   * `firstSequence`; and gives what saves its blocks.
   */
  readonly keep: (session: {
    readonly id: SessionId
    readonly runbook: string
    /** The runbook's content hash, which each state saved records. */
    readonly runbookHash: ContentHash
    readonly createdAt: number
    /** The session's first event sequence. */
    readonly firstSequence: number
  }) => Effect.Effect<SessionSaver>
  /**
   * The sessions retention drops now: each unused for `MAX_SESSION_AGE_MILLIS`,
   * and each beyond the `MAX_KEPT_SESSIONS` most recently used, least recently
   * used first, at most `MAX_EXPIRED_PER_START`. The caller deletes their
   * folders, then `forget`s them. A row whose id is no session's has no
   * folders, and goes here.
   */
  readonly expired: Effect.Effect<ReadonlyArray<SessionId>>
  /** Deletes the session and everything it saved. */
  readonly forget: (id: SessionId) => Effect.Effect<void>
}

/** A session id the engine made: a UUID, so it names a folder and nothing outside it. */
const SAVED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const decodeSessionId = Schema.decodeUnknownOption(SessionId)
const sessionIdOf = (id: string): Option.Option<SessionId> =>
  SAVED_ID.test(id) ? decodeSessionId(id) : Option.none()
const decodeContentHash = Schema.decodeUnknownOption(ContentHash)

const warn = (error: SessionDatabaseError) =>
  Effect.logWarning(
    `The session store could not ${error.action}: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`,
  )

const make = Effect.gen(function* () {
  const db = yield* SessionDatabase
  const cipher = yield* SessionCipher
  /** Warned once per run that nothing is saved encrypted. */
  let warnedUnencrypted = false

  const readEvent = (row: EventRow): Effect.Effect<SavedEvent> => {
    const { block, kind, version, runbookHash, fileHashes } = row
    const event = (content: SavedEvent["content"]): SavedEvent => ({
      block,
      kind,
      version,
      runbookHash,
      fileHashes,
      content,
    })
    if (version > SAVED_SESSION_VERSION) return Effect.succeed(event({ _tag: "Newer" }))
    return Effect.map(cipher.decrypt(row.payload), (text) =>
      event(
        Option.match(
          Option.flatMap(
            Option.filter(text, (json) => Redacted.value(json).length <= MAX_SAVED_PAYLOAD_CHARS),
            (json) => decodePayload(kind, Redacted.value(json)),
          ),
          {
            onNone: () => ({ _tag: "Unreadable" }),
            onSome: (saved) => ({ _tag: "Read", saved }),
          },
        ),
      ),
    )
  }

  const latest = (runbook: string) =>
    Effect.gen(function* () {
      const row = yield* db.latest(runbook)
      if (Option.isNone(row)) return Option.none<SavedSession>()
      const id = sessionIdOf(row.value.id)
      if (Option.isNone(id)) return Option.none<SavedSession>()
      const events = yield* Effect.forEach(yield* db.events(row.value.id), readEvent)
      return Option.some<SavedSession>({
        id: id.value,
        createdAt: row.value.createdAt,
        usedAt: row.value.usedAt,
        trusted: Option.flatMap(row.value.trusted, decodeContentHash),
        nextSequence: row.value.nextSequence,
        events,
      })
    }).pipe(Effect.catch((error) => Effect.as(warn(error), Option.none<SavedSession>())))

  const keep: SessionStoreShape["keep"] = ({
    id,
    runbook,
    runbookHash,
    createdAt,
    firstSequence,
  }) =>
    Effect.gen(function* () {
      let row: SessionRow = {
        id,
        runbook,
        createdAt,
        usedAt: yield* Clock.currentTimeMillis,
        trusted: Option.none(),
        nextSequence: firstSequence + SEQUENCE_RESERVE,
      }
      const saveRow = (next: SessionRow) =>
        Effect.suspend(() => {
          row = next
          return db.putSession(row)
        }).pipe(Effect.catch(warn))
      yield* saveRow(row)

      const drop = (block: BlockId, kind: SavedKind) =>
        db.deleteEvent(id, block, kind).pipe(Effect.catch(warn))

      const put: SessionSaver["put"] = (block, saved, files) =>
        Effect.gen(function* () {
          const json = encodePayload(saved)
          if (json.length > MAX_SAVED_PAYLOAD_CHARS) {
            yield* Effect.logWarning(
              `${block}'s ${saved.kind} was not saved: its ${json.length} characters are over the ${MAX_SAVED_PAYLOAD_CHARS} a saved state may hold.`,
            )
            // What it replaces is no longer what the block holds.
            return yield* drop(block, saved.kind)
          }
          const payload = yield* cipher.encrypt(Redacted.make(json))
          if (Option.isNone(payload)) {
            if (!warnedUnencrypted) {
              warnedUnencrypted = true
              yield* Effect.logWarning(
                "This system offers no encryption now, so sessions are saved without their values, runs or credentials.",
              )
            }
            return yield* drop(block, saved.kind)
          }
          yield* db
            .putEvent({
              session: id,
              block,
              kind: saved.kind,
              version: SAVED_SESSION_VERSION,
              at: yield* Clock.currentTimeMillis,
              runbookHash,
              fileHashes: files,
              payload: payload.value,
            })
            .pipe(Effect.catch(warn))
        })

      return {
        put,
        drop,
        trust: (hash) => saveRow({ ...row, trusted: Option.some(hash) }),
        close: (nextSequence) =>
          Effect.flatMap(Clock.currentTimeMillis, (usedAt) =>
            saveRow({ ...row, usedAt, nextSequence }),
          ),
      } satisfies SessionSaver
    })

  const forget = (id: string) => db.deleteSession(id).pipe(Effect.catch(warn))

  const expired = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const ids = yield* db.expired({
      before: now - MAX_SESSION_AGE_MILLIS,
      keep: MAX_KEPT_SESSIONS,
      limit: MAX_EXPIRED_PER_START,
    })
    return yield* Effect.forEach(ids, (id) =>
      Option.match(sessionIdOf(id), {
        onSome: (session) => Effect.succeed([session]),
        onNone: () => Effect.as(forget(id), []),
      }),
    ).pipe(Effect.map((found) => found.flat()))
  }).pipe(Effect.catch((error) => Effect.as(warn(error), [])))

  return SessionStore.of({ latest, keep, expired, forget })
})

export class SessionStore extends Context.Service<SessionStore, SessionStoreShape>()(
  "@runbooks/core/engine/SessionStore",
) {
  static readonly layer: Layer.Layer<SessionStore, never, SessionDatabase | SessionCipher> =
    Layer.effect(SessionStore, make)
}

/**
 * A session store that keeps nothing: every session is new, and none
 * outlives the engine. `runbooks test` runs on it, so no test resumes a
 * session or leaves one for the app to resume.
 */
export const NoSavedSessions: Layer.Layer<SessionStore> = Layer.succeed(SessionStore, {
  latest: () => Effect.succeed(Option.none()),
  keep: () =>
    Effect.succeed({
      put: () => Effect.void,
      drop: () => Effect.void,
      trust: () => Effect.void,
      close: () => Effect.void,
    }),
  expired: Effect.succeed([]),
  forget: () => Effect.void,
})
