/**
 * Opens a SQLite database with the `node:sqlite` module built into Electron's
 * Node, so the app ships no native SQLite addon.
 *
 * `bun test` runs this over Bun's own implementation of `node:sqlite`.
 * test/integration/session-sqlite.test.ts runs it over Node's, the one
 * Electron ships.
 */
import { DatabaseSync } from "node:sqlite"
import type { SqlDatabase } from "../domain/session/store.ts"

/** Open the database file at `file`, creating it if missing. `:memory:` opens one that is never written to disk. */
export function openSqliteDatabase(file: string): SqlDatabase {
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
