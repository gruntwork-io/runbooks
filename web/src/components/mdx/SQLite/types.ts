/**
 * Types for the <SQLite> block. The query result shape mirrors what the
 * main process returns over the `sqlite:query` IPC channel.
 */

/** A value bound to a `?` placeholder in a SQL query. */
export type SqlParam = string | number | boolean | null

/** The result of running a SQL query, as returned by `sqlite:query`. */
export interface SqlQueryResult {
  /** Column names of the result set, empty for write queries. */
  columns: string[]
  /** Rows of the result set, each row an array of values in column order. */
  rows: unknown[][]
  /** Number of affected rows for write queries; rows.length for reads. */
  rowCount: number
  /** True when the query returned a result set (SELECT, PRAGMA, ...). */
  isRead: boolean
}

export interface SQLiteProps {
  /** Unique block id. */
  id: string
  /** Path to the .db file (relative to the runbook's folder), or `:memory:`. */
  db: string
  /** SQL statement. Use `?` placeholders for parameterized values. Exactly one of `query` and `path`. */
  query?: string
  /** Path to a .sql file to execute (multi-statement), relative to the runbook's folder. Exactly one of `query` and `path`. */
  path?: string
  /** Values bound to `?` placeholders in `query`. */
  params?: SqlParam[]
  /** When set, the result rows are published as this block's output. */
  output?: string
  /** Optional title shown above the block. */
  title?: string
  /** Optional description shown below the title. */
  description?: string
  /** Reference to one or more Inputs blocks for template variable substitution. */
  inputsId?: string | string[]
  /** Message shown on success. */
  successMessage?: string
  /** Message shown on failure. */
  failMessage?: string
}

/** The status of a SQLite block run. */
export type SQLiteStatus = "pending" | "running" | "success" | "fail"
