import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as nodeFs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Effect, Option } from "effect"
import { SessionDatabase, type SessionRow } from "@runbooks/core/services/SessionDatabase"
import { sessionDatabaseContract } from "@runbooks/core/test-utils/sessionDatabaseContract"
import { nodeSessionDatabase, SESSIONS_APPLICATION_ID } from "./NodeSessionDatabase.ts"

const tempRoot = () =>
  nodeFs.realpathSync(nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "runbooks-sessions-")))

sessionDatabaseContract("SQLite", async () => {
  const root = tempRoot()
  return {
    layer: nodeSessionDatabase(root),
    release: async () => nodeFs.rmSync(root, { recursive: true, force: true }),
  }
})

let root = ""
/** The data folder the entry point would pass: missing until the database opens. */
let data = ""
let file = ""

beforeEach(() => {
  root = tempRoot()
  data = nodePath.join(root, "data")
  file = nodePath.join(data, "sessions.db")
})

afterEach(() => {
  nodeFs.rmSync(root, { recursive: true, force: true })
})

const run = <A, E>(use: (db: SessionDatabase["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* use(yield* SessionDatabase)
    }).pipe(Effect.provide(nodeSessionDatabase(data))),
  )

const modeOf = (at: string) => nodeFs.statSync(at).mode & 0o777

const session: SessionRow = {
  id: "s1",
  runbook: "/rb/a.mdx",
  createdAt: 1,
  usedAt: 2,
  trusted: Option.none(),
}

describe("the sessions database file", () => {
  it("keeps what was saved after it is closed and opened again", async () => {
    await run((db) => db.putSession(session))
    expect(await run((db) => db.latest("/rb/a.mdx"))).toEqual(Option.some(session))
  })

  it("is readable and writable by its owner only, with its journal, in a folder only its owner opens", async () => {
    const umask = process.umask(0o022)
    try {
      await run((db) =>
        Effect.gen(function* () {
          yield* db.putSession(session)
          // While it is open, SQLite's write-ahead log sits beside it.
          expect(modeOf(`${file}-wal`)).toBe(0o600)
        }),
      )
    } finally {
      process.umask(umask)
    }
    expect(modeOf(file)).toBe(0o600)
    expect(modeOf(data)).toBe(0o700)
  })

  it("leaves a database a newer Runbooks wrote as it is, and keeps this run's sessions in memory", async () => {
    nodeFs.mkdirSync(data)
    const newer = new DatabaseSync(file)
    newer.exec(
      `CREATE TABLE future (x TEXT); PRAGMA application_id = ${SESSIONS_APPLICATION_ID}; PRAGMA user_version = 99`,
    )
    newer.close()
    const before = nodeFs.readFileSync(file)

    await run((db) => db.putSession(session))
    expect(nodeFs.readFileSync(file)).toEqual(before)
    expect(Option.isNone(await run((db) => db.latest("/rb/a.mdx")))).toBe(true)
  })

  it("leaves a database it did not make as it is, as today's app's sessions.db, and keeps this run's sessions in memory", async () => {
    nodeFs.mkdirSync(data)
    // Today's app's schema, at its version 1 (src/domain/session/store.ts), in part.
    const today = new DatabaseSync(file)
    today.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, runbook_path TEXT NOT NULL) STRICT;
      CREATE TABLE session_events (
        seq INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
        block_id TEXT NOT NULL, kind TEXT NOT NULL, payload BLOB NOT NULL
      ) STRICT;
      INSERT INTO sessions VALUES ('s1', 'brave-otter', '/rb/a.mdx');
      PRAGMA user_version = 1;`)
    today.close()
    const before = nodeFs.readFileSync(file)

    expect(
      await run((db) => Effect.andThen(db.putSession(session), db.latest("/rb/a.mdx"))),
    ).toEqual(Option.some(session))
    expect(nodeFs.readFileSync(file)).toEqual(before)
  })

  it("marks a database it makes as its own", async () => {
    await run((db) => db.putSession(session))
    const made = new DatabaseSync(file, { readOnly: true })
    try {
      expect(made.prepare("PRAGMA application_id").get()).toEqual({
        application_id: SESSIONS_APPLICATION_ID,
      })
    } finally {
      made.close()
    }
  })

  it("leaves a file that is not a database as it is, and keeps this run's sessions in memory", async () => {
    nodeFs.mkdirSync(data)
    nodeFs.writeFileSync(file, "not a database, ".repeat(512))
    const before = nodeFs.readFileSync(file)

    expect(
      await run((db) => Effect.andThen(db.putSession(session), db.latest("/rb/a.mdx"))),
    ).toEqual(Option.some(session))
    expect(nodeFs.readFileSync(file)).toEqual(before)
  })
})
