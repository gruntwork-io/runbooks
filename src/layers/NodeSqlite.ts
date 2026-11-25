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
          const info = statement.run(...params)
          return {
            changes: Number(info.changes),
            lastInsertRowid:
              typeof info.lastInsertRowid === "bigint"
                ? Number(info.lastInsertRowid)
                : info.lastInsertRowid,
          }
        },
        get: (...params) => statement.get(...params),
        all: (...params) => statement.all(...params),
        columns: () => statement.columns().map((c) => ({ name: c.name })),
        // Present on Node 22.16+ and Bun; lets the domain read rows
        // positionally so duplicate column names keep each value.
        ...(typeof statement.setReturnArrays === "function"
          ? { setReturnArrays: (arrays: boolean) => statement.setReturnArrays(arrays) }
          : {}),
      }
    },
    close: () => {
      db.close()
    },
  }
}
