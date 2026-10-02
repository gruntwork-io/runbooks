import { Database } from "bun:sqlite"
import type { SqlDatabase } from "../domain/session/store.ts"

/**
 * A SQLite database for tests that run under `bun test`, which has no
 * `node:sqlite` (the binding the app uses, electron/main/sqlite.ts).
 * `file` defaults to a database kept in memory.
 */
export function openBunSqlite(file = ":memory:"): SqlDatabase {
  const db = new Database(file)
  return {
    exec: (sql) => {
      db.run(sql)
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
