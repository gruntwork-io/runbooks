import { Database, Play, CheckCircle, XCircle, Loader2 } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { BlockIdLabel } from "@/components/mdx/_shared/components/BlockIdLabel"
import { ErrorDisplay } from "@/components/mdx/_shared/components/ErrorDisplay"
import { ProgressStep } from "@/components/mdx/_shared/components/ProgressStep"
import { InlineMarkdown } from "@/components/mdx/_shared/components/InlineMarkdown"
import { ResultTable } from "./ResultTable"
import { useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { useTemplateContext, useRunbookContext } from "@/contexts/useRunbook"
import { useApi } from "@/contexts/ApiContext"
import { resolveTemplateReferences } from "@/lib/templateUtils"
import { cn } from "@/lib/utils"
import { createAppError, type AppError } from "@/types/error"
import type { SQLiteProps, SQLiteStatus, SqlParam, SqlQueryResult } from "./types"

/**
 * A <SQLite> block: runs a SQL query against a SQLite database and shows
 * the result as a table. The actual query runs in the main process over
 * the `sqlite:query` IPC channel — this component only renders.
 *
 * Props `db`, `query`, `params` may contain `{{ .inputs.X }}` / `{{ .outputs.Y }}`
 * template references, resolved against the runbook's inputs and outputs.
 */
function SQLite({
  id,
  db,
  query,
  path,
  params,
  output,
  title,
  description,
  inputsId,
  successMessage = "Query executed successfully",
  failMessage = "Query failed",
}: SQLiteProps) {
  const api = useApi()
  const templateCtx = useTemplateContext(inputsId)
  const { registerOutputs } = useRunbookContext()

  const [status, setStatus] = useState<SQLiteStatus>("pending")
  const [result, setResult] = useState<SqlQueryResult | null>(null)
  const [error, setError] = useState<AppError | null>(null)

  // Resolve template references in the SQL props
  const resolvedDb = useMemo(
    () => (db ? resolveTemplateReferences(db, templateCtx) : db),
    [db, templateCtx],
  )
  const resolvedQuery = useMemo(
    () => (query ? resolveTemplateReferences(query, templateCtx) : query),
    [query, templateCtx],
  )
  const resolvedPath = useMemo(
    () => (path ? resolveTemplateReferences(path, templateCtx) : path),
    [path, templateCtx],
  )
  // Each scalar param may itself be a template ({{ .inputs.Name }})
  const resolvedParams = useMemo(
    () =>
      params?.map((p) =>
        typeof p === "string" ? (resolveTemplateReferences(p, templateCtx) as SqlParam) : p,
      ),
    [params, templateCtx],
  )
  const resolvedTitle = useMemo(
    () => (title ? resolveTemplateReferences(title, templateCtx) : title),
    [title, templateCtx],
  )
  const resolvedDescription = useMemo(
    () => (description ? resolveTemplateReferences(description, templateCtx) : description),
    [description, templateCtx],
  )

  // Duplicate ID detection
  const blockRef = useRef<HTMLDivElement>(null)
  const { isDuplicate, isNormalizedCollision, collidingId } = useComponentIdRegistry(
    id,
    "SQLite",
    blockRef,
  )

  const { reportError, clearError } = useErrorReporting()

  // Validate required props — configuration errors, reported via reportError
  const configError = useMemo((): AppError | null => {
    if (!id) {
      return createAppError("The <SQLite> component requires a non-empty 'id' prop.")
    }
    if (!db) {
      return createAppError(`The <SQLite> block "${id}" requires a 'db' prop.`)
    }
    if (!query && !path) {
      return createAppError(`The <SQLite> block "${id}" requires a 'query' or 'path' prop.`)
    }
    if (query && path) {
      return createAppError(`The <SQLite> block "${id}" takes either 'query' or 'path', not both.`)
    }
    return null
  }, [id, db, query, path])

  useEffect(() => {
    if (isDuplicate) {
      reportError({
        componentId: id,
        componentType: "SQLite",
        severity: "error",
        message: `Duplicate SQLite block ID: "${id}"`,
      })
    } else if (isNormalizedCollision) {
      reportError({
        componentId: id,
        componentType: "SQLite",
        severity: "error",
        message: `SQLite block ID "${id}" collides with "${collidingId}" (case-insensitive)`,
      })
    } else if (configError) {
      reportError({
        componentId: id,
        componentType: "SQLite",
        severity: "error",
        message: configError.message,
      })
    } else {
      clearError(id)
    }
  }, [isDuplicate, isNormalizedCollision, collidingId, configError, id, reportError, clearError])

  const runQuery = useCallback(async () => {
    if (!resolvedDb || (!resolvedQuery && !resolvedPath) || isDuplicate) return
    setStatus("running")
    setError(null)
    setResult(null)
    try {
      const res = await api.invoke("sqlite:query", {
        dbPath: resolvedDb,
        ...(resolvedQuery ? { sql: resolvedQuery } : {}),
        ...(resolvedPath ? { sqlPath: resolvedPath } : {}),
        params: resolvedParams ?? [],
      })
      setResult(res)
      setStatus("success")
      if (output) {
        registerOutputs(id, { [output]: JSON.stringify(res.rows) })
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "An unexpected error occurred"
      setError(createAppError(message))
      setStatus("fail")
    }
  }, [
    api,
    resolvedDb,
    resolvedQuery,
    resolvedPath,
    resolvedParams,
    output,
    id,
    isDuplicate,
    registerOutputs,
  ])

  if (configError) {
    return (
      <div ref={blockRef} className="my-4">
        <ErrorDisplay error={configError} />
      </div>
    )
  }

  return (
    <div
      ref={blockRef}
      data-testid="sqlite-block"
      className={cn(
        "my-4 rounded-lg border p-4",
        status === "success" && "bg-success-muted border-success/30",
        status === "fail" && "bg-destructive-muted border-destructive/30",
        status === "running" && "bg-info-muted border-info/40",
        status === "pending" && "bg-muted border-border",
      )}
    >
      <ProgressStep done={status === "success"} />

      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <Database className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            {resolvedTitle && (
              <div className="font-medium truncate">
                <InlineMarkdown>{resolvedTitle}</InlineMarkdown>
              </div>
            )}
            <div className="text-xs text-muted-foreground font-mono truncate">{resolvedDb}</div>
          </div>
        </div>
        <BlockIdLabel id={id} />
      </div>

      {resolvedDescription && (
        <div className="text-sm text-muted-foreground mb-3">
          <InlineMarkdown>{resolvedDescription}</InlineMarkdown>
        </div>
      )}

      {/* Query preview */}
      <pre className="text-xs bg-background/60 rounded p-2 mb-3 overflow-x-auto whitespace-pre-wrap break-all font-mono">
        {resolvedQuery ? resolvedQuery : `SQL file: ${resolvedPath ?? ""}`}
      </pre>

      {/* Action button */}
      <div className="flex items-center gap-2 mb-3">
        <Button
          onClick={runQuery}
          disabled={status === "running" || isDuplicate}
          size="sm"
          variant={status === "fail" ? "destructive" : "default"}
        >
          {status === "running" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : status === "success" ? (
            <CheckCircle className="size-4" />
          ) : status === "fail" ? (
            <XCircle className="size-4" />
          ) : (
            <Play className="size-4" />
          )}
          {status === "running" ? "Running..." : status === "success" ? "Run again" : "Run"}
        </Button>
      </div>

      {/* Error */}
      {status === "fail" && error && (
        <div className="text-sm text-destructive mb-2">
          <span className="font-medium">{failMessage}:</span> {error.message}
        </div>
      )}

      {/* Result */}
      {status === "success" && result && (
        <div>
          <div className="text-sm text-success mb-2">{successMessage}</div>
          {result.isRead && result.columns.length > 0 ? (
            <ResultTable columns={result.columns} rows={result.rows} />
          ) : (
            <div className="text-xs text-muted-foreground">
              {result.rowCount} row{result.rowCount === 1 ? "" : "s"} affected
            </div>
          )}
        </div>
      )}
    </div>
  )
}

SQLite.displayName = "SQLite"

export default SQLite
