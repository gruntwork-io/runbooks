import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as nodeFs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Effect, Logger, Option } from "effect"
import { SessionDatabase, type SessionRow } from "@runbooks/core/services/SessionDatabase"
import { sessionDatabaseContract } from "@runbooks/core/test-utils/sessionDatabaseContract"
import { MIGRATIONS, nodeSessionDatabase, SESSIONS_APPLICATION_ID } from "./NodeSessionDatabase.ts"

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

/** As `run`, and every warning the layer and `use` logged: a database that can't be used says why in one. */
const runWarned = async <A, E>(use: (db: SessionDatabase["Service"]) => Effect.Effect<A, E>) => {
  const warnings: string[] = []
  const logger = Logger.make(({ logLevel, message }) => {
    if (logLevel === "Warn")
      warnings.push(Array.isArray(message) ? message.join(" ") : String(message))
  })
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* use(yield* SessionDatabase)
    }).pipe(Effect.provide(nodeSessionDatabase(data)), Effect.provide(Logger.layer([logger]))),
  )
  return { result, warnings }
}

const modeOf = (at: string) => nodeFs.statSync(at).mode & 0o777

const session: SessionRow = {
  id: "s1",
  runbook: "/rb/a.mdx",
  createdAt: 1,
  usedAt: 2,
  trusted: Option.none(),
  nextSequence: 0,
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

/**
 * How long the other writer holds its lock once it says so. Short of the
 * layer's 1-second busy timeout by enough that its commit lands in time on a
 * loaded machine, and long enough that the open starts while it is held.
 */
const HOLD_MILLIS = 75

/**
 * Another process holding `file`'s write lock for `millis`, as a second
 * Runbooks saving would: it runs `inside` in the transaction, then waits.
 * `node:sqlite` blocks its thread while it waits for a lock, so the holder
 * cannot be this process. Resolves once the lock is held.
 */
async function anotherWriter(at: string, millis: number, inside: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { DatabaseSync } = require("node:sqlite")
       const db = new DatabaseSync(process.env.DB_FILE)
       db.exec("BEGIN IMMEDIATE")
       db.exec(process.env.INSIDE)
       console.log("held")
       setTimeout(() => { db.exec("COMMIT"); db.close() }, ${millis})`,
    ],
    { env: { ...process.env, DB_FILE: at, INSIDE: inside }, stdout: "pipe" },
  )
  const reader = child.stdout.getReader()
  let said = ""
  while (!said.includes("held")) {
    const { value, done } = await reader.read()
    if (done) throw new Error(`the other writer ended first: ${said}`)
    said += new TextDecoder().decode(value)
  }
  reader.releaseLock()
  return child
}

/** The sessions a plain connection finds in the file. */
const inFile = (at: string) => {
  const reader = new DatabaseSync(at, { readOnly: true })
  try {
    return reader.prepare("SELECT id FROM sessions").all()
  } finally {
    reader.close()
  }
}

describe("the sessions database with a second Runbooks", () => {
  it("waits for the other one's write, rather than drop the save", async () => {
    await run((db) => db.putSession(session))
    const other = await anotherWriter(file, HOLD_MILLIS, "SELECT 1")
    const { warnings } = await runWarned((db) => db.putSession({ ...session, usedAt: 3 }))
    await other.exited
    expect(warnings).toEqual([])
    expect(await run((db) => db.latest("/rb/a.mdx"))).toEqual(
      Option.some({ ...session, usedAt: 3 }),
    )
  })

  it("opens a new database the other one is making at that moment, and saves into it", async () => {
    nodeFs.mkdirSync(data)
    const other = await anotherWriter(
      file,
      HOLD_MILLIS,
      `PRAGMA application_id = ${SESSIONS_APPLICATION_ID}; ${MIGRATIONS[0]} PRAGMA user_version = 1;`,
    )
    const { warnings } = await runWarned((db) => db.putSession(session))
    await other.exited
    expect(warnings).toEqual([])
    expect(inFile(file)).toEqual([{ id: "s1" }])
  })

  it("switches a database the other one made to WAL once the other's write ends", async () => {
    nodeFs.mkdirSync(data)
    // Made, and not yet in WAL mode: the other one is between its migration and its switch.
    const made = new DatabaseSync(file)
    made.exec(
      `PRAGMA application_id = ${SESSIONS_APPLICATION_ID}; ${MIGRATIONS[0]} PRAGMA user_version = 1;`,
    )
    made.close()
    const other = await anotherWriter(file, HOLD_MILLIS, "SELECT 1")
    const { warnings } = await runWarned((db) => db.putSession(session))
    await other.exited
    expect(warnings).toEqual([])
    expect(inFile(file)).toEqual([{ id: "s1" }])
  })
})

describe("a sessions database that is damaged", () => {
  /**
   * This layer's database, holding more sessions than its first pages do,
   * closed with every page in the file, none left in its write-ahead log.
   */
  async function made() {
    await run((db) => db.putSession(session))
    const filler = new DatabaseSync(file)
    const insert = filler.prepare(
      "INSERT INTO sessions (id, runbook, created_at, used_at, trusted, next_sequence) VALUES (?, ?, 1, 1, NULL, 0)",
    )
    for (let i = 0; i < 300; i++) insert.run(`filler-${i}`, `/rb/filler-${i}.mdx`.repeat(8))
    filler.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    filler.close()
  }

  const damages: ReadonlyArray<readonly [string, () => void]> = [
    ["cut short", () => nodeFs.truncateSync(file, 2 * 4096)],
    [
      // Page 2 is the root of the sessions table, the first table the schema makes.
      "with a page overwritten",
      () => {
        const handle = nodeFs.openSync(file, "r+")
        nodeFs.writeSync(handle, Buffer.alloc(4096), 0, 4096, 4096)
        nodeFs.closeSync(handle)
      },
    ],
  ]

  for (const [how, damage] of damages)
    it(`leaves one ${how} as it is, and keeps this run's sessions in memory`, async () => {
      await made()
      damage()
      const before = nodeFs.readFileSync(file)

      const saved = { ...session, id: "s2", runbook: "/rb/b.mdx" }
      expect(
        await run((db) => Effect.andThen(db.putSession(saved), db.latest("/rb/b.mdx"))),
      ).toEqual(Option.some(saved))
      expect(nodeFs.readFileSync(file)).toEqual(before)
    })
})
