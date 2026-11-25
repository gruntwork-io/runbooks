import { Filter, X } from "lucide-react"
import { useMemo, useState } from "react"
import { cn } from "@/lib/utils"

export interface ResultTableProps {
  columns: string[]
  rows: unknown[][]
}

type SortDirection = "asc" | "desc" | null

function cellToString(cell: unknown): string {
  if (cell === null) return ""
  if (typeof cell === "object") return JSON.stringify(cell)
  return String(cell as string | number | boolean)
}

/**
 * Compare two cell values for sorting. Numbers sort numerically, everything
 * else sorts as strings (case-insensitive, numeric-aware). null sorts last.
 */
function compareCells(a: unknown, b: unknown): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  if (typeof a === "number" && typeof b === "number") return a - b
  return cellToString(a).localeCompare(cellToString(b), undefined, {
    sensitivity: "base",
    numeric: true,
  })
}

/**
 * Interactive result table for <SQLite> SELECT queries.
 *
 * - Click a column name to sort: ASC → DESC → no sort (cycles).
 * - Click the filter icon next to a column name to open a per-column filter
 *   input; filters combine (AND across columns, substring match per column).
 */
export function ResultTable({ columns, rows }: ResultTableProps) {
  const [sortCol, setSortCol] = useState<number | null>(null)
  const [sortDir, setSortDir] = useState<SortDirection>(null)
  /** Per-column filter values, keyed by column index. */
  const [colFilters, setColFilters] = useState<Record<number, string>>({})
  /** Which column's filter input is currently open. */
  const [openFilter, setOpenFilter] = useState<number | null>(null)

  const visibleRows = useMemo(() => {
    let result = rows

    // Apply per-column filters (AND)
    const activeFilters = Object.entries(colFilters).filter(([, v]) => v.trim() !== "")
    if (activeFilters.length > 0) {
      result = result.filter((row) =>
        activeFilters.every(([colIdx, val]) => {
          const needle = val.trim().toLowerCase()
          return cellToString(row[Number(colIdx)]).toLowerCase().includes(needle)
        }),
      )
    }

    // Apply sort
    if (sortCol !== null && sortDir !== null) {
      const col = sortCol
      const dir = sortDir
      result = [...result].sort((a, b) => {
        const cmp = compareCells(a[col], b[col])
        return dir === "asc" ? cmp : -cmp
      })
    }
    return result
  }, [rows, colFilters, sortCol, sortDir])

  /** ASC → DESC → none → ASC ... */
  const cycleSort = (col: number) => {
    if (sortCol !== col) {
      setSortCol(col)
      setSortDir("asc")
    } else if (sortDir === "asc") {
      setSortDir("desc")
    } else {
      setSortCol(null)
      setSortDir(null)
    }
  }

  const toggleFilter = (col: number) => {
    setOpenFilter(openFilter === col ? null : col)
  }

  const setFilter = (col: number, value: string) => {
    setColFilters((prev) => ({ ...prev, [col]: value }))
  }

  const clearFilter = (col: number) => {
    setColFilters((prev) => {
      const next = { ...prev }
      delete next[col]
      return next
    })
    setOpenFilter(null)
  }

  const hasAnyFilter = Object.values(colFilters).some((v) => v.trim() !== "")
  const activeFilterCount = Object.values(colFilters).filter((v) => v.trim() !== "").length

  return (
    <div>
      <div className="overflow-x-auto rounded border border-border">
        <table className="w-full text-xs font-mono">
          <thead>
            {/* Header row: column name (click = sort) + filter icon */}
            <tr className="bg-background/60 border-b border-border">
              {columns.map((col, i) => (
                <th key={col} className="text-left px-2 py-1.5 font-semibold select-none">
                  <div className="inline-flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => cycleSort(i)}
                      className={cn(
                        "hover:text-foreground cursor-pointer",
                        sortCol === i && "font-bold underline underline-offset-2",
                      )}
                      title="Click to sort"
                    >
                      {col}
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleFilter(i)}
                      className={cn(
                        "cursor-pointer hover:text-foreground",
                        colFilters[i]?.trim() ? "text-info" : "text-muted-foreground/50",
                      )}
                      title={`Filter ${col}`}
                      aria-label={`Filter ${col}`}
                    >
                      <Filter className="size-3" />
                    </button>
                  </div>
                </th>
              ))}
            </tr>
            {/* Filter row: shown when any filter input is open */}
            {openFilter !== null && (
              <tr className="bg-background/40 border-b border-border">
                {columns.map((col, i) => (
                  <td key={col} className="px-2 py-1">
                    {openFilter === i ? (
                      <div className="relative">
                        <input
                          type="text"
                          value={colFilters[i] ?? ""}
                          onChange={(e) => setFilter(i, e.target.value)}
                          placeholder={`Filter ${col}...`}
                          autoFocus
                          className="w-full pr-5 py-0.5 border border-input rounded text-xs font-normal focus:outline-none focus:ring-1 focus:ring-ring"
                        />
                        {(colFilters[i] ?? "") !== "" && (
                          <button
                            type="button"
                            onClick={() => clearFilter(i)}
                            className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                            aria-label={`Clear ${col} filter`}
                          >
                            <X className="size-3" />
                          </button>
                        )}
                      </div>
                    ) : (
                      colFilters[i]?.trim() && (
                        <span className="text-[10px] text-info italic">
                          {colFilters[i]?.trim()}
                        </span>
                      )
                    )}
                  </td>
                ))}
              </tr>
            )}
          </thead>
          <tbody>
            {visibleRows.map((row, i) => (
              <tr key={i} className="border-b border-border/50 last:border-0">
                {row.map((cell, j) => (
                  <td key={j} className="px-2 py-1 whitespace-nowrap">
                    {cell === null ? (
                      <span className="text-muted-foreground italic">NULL</span>
                    ) : (
                      cellToString(cell)
                    )}
                  </td>
                ))}
              </tr>
            ))}
            {visibleRows.length === 0 && (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-2 py-2 text-muted-foreground italic text-center"
                >
                  {hasAnyFilter ? "No rows match the filters" : "No rows returned"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Footer: row count + active sort/filter summary */}
      <div data-testid="result-footer" className="text-xs text-muted-foreground mt-1">
        {visibleRows.length} of {rows.length} row{rows.length === 1 ? "" : "s"}
        {sortCol !== null &&
          sortDir &&
          ` · sorted by ${columns[sortCol]} ${sortDir === "asc" ? "asc" : "desc"}`}
        {activeFilterCount > 0 &&
          ` · ${activeFilterCount} filter${activeFilterCount === 1 ? "" : "s"} active`}
      </div>
    </div>
  )
}
