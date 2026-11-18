/**
 * IPC handler for the <SQLite> block. Validates the database path against
 * the session (path-guard), opens it with the node:sqlite layer, and runs
 * the query through the domain (src/domain/sqlite/query.ts).
 *
 * The query comes either inline (`sql`) or from a .sql file (`sqlPath`,
 * also path-guarded and read here — the renderer never reads files).
 */
import { readFileSync } from "node:fs"
import { Effect } from "effect"
import { ipcMain } from "electron"
import { runtime } from "./runtime.ts"
import { validateSessionPath } from "./path-guard.ts"
import { openSqliteDatabase } from "../../../src/layers/NodeSqlite.ts"
import { runQuery, runSqlScript } from "../../../src/domain/sqlite/query.ts"
import type { SqlParam, SqlQueryResult } from "../../../src/domain/sqlite/result.ts"
import type { IpcChannelMap } from "../../shared/channels.ts"

interface SqliteQueryRequest {
  dbPath: string
  sql?: string
  sqlPath?: string
  params?: SqlParam[]
}

export function registerSqliteHandlers(): void {
  ipcMain.handle("sqlite:query", async (_event, req: SqliteQueryRequest) => {
    return runtime.runPromise(
      Effect.gen(function* () {
        // `:memory:` is always allowed; file paths must stay in the session.
        const dbPath =
          req.dbPath === ":memory:" ? ":memory:" : yield* validateSessionPath(req.dbPath)

        // A .sql file is executed as a script (multi-statement); an inline
        // query runs as a single statement and may return rows.
        let result: SqlQueryResult
        const db = openSqliteDatabase(dbPath)
        try {
          if (req.sqlPath) {
            const sqlPath = yield* validateSessionPath(req.sqlPath)
            const sql = yield* Effect.try({
              try: () => readFileSync(sqlPath, "utf8"),
              catch: (err) =>
                new Error(
                  `cannot read SQL file ${req.sqlPath}: ${err instanceof Error ? err.message : String(err)}`,
                ),
            })
            result = yield* runSqlScript(db, sql)
          } else {
            result = yield* runQuery(db, req.sql ?? "", req.params ?? [])
          }
        } finally {
          db.close()
        }
        return result satisfies IpcChannelMap["sqlite:query"]["result"]
      }),
    )
  })
}
