/**
 * Opens a SQLite database with the `node:sqlite` module built into Electron's
 * Node, so the app ships no native SQLite addon.
 *
 * `bun test` runs this over Bun's own implementation of `node:sqlite`.
 * test/integration/session-sqlite.test.ts runs it over Node's, the one
 * Electron ships.
 */
import type { SqlDatabase } from "../domain/session/store.ts"

/** Open the database file at `file`, creating it if missing. `:memory:` opens one that is never written to disk. */
export function openSqliteDatabase(file: string): SqlDatabase {
  const { DatabaseSync } = loadSqlite()
  const db = new DatabaseSync(file)
  return {
    exec: (sql) => {
      db.exec(sql)
    },
    prepare: (sql) => {
      const statement = db.prepare(sql)
      return {
        run: (...params) => {
          statement.run(...params)
        },
        get: (...params) => statement.get(...params),
        all: (...params) => statement.all(...params),
      }
    },
    close: () => {
      db.close()
    },
  }
}

/**
 * Load `node:sqlite` without the "SQLite is an experimental feature" warning
 * that Electron 41's Node (24.14) prints to the terminal the first time the
 * module loads. The app runs on the Node its Electron bundles, so the API
 * can't change under it. Node 24.21 has stopped emitting the warning, and
 * this filter then drops nothing.
 *
 * A static import would load the module, and print the warning, before any
 * code here could run.
 */
function loadSqlite(): typeof import("node:sqlite") {
  const emitWarning = process.emitWarning.bind(process) as typeof process.emitWarning
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (rest[0] === "ExperimentalWarning" && String(warning).includes("SQLite")) return
    ;(emitWarning as (...args: unknown[]) => void)(warning, ...rest)
  }) as typeof process.emitWarning
  try {
    return process.getBuiltinModule("node:sqlite")
  } finally {
    process.emitWarning = emitWarning
  }
}
