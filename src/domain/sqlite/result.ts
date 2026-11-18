/**
 * Types for the <SQLite> block's query results. Shared between the domain
 * (which produces them), the IPC layer (which serializes them) and the
 * renderer (which renders them).
 */

/** A value bound to a `?` placeholder in a SQL query. */
export type SqlParam = string | number | boolean | null

/** The result of running a SQL query. */
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
