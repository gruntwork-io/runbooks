/**
 * The sessions database on disk: `sessions.db` in the app's data folder,
 * which the entry point passes in. It is opened with the `node:sqlite`
 * module built into Electron's Node, as today's app does, so the app ships
 * no native SQLite addon; `bun test` runs Bun's implementation of the same
 * module.
 *
 * The file is created readable and writable by its owner only before SQLite
 * opens it, and SQLite gives its journal files the file's mode. A missing
 * data folder is created for its owner only.
 *
 * A file this version cannot use is left as it is: one that is not a
 * database, one this layer did not make (today's app's `sessions.db` has a
 * schema version too), or one a newer version's schema. This run's sessions
 * are then kept in memory and forgotten at quit, so runbooks still open, as
 * in today's app.
 */
import { constants } from "node:fs"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { Effect, Layer, Option, Schema } from "effect"
import { SessionDatabaseError } from "@runbooks/core/errors"
import {
  type EventRow,
  MAX_SESSION_EVENTS,
  SessionDatabase,
  type SessionRow,
} from "@runbooks/core/services/SessionDatabase"

/**
 * Marks a database as this layer's, in the header SQLite keeps for it
 * (`PRAGMA application_id`): "RBSS". A database with a schema version and
 * another mark is not one this layer made.
 */
export const SESSIONS_APPLICATION_ID = 0x52_42_53_53

const OWNER_ONLY_FILE = 0o600
const OWNER_ONLY_FOLDER = 0o700

/** Each step brings the schema up one version. `PRAGMA user_version` counts the steps taken. */
const MIGRATIONS = [
  `CREATE TABLE sessions (
     id TEXT PRIMARY KEY,
     runbook TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     used_at INTEGER NOT NULL,
     trusted TEXT,
     next_sequence INTEGER NOT NULL
   ) STRICT;
   CREATE INDEX sessions_by_runbook ON sessions (runbook, used_at);
   CREATE TABLE events (
     session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
     block TEXT NOT NULL,
     kind TEXT NOT NULL,
     version INTEGER NOT NULL,
     at INTEGER NOT NULL,
     runbook_hash TEXT NOT NULL,
     file_hashes TEXT NOT NULL,
     payload BLOB NOT NULL,
     PRIMARY KEY (session_id, block, kind)
   ) STRICT;`,
]

const SessionRecord = Schema.Struct({
  id: Schema.String,
  runbook: Schema.String,
  created_at: Schema.Number,
  used_at: Schema.Number,
  trusted: Schema.NullOr(Schema.String),
  next_sequence: Schema.Number,
})

const EventRecord = Schema.Struct({
  session_id: Schema.String,
  block: Schema.String,
  kind: Schema.String,
  version: Schema.Number,
  at: Schema.Number,
  runbook_hash: Schema.String,
  file_hashes: Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
  payload: Schema.Uint8Array,
})

const UserVersion = Schema.Struct({ user_version: Schema.Number })
const ApplicationId = Schema.Struct({ application_id: Schema.Number })
const Id = Schema.Struct({ id: Schema.String })

const decodeSession = Schema.decodeUnknownSync(SessionRecord)
const decodeEvent = Schema.decodeUnknownSync(EventRecord)
const decodeUserVersion = Schema.decodeUnknownSync(UserVersion)
const decodeApplicationId = Schema.decodeUnknownSync(ApplicationId)
const decodeId = Schema.decodeUnknownSync(Id)

const toSessionRow = (row: unknown): SessionRow => {
  const record = decodeSession(row)
  return {
    id: record.id,
    runbook: record.runbook,
    createdAt: record.created_at,
    usedAt: record.used_at,
    trusted: Option.fromNullOr(record.trusted),
    nextSequence: record.next_sequence,
  }
}

const toEventRow = (row: unknown): EventRow => {
  const record = decodeEvent(row)
  return {
    session: record.session_id,
    block: record.block,
    kind: record.kind,
    version: record.version,
    at: record.at,
    runbookHash: record.runbook_hash,
    fileHashes: record.file_hashes,
    payload: record.payload,
  }
}

/**
 * Brings `db`'s schema up to this version's, each step in a transaction.
 * It reads the version and the mark before it writes anything, so a newer
 * version's database, or another program's, is left as it is.
 */
function migrate(db: DatabaseSync): void {
  const { user_version: version } = decodeUserVersion(db.prepare("PRAGMA user_version").get())
  const { application_id: mark } = decodeApplicationId(db.prepare("PRAGMA application_id").get())
  if (version > 0 && mark !== SESSIONS_APPLICATION_ID)
    throw new Error(
      `It is not a sessions database this Runbooks made: its schema version is ${version}, with application id ${mark}. Today's app's sessions.db is one.`,
    )
  if (version > MIGRATIONS.length)
    throw new Error(
      `A newer Runbooks wrote it, with schema version ${version}; this one reads up to ${MIGRATIONS.length}.`,
    )
  db.exec("PRAGMA foreign_keys = ON")
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA synchronous = NORMAL")
  for (const [step, migration] of MIGRATIONS.entries()) {
    if (step < version) continue
    transaction(db, () => {
      if (step === 0) db.exec(`PRAGMA application_id = ${SESSIONS_APPLICATION_ID}`)
      db.exec(migration)
      db.exec(`PRAGMA user_version = ${step + 1}`)
    })
  }
}

function transaction(db: DatabaseSync, run: () => void): void {
  db.exec("BEGIN IMMEDIATE")
  try {
    run()
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

/** Creates the file, owner only, if there is none, so SQLite never creates it with the process's default mode. */
async function createOwnerOnly(file: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: OWNER_ONLY_FOLDER })
  try {
    const handle = await fs.open(
      file,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      OWNER_ONLY_FILE,
    )
    await handle.close()
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
  }
}

/** The database file at `file`, migrated; or, if it cannot be used, one in memory, and why. */
async function openDatabase(
  file: string,
): Promise<{ readonly db: DatabaseSync; readonly unusable: Option.Option<string> }> {
  let db: DatabaseSync | undefined
  try {
    await createOwnerOnly(file)
    db = new DatabaseSync(file)
    migrate(db)
    return { db, unusable: Option.none() }
  } catch (error) {
    db?.close()
    const memory = new DatabaseSync(":memory:")
    migrate(memory)
    return {
      db: memory,
      unusable: Option.some(error instanceof Error ? error.message : String(error)),
    }
  }
}

/** The sessions database in `dataFolder`. */
export const nodeSessionDatabase = (dataFolder: string): Layer.Layer<SessionDatabase> =>
  Layer.effect(
    SessionDatabase,
    Effect.gen(function* () {
      const file = path.join(dataFolder, "sessions.db")
      const { db, unusable } = yield* Effect.acquireRelease(
        Effect.promise(() => openDatabase(file)),
        ({ db: opened }) => Effect.sync(() => opened.close()),
      )
      if (Option.isSome(unusable))
        yield* Effect.logWarning(
          `The sessions database ${file} cannot be used, so sessions are not kept after this run: ${unusable.value}`,
        )

      const attempt = <A>(action: string, run: () => A) =>
        Effect.try({ try: run, catch: (cause) => new SessionDatabaseError({ action, cause }) })
      const all = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).all(...params)
      const run = (sql: string, ...params: SQLInputValue[]) => {
        db.prepare(sql).run(...params)
      }

      return SessionDatabase.of({
        latest: (runbook) =>
          attempt("find a runbook's session", () =>
            Option.map(
              Option.fromUndefinedOr(
                db
                  .prepare(
                    "SELECT * FROM sessions WHERE runbook = ? ORDER BY used_at DESC, rowid DESC LIMIT 1",
                  )
                  .get(runbook),
              ),
              toSessionRow,
            ),
          ),

        putSession: (row) =>
          attempt("save a session", () =>
            run(
              `INSERT INTO sessions (id, runbook, created_at, used_at, trusted, next_sequence)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT (id) DO UPDATE SET runbook = excluded.runbook, created_at = excluded.created_at,
                 used_at = excluded.used_at, trusted = excluded.trusted,
                 next_sequence = excluded.next_sequence`,
              row.id,
              row.runbook,
              row.createdAt,
              row.usedAt,
              Option.getOrNull(row.trusted),
              row.nextSequence,
            ),
          ),

        events: (session) =>
          attempt("read a session's events", () =>
            all(
              "SELECT * FROM events WHERE session_id = ? ORDER BY rowid LIMIT ?",
              session,
              MAX_SESSION_EVENTS,
            ).map(toEventRow),
          ),

        putEvent: (row) =>
          attempt("save a session event", () =>
            run(
              `INSERT INTO events (session_id, block, kind, version, at, runbook_hash, file_hashes, payload)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (session_id, block, kind) DO UPDATE SET version = excluded.version,
                 at = excluded.at, runbook_hash = excluded.runbook_hash,
                 file_hashes = excluded.file_hashes, payload = excluded.payload`,
              row.session,
              row.block,
              row.kind,
              row.version,
              row.at,
              row.runbookHash,
              JSON.stringify(row.fileHashes),
              row.payload,
            ),
          ),

        deleteEvent: (session, block, kind) =>
          attempt("delete a session event", () =>
            run(
              "DELETE FROM events WHERE session_id = ? AND block = ? AND kind = ?",
              session,
              block,
              kind,
            ),
          ),

        expired: ({ before, keep, limit }) =>
          attempt("find the sessions retention drops", () =>
            all(
              `SELECT id FROM (
                 SELECT id, used_at, rowid AS place,
                   ROW_NUMBER() OVER (ORDER BY used_at DESC, rowid DESC) AS rank
                 FROM sessions)
               WHERE used_at < ? OR rank > ?
               ORDER BY used_at, place LIMIT ?`,
              before,
              keep,
              limit,
            ).map((row) => decodeId(row).id),
          ),

        deleteSession: (id) =>
          attempt("delete a session", () => run("DELETE FROM sessions WHERE id = ?", id)),
      })
    }),
  )
