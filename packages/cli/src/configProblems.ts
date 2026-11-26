/**
 * A runbook's configuration errors and warnings as a person reads them: one
 * line per problem, `file:line:column`, so an editor or terminal can jump to
 * it, then what was expected, what was found and the likely fix.
 */
import path from "node:path"
import type { ConfigError, ConfigWarning } from "@runbooks/core/document/configError"

/** `file` as the person named it: relative to where they ran the command, when it is under it. */
export const shownPath = (file: string, cwd: string): string => {
  const relative = path.relative(cwd, file)
  return relative === "" || relative.startsWith("..") || path.isAbsolute(relative) ? file : relative
}

export function problemLines(problem: ConfigError | ConfigWarning, cwd: string): string[] {
  const { file, span } = problem.location
  const severity = problem._tag === "ConfigError" ? "error" : "warning"
  const lines = [
    `${shownPath(file, cwd)}:${span.start.line}:${span.start.column}: ${severity} ${problem.code}: ${problem.message}`,
  ]
  if (problem._tag === "ConfigError") {
    if (problem.expected !== undefined) lines.push(`    expected: ${problem.expected}`)
    if (problem.received !== undefined) lines.push(`    received: ${problem.received}`)
  }
  if (problem.suggestion !== undefined) lines.push(`    did you mean: ${problem.suggestion}`)
  return lines
}
