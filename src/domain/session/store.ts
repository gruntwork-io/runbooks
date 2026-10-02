/**
 * The sessions database: one row per session, kept across app restarts.
 *
 * The store speaks SQL through SqlDatabase, the part of a synchronous SQLite
 * binding it needs. The app passes Electron's `node:sqlite`
 * (electron/main/sqlite.ts); `bun test` has no `node:sqlite`, so tests pass
 * `bun:sqlite` (src/test-utils/bunSqlite.ts).
 */
import { Effect } from "effect"
import { SessionStoreError } from "../../errors/index.ts"

/** A value bound to a `?` placeholder. */
export type SqlValue = string | number | null | Uint8Array

export interface SqlStatement {
  run(...params: SqlValue[]): void
  /** The first row, or undefined or null when there is none. */
  get(...params: SqlValue[]): unknown
  all(...params: SqlValue[]): unknown[]
}

export interface SqlDatabase {
  exec(sql: string): void
  prepare(sql: string): SqlStatement
  close(): void
}

/** The runbook a session belongs to. */
export interface RunbookSource {
  /** The runbook file. For a remote runbook, where its latest clone put it. */
  path: string
  /** The URL the runbook was opened from. A remote runbook is identified by it, since every clone lands in a new folder. */
  remoteSource: string | undefined
}

/** A session's state that changes while its runbook is open. */
export interface StoredSessionState {
  workingDir: string
  /** The session env's changes since it started, encrypted. Undefined when they could not be encrypted. */
  env: Uint8Array | undefined
  /** The git checkouts the session's GitClone blocks registered, oldest first. */
  worktrees: string[]
  /** The checkout the user selected, or "" for the last registered one. */
  activeWorktree: string
  executionCount: number
  lastActivityAt: string
}

export interface SessionRecord extends StoredSessionState, RunbookSource {
  id: string
  /** The session's own directory, where its scripts start and its files are written. */
  dir: string
  /** The directory `runbooks` was last run from to start this session. */
  launchDir: string | undefined
  createdAt: string
  lastLaunchedAt: string
}

/** A `sessions` row. Both tables are STRICT, so each column has its declared type. */
interface SessionRow {
  id: string
  runbook_path: string
  remote_source: string | null
  dir: string
  working_dir: string
  launch_dir: string | null
  env: Uint8Array | null
  active_worktree: string
  execution_count: number
  created_at: string
  last_launched_at: string
  last_activity_at: string
}

const MIGRATIONS = [
  `CREATE TABLE sessions (
     id TEXT PRIMARY KEY,
     runbook_path TEXT NOT NULL,
     remote_source TEXT,
     dir TEXT NOT NULL,
     working_dir TEXT NOT NULL,
     launch_dir TEXT,
     env BLOB,
     active_worktree TEXT NOT NULL,
     execution_count INTEGER NOT NULL,
     created_at TEXT NOT NULL,
     last_launched_at TEXT NOT NULL,
     last_activity_at TEXT NOT NULL
   ) STRICT;
   CREATE TABLE session_worktrees (
     session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
     position INTEGER NOT NULL,
     path TEXT NOT NULL,
     PRIMARY KEY (session_id, position)
   ) STRICT;`,
]

// Timestamps are ISO 8601 in UTC, so they sort as text. rowid breaks a tie
// between two sessions launched in the same millisecond.
const MOST_RECENT_FIRST = "ORDER BY last_launched_at DESC, rowid DESC LIMIT 1"

export class SessionStore {
  private constructor(private readonly db: SqlDatabase) {}

  /** Wrap `db`, creating or upgrading its schema. */
  static open(db: SqlDatabase): Effect.Effect<SessionStore, SessionStoreError> {
    return attempt("open the sessions database", () => {
      db.exec("PRAGMA journal_mode = WAL")
      db.exec("PRAGMA foreign_keys = ON")
      const { user_version: version } = db.prepare("PRAGMA user_version").get() as {
        user_version: number
      }
      if (version > MIGRATIONS.length) {
        throw new Error(
          `the database has schema version ${version}, newer than this version of Runbooks supports (${MIGRATIONS.length})`,
        )
      }
      MIGRATIONS.slice(version).forEach((migration, i) => {
        transaction(db, () => {
          db.exec(migration)
          db.exec(`PRAGMA user_version = ${version + i + 1}`)
        })
      })
      return new SessionStore(db)
    })
  }

  insert(record: SessionRecord): Effect.Effect<void, SessionStoreError> {
    return attempt("save a new session", () => {
      transaction(this.db, () => {
        this.db
          .prepare(
            `INSERT INTO sessions (
               id, runbook_path, remote_source, dir, working_dir, launch_dir, env,
               active_worktree, execution_count, created_at, last_launched_at, last_activity_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            record.id,
            record.path,
            record.remoteSource ?? null,
            record.dir,
            record.workingDir,
            record.launchDir ?? null,
            record.env ?? null,
            record.activeWorktree,
            record.executionCount,
            record.createdAt,
            record.lastLaunchedAt,
            record.lastActivityAt,
          )
        this.replaceWorktrees(record.id, record.worktrees)
      })
    })
  }

  get(id: string): Effect.Effect<SessionRecord | undefined, SessionStoreError> {
    return this.selectOne("WHERE id = ?", [id])
  }

  /** The most recently launched session of `runbook`. */
  latestForRunbook(
    runbook: RunbookSource,
  ): Effect.Effect<SessionRecord | undefined, SessionStoreError> {
    return runbook.remoteSource === undefined
      ? this.selectOne(`WHERE remote_source IS NULL AND runbook_path = ? ${MOST_RECENT_FIRST}`, [
          runbook.path,
        ])
      : this.selectOne(`WHERE remote_source = ? ${MOST_RECENT_FIRST}`, [runbook.remoteSource])
  }

  /** The session most recently launched from `launchDir`. */
  latestForLaunchDir(
    launchDir: string,
  ): Effect.Effect<SessionRecord | undefined, SessionStoreError> {
    return this.selectOne(`WHERE launch_dir = ? ${MOST_RECENT_FIRST}`, [launchDir])
  }

  /** The most recently launched session. */
  latest(): Effect.Effect<SessionRecord | undefined, SessionStoreError> {
    return this.selectOne(MOST_RECENT_FIRST, [])
  }

  /**
   * Record that the session was launched at `at` for the runbook file at
   * `runbookPath`. An undefined `launchDir` (a launch from the file dialog or
   * the dock) keeps the directory of the last launch that had one.
   */
  markLaunched(
    id: string,
    launch: { at: string; runbookPath: string; launchDir: string | undefined },
  ): Effect.Effect<void, SessionStoreError> {
    return attempt("record a session launch", () => {
      this.db
        .prepare(
          `UPDATE sessions
              SET last_launched_at = ?, runbook_path = ?, launch_dir = COALESCE(?, launch_dir)
            WHERE id = ?`,
        )
        .run(launch.at, launch.runbookPath, launch.launchDir ?? null, id)
    })
  }

  saveState(id: string, state: StoredSessionState): Effect.Effect<void, SessionStoreError> {
    return attempt("save a session", () => {
      transaction(this.db, () => {
        this.db
          .prepare(
            `UPDATE sessions
                SET working_dir = ?, env = ?, active_worktree = ?, execution_count = ?,
                    last_activity_at = ?
              WHERE id = ?`,
          )
          .run(
            state.workingDir,
            state.env ?? null,
            state.activeWorktree,
            state.executionCount,
            state.lastActivityAt,
            id,
          )
        this.replaceWorktrees(id, state.worktrees)
      })
    })
  }

  close(): Effect.Effect<void, SessionStoreError> {
    return attempt("close the sessions database", () => {
      this.db.close()
    })
  }

  private replaceWorktrees(id: string, worktrees: string[]): void {
    this.db.prepare("DELETE FROM session_worktrees WHERE session_id = ?").run(id)
    const insert = this.db.prepare(
      "INSERT INTO session_worktrees (session_id, position, path) VALUES (?, ?, ?)",
    )
    worktrees.forEach((worktree, position) => {
      insert.run(id, position, worktree)
    })
  }

  private selectOne(
    clause: string,
    params: SqlValue[],
  ): Effect.Effect<SessionRecord | undefined, SessionStoreError> {
    return attempt("read a session", () => {
      const row = this.db.prepare(`SELECT * FROM sessions ${clause}`).get(...params) as
        | SessionRow
        | null
        | undefined
      if (row === null || row === undefined) return undefined
      const worktrees = this.db
        .prepare("SELECT path FROM session_worktrees WHERE session_id = ? ORDER BY position")
        .all(row.id) as Array<{ path: string }>
      return {
        id: row.id,
        path: row.runbook_path,
        remoteSource: row.remote_source ?? undefined,
        dir: row.dir,
        workingDir: row.working_dir,
        launchDir: row.launch_dir ?? undefined,
        env: row.env ?? undefined,
        worktrees: worktrees.map((w) => w.path),
        activeWorktree: row.active_worktree,
        executionCount: row.execution_count,
        createdAt: row.created_at,
        lastLaunchedAt: row.last_launched_at,
        lastActivityAt: row.last_activity_at,
      }
    })
  }
}

function attempt<A>(action: string, run: () => A): Effect.Effect<A, SessionStoreError> {
  return Effect.try({
    try: run,
    catch: (cause) =>
      new SessionStoreError({
        message: `failed to ${action}: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      }),
  })
}

function transaction(db: SqlDatabase, run: () => void): void {
  db.exec("BEGIN IMMEDIATE")
  try {
    run()
    db.exec("COMMIT")
  } catch (err) {
    db.exec("ROLLBACK")
    throw err
  }
}
