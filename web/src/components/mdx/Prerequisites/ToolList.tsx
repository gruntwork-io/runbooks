import { AlertTriangle, CheckCircle, CircleDashed, XCircle } from "lucide-react"
import { InlineMarkdown } from "@/components/mdx/_shared"
import type { PrerequisiteTool } from "../../../../../src/domain/prerequisites/spec"
import type { ToolResult } from "../../../../../src/domain/prerequisites/results"

interface ToolListProps {
  tools: readonly PrerequisiteTool[]
  /** What the last check found for each tool, in the same order. A tool it didn't check has none. */
  results: ReadonlyArray<ToolResult | null>
  /** Show every tool's install hint, not only those of the tools the check found a problem with. */
  showAllInstallHints?: boolean
}

/** The tools a <Prerequisites> block checks, each with what the last check found. */
export function ToolList({ tools, results, showAllInstallHints = false }: ToolListProps) {
  return (
    <ul className="space-y-2">
      {tools.map((tool, i) => {
        const result = results[i] ?? null
        const problem = result !== null && result.status !== "found"
        return (
          <li
            key={tool.name}
            data-testid={`tool-${tool.name}`}
            data-status={result?.status ?? "unchecked"}
            className="flex items-start gap-2"
          >
            <ToolIcon tool={tool} result={result} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <code className="font-mono text-sm font-semibold text-foreground">{tool.name}</code>
                {tool.version && (
                  <span className="font-mono text-xs text-muted-foreground">{tool.version}</span>
                )}
                {tool.optional && (
                  <span className="rounded-sm bg-muted px-1.5 text-xs text-muted-foreground">
                    optional
                  </span>
                )}
              </div>
              {tool.description && (
                <div className="text-sm text-muted-foreground">
                  <InlineMarkdown>{tool.description}</InlineMarkdown>
                </div>
              )}
              {result && <ResultLine result={result} />}
              {tool.install && (problem || showAllInstallHints) && (
                <div className="text-sm text-foreground">
                  <InlineMarkdown>{tool.install}</InlineMarkdown>
                </div>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function ToolIcon({ tool, result }: { tool: PrerequisiteTool; result: ToolResult | null }) {
  const className = "size-4 mt-0.5 flex-shrink-0"
  if (!result) return <CircleDashed aria-hidden className={`${className} text-muted-foreground`} />
  if (result.status === "found") {
    return <CheckCircle aria-hidden className={`${className} text-success`} />
  }
  if (tool.optional) return <AlertTriangle aria-hidden className={`${className} text-warning`} />
  return <XCircle aria-hidden className={`${className} text-destructive`} />
}

function ResultLine({ result }: { result: ToolResult }) {
  const { tool, path, version } = result
  const at = <code className="font-mono break-all">{path}</code>
  return (
    <div className="text-xs text-muted-foreground">
      {result.status === "found" &&
        (version ? (
          <>
            {version} at {at}
          </>
        ) : (
          <>Found at {at}</>
        ))}
      {result.status === "missing" && "Not found on PATH."}
      {result.status === "wrong_version" && (
        <>
          {version} at {at} doesn't meet {tool.version}.
        </>
      )}
      {result.status === "unknown_version" && (
        <>Found at {at}, but the check couldn't read its version. See the logs.</>
      )}
    </div>
  )
}
