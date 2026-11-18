import { describe, it, expect } from "bun:test"
import { Effect } from "effect"
import { openSqliteDatabase } from "../../layers/NodeSqlite.ts"
import { runQuery, runSqlScript } from "./query.ts"
import { SqliteQueryError } from "../../errors/index.ts"

const run = Effect.runPromise

async function withDb<T>(f: (db: ReturnType<typeof openSqliteDatabase>) => Promise<T>): Promise<T> {
  const db = openSqliteDatabase(":memory:")
  try {
    return await f(db)
  } finally {
    db.close()
  }
}

describe("runQuery", () => {
  it("runs CREATE TABLE and reports 0 affected rows, not a read", async () => {
    await withDb(async (db) => {
      const result = await run(
        runQuery(db, "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)"),
      )
      expect(result.isRead).toBe(false)
      expect(result.columns).toEqual([])
      expect(result.rows).toEqual([])
      expect(result.rowCount).toBe(0)
    })
  })

  it("runs INSERT with bound params and reports 1 affected row", async () => {
    await withDb(async (db) => {
      await run(runQuery(db, "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)"))
      const result = await run(runQuery(db, "INSERT INTO users (name) VALUES (?)", ["Alice"]))
      expect(result.isRead).toBe(false)
      expect(result.rowCount).toBe(1)
    })
  })

  it("binds boolean params as 1/0", async () => {
    await withDb(async (db) => {
      await run(runQuery(db, "CREATE TABLE flags (id INTEGER PRIMARY KEY, active INTEGER)"))
      await run(runQuery(db, "INSERT INTO flags (active) VALUES (?)", [true]))
      const result = await run(runQuery(db, "SELECT active FROM flags"))
      expect(result.rows).toEqual([[1]])
    })
  })

  it("returns columns and rows for SELECT", async () => {
    await withDb(async (db) => {
      await run(runQuery(db, "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)"))
      await run(
        runQuery(db, "INSERT INTO users (name, email) VALUES (?, ?)", [
          "Alice",
          "alice@example.com",
        ]),
      )
      await run(runQuery(db, "INSERT INTO users (name, email) VALUES (?, ?)", ["Bob", null]))
      const result = await run(runQuery(db, "SELECT id, name, email FROM users ORDER BY id"))
      expect(result.isRead).toBe(true)
      expect(result.columns).toEqual(["id", "name", "email"])
      expect(result.rows).toEqual([
        [1, "Alice", "alice@example.com"],
        [2, "Bob", null],
      ])
      expect(result.rowCount).toBe(2)
    })
  })

  it("deduplicates column names in the header for duplicate aliases", async () => {
    await withDb(async (db) => {
      const result = await run(runQuery(db, "SELECT 1 AS a, 2 AS a, 3 AS b"))
      expect(result.columns).toEqual(["a", "a_2", "b"])
    })
  })

  it("never lets a generated alias collide with an existing column name", async () => {
    await withDb(async (db) => {
      const result = await run(runQuery(db, "SELECT 1 AS a, 2 AS a, 3 AS a_2"))
      // The duplicate "a" can't take "a_2" (reserved by the third column), so it becomes "a_2_".
      expect(result.columns).toEqual(["a", "a_2_", "a_2"])
    })
  })

  it("returns empty rows for a SELECT that matches nothing", async () => {
    await withDb(async (db) => {
      await run(runQuery(db, "CREATE TABLE t (x INTEGER)"))
      const result = await run(runQuery(db, "SELECT x FROM t WHERE 1=0"))
      expect(result.isRead).toBe(true)
      expect(result.columns).toEqual(["x"])
      expect(result.rows).toEqual([])
      expect(result.rowCount).toBe(0)
    })
  })

  it("wraps SQL errors in SqliteQueryError", async () => {
    await withDb(async (db) => {
      let error: unknown = null
      try {
        await run(runQuery(db, "SELECT * FROM nonexistent"))
      } catch (e) {
        error = e
      }
      expect(error).toBeInstanceOf(SqliteQueryError)
      expect((error as SqliteQueryError).message).toContain("nonexistent")
    })
  })

  it("rejects an empty query", async () => {
    await withDb(async (db) => {
      let error: unknown = null
      try {
        await run(runQuery(db, "   "))
      } catch (e) {
        error = e
      }
      expect(error).toBeInstanceOf(SqliteQueryError)
    })
  })
})

describe("runSqlScript", () => {
  it("executes multiple statements in one script", async () => {
    await withDb(async (db) => {
      const script = `
        CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT);
        INSERT INTO a (v) VALUES ('x');
        INSERT INTO a (v) VALUES ('y');
      `
      const result = await run(runSqlScript(db, script))
      expect(result.isRead).toBe(false)
      const check = await run(runQuery(db, "SELECT COUNT(*) AS n FROM a"))
      expect(check.rows).toEqual([[2]])
    })
  })

  it("wraps script errors in SqliteQueryError", async () => {
    await withDb(async (db) => {
      let error: unknown = null
      try {
        await run(runSqlScript(db, "CREATE TABLE t (x); INSERT INTO nope VALUES (1);"))
      } catch (e) {
        error = e
      }
      expect(error).toBeInstanceOf(SqliteQueryError)
    })
  })
})
