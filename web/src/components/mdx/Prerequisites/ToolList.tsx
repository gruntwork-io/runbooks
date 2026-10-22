import { AlertTriangle, CheckCircle, CircleDashed, CircleMinus, XCircle } from "lucide-react"
import { InlineMarkdown } from "@/components/mdx/_shared"
import type { PrerequisiteTool, Requirement } from "../../../../../src/domain/prerequisites/spec"
import type { ToolResult } from "../../../../../src/domain/prerequisites/results"

interface ToolListProps {
  requirements: readonly Requirement[]
  /** What the last check found for each tool. A tool it didn't check has none. */
  results: ReadonlyArray<ToolResult | null>
  /** Show every tool's install hint, not only those of the tools the check found a problem with. */
  showAllInstallHints?: boolean
}

/**
 * How a tool, or an `anyOf` list, is marked: not checked yet, found, not
 * needed (another tool of its `anyOf` list was found), or not found, which
 * is a warning when it's optional.
 */
type Mark = "unchecked" | "found" | "not_needed" | "warn" | "fail"

/** The tools a <Prerequisites> block checks, each with what the last check found. */
export function ToolList({ requirements, results, showAllInstallHints = false }: ToolListProps) {
  const resultByName = new Map(
    results.flatMap((result) => (result ? [[result.tool.name, result] as const] : [])),
  )
  const resultOf = (tool: PrerequisiteTool) => resultByName.get(tool.name) ?? null

  return (
    <ul className="space-y-2">
      {requirements.map((requirement) => {
        const [tool, ...alternatives] = requirement.tools
        if (tool && alternatives.length === 0) {
          return (
            <ToolItem
              key={tool.name}
              tool={tool}
              result={resultOf(tool)}
              needed
              showAllInstallHints={showAllInstallHints}
            />
          )
        }
        return (
          <AnyOfItem
            key={requirement.tools.map(({ name }) => name).join(" ")}
            requirement={requirement}
            results={requirement.tools.map(resultOf)}
            showAllInstallHints={showAllInstallHints}
          />
        )
      })}
    </ul>
  )
}

/**
 * An `anyOf` list: its tools under one heading, marked found when the check
 * found any of them. Then the others aren't needed, so they aren't problems.
 */
function AnyOfItem({
  requirement,
  results,
  showAllInstallHints,
}: {
  requirement: Requirement
  /** Its tools' results, in order. */
  results: ReadonlyArray<ToolResult | null>
  showAllInstallHints: boolean
}) {
  const met = results.some((result) => result?.status === "found")
  const checked = results.some((result) => result !== null)
  const mark: Mark = !checked ? "unchecked" : met ? "found" : requirement.optional ? "warn" : "fail"
  return (
    <li
      data-testid={`any-of-${requirement.tools.map(({ name }) => name).join("-")}`}
      data-status={checked ? (met ? "met" : "unmet") : "unchecked"}
      className="flex items-start gap-2"
    >
      <MarkIcon mark={mark} />
      <div className="min-w-0 flex-1 space-y-2">
        <div>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-semibold text-foreground">Any one of these</span>
            {requirement.optional && <OptionalBadge />}
          </div>
          {requirement.description && (
            <div className="text-sm text-muted-foreground">
              <InlineMarkdown>{requirement.description}</InlineMarkdown>
            </div>
          )}
        </div>
        <ul className="space-y-2 border-l border-border pl-3">
          {requirement.tools.map((tool, i) => (
            <ToolItem
              key={tool.name}
              tool={tool}
              result={results[i] ?? null}
              needed={!met}
              inAnyOf
              showAllInstallHints={showAllInstallHints}
            />
          ))}
        </ul>
      </div>
    </li>
  )
}

/**
 * One tool and what the check found. A tool that isn't `needed`, since
 * another of its `anyOf` list was found, shows no problem or install hint.
 */
function ToolItem({
  tool,
  result,
  needed,
  inAnyOf = false,
  showAllInstallHints,
}: {
  tool: PrerequisiteTool
  result: ToolResult | null
  needed: boolean
  /** In an `anyOf` list, whose heading says whether it's optional. */
  inAnyOf?: boolean
  showAllInstallHints: boolean
}) {
  const notFound = result !== null && result.status !== "found"
  const problem = notFound && needed
  const mark: Mark =
    result === null
      ? "unchecked"
      : !notFound
        ? "found"
        : !needed
          ? "not_needed"
          : tool.optional
            ? "warn"
            : "fail"
  return (
    <li
      data-testid={`tool-${tool.name}`}
      data-status={result?.status ?? "unchecked"}
      className="flex items-start gap-2"
    >
      <MarkIcon mark={mark} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <code className="font-mono text-sm font-semibold text-foreground">{tool.name}</code>
          {tool.version && (
            <span className="font-mono text-xs text-muted-foreground">{tool.version}</span>
          )}
          {tool.optional && !inAnyOf && <OptionalBadge />}
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
}

function OptionalBadge() {
  return <span className="rounded-sm bg-muted px-1.5 text-xs text-muted-foreground">optional</span>
}

function MarkIcon({ mark }: { mark: Mark }) {
  const className = "size-4 mt-0.5 flex-shrink-0"
  switch (mark) {
    case "unchecked":
      return <CircleDashed aria-hidden className={`${className} text-muted-foreground`} />
    case "found":
      return <CheckCircle aria-hidden className={`${className} text-success`} />
    case "not_needed":
      return <CircleMinus aria-hidden className={`${className} text-muted-foreground`} />
    case "warn":
      return <AlertTriangle aria-hidden className={`${className} text-warning`} />
    case "fail":
      return <XCircle aria-hidden className={`${className} text-destructive`} />
  }
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
