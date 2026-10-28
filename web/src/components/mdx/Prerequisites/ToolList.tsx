import { Check, Dot, Minus, X } from "lucide-react"
import { InlineMarkdown } from "@/components/mdx/_shared"
import { Reserved } from "@/components/mdx/_shared/components/Reserved"
import type { PrerequisiteTool, Requirement } from "../../../../../src/domain/prerequisites/spec"
import type { ToolResult } from "../../../../../src/domain/prerequisites/results"

interface ToolListProps {
  requirements: readonly Requirement[]
  /**
   * What the last check found for each tool. A tool it didn't check has none.
   * Null for a list nothing checks, as in instruction mode, which shows every
   * tool's install hint.
   */
  results: ReadonlyArray<ToolResult | null> | null
}

/**
 * How a tool, or an `anyOf` list, is marked: not checked yet, found, not
 * needed (another tool of its `anyOf` list was found), or not found, which
 * is a warning when it's optional.
 */
type Mark = "unchecked" | "found" | "not_needed" | "warn" | "fail"

/**
 * The tools a <Prerequisites> block checks, each with what the last check
 * found. A checked list keeps room for each tool's result and install hint
 * while it has none, so the tools stay where they are as checks run and end.
 */
export function ToolList({ requirements, results }: ToolListProps) {
  const checked = results !== null
  const resultByName = new Map(
    (results ?? []).flatMap((result) => (result ? [[result.tool.name, result] as const] : [])),
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
              checked={checked}
            />
          )
        }
        return (
          <AnyOfItem
            key={requirement.tools.map(({ name }) => name).join(" ")}
            requirement={requirement}
            results={requirement.tools.map(resultOf)}
            checked={checked}
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
  checked,
}: {
  requirement: Requirement
  /** Its tools' results, in order. */
  results: ReadonlyArray<ToolResult | null>
  checked: boolean
}) {
  const met = results.some((result) => result?.status === "found")
  const hasResults = results.some((result) => result !== null)
  const mark: Mark = !hasResults
    ? "unchecked"
    : met
      ? "found"
      : requirement.optional
        ? "warn"
        : "fail"
  return (
    <li
      data-testid={`any-of-${requirement.tools.map(({ name }) => name).join("-")}`}
      data-status={hasResults ? (met ? "met" : "unmet") : "unchecked"}
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
              checked={checked}
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
  checked,
}: {
  tool: PrerequisiteTool
  result: ToolResult | null
  needed: boolean
  /** In an `anyOf` list, whose heading says whether it's optional. */
  inAnyOf?: boolean
  /** Whether a check reads the list: false in instruction mode. */
  checked: boolean
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
  const installHint = tool.install && <InlineMarkdown>{tool.install}</InlineMarkdown>
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
        {checked && <ResultLine result={result} />}
        {installHint &&
          (checked ? (
            <Reserved
              className="text-sm text-foreground"
              variants={{ installHint }}
              shown={problem ? "installHint" : null}
            />
          ) : (
            <div className="text-sm text-foreground">{installHint}</div>
          ))}
      </div>
    </li>
  )
}

function OptionalBadge() {
  return <span className="rounded-sm bg-muted px-1.5 text-xs text-muted-foreground">optional</span>
}

/**
 * A tool's mark: a bare check or cross, so it isn't mistaken for the circled
 * icon that says how the whole check went.
 */
function MarkIcon({ mark }: { mark: Mark }) {
  const className = "size-4 mt-0.5 flex-shrink-0"
  switch (mark) {
    case "unchecked":
      return <Dot aria-hidden strokeWidth={4} className={`${className} text-muted-foreground`} />
    case "found":
      return <Check aria-hidden strokeWidth={3} className={`${className} text-success`} />
    case "not_needed":
      return <Minus aria-hidden strokeWidth={3} className={`${className} text-muted-foreground`} />
    case "warn":
      return <X aria-hidden strokeWidth={3} className={`${className} text-warning`} />
    case "fail":
      return <X aria-hidden strokeWidth={3} className={`${className} text-destructive`} />
  }
}

/**
 * What the check found for a tool, in a line that's there before it has a
 * result too. A line too long for the block is cut short, with all of it on
 * hover, so a long path doesn't push the tools below it down.
 */
function ResultLine({ result }: { result: ToolResult | null }) {
  const [before, path, after] = result ? resultParts(result) : ["", "", ""]
  return (
    <div
      className="h-lh truncate text-xs text-muted-foreground"
      title={result ? `${before}${path}${after}` : undefined}
    >
      {before}
      {path && <code className="font-mono whitespace-nowrap">{path}</code>}
      {after}
    </div>
  )
}

/** A result's line: the words before the tool's path, the path, and the words after it. */
function resultParts({ tool, status, path, version }: ToolResult): [string, string, string] {
  switch (status) {
    case "found":
      return [version ? `${version} at ` : "Found at ", path ?? "", ""]
    case "missing":
      return ["Not found on PATH.", "", ""]
    case "wrong_version":
      return [`${version} at `, path ?? "", ` doesn't meet ${tool.version}.`]
    case "unknown_version":
      return ["Found at ", path ?? "", ", but the check couldn't read its version. See the logs."]
  }
}
