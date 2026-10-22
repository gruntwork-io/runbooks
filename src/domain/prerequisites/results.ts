/**
 * What a <Prerequisites> check found for each tool, what that makes the
 * block's status, and the outputs it publishes. The main process and the
 * test CLI work out results from what they found on PATH; the renderer works
 * them out again from the outputs, which the session also keeps. The
 * renderer bundles this module, so it must not import Node.js modules.
 */
import { errorMessage } from "../../errors/message.ts"
import type { LogLevel } from "../exec/logChannels.ts"
import type { PrerequisiteTool, PrerequisitesSpec } from "./spec.ts"
import { extractVersion, parseVersion, satisfiesConstraint } from "./version.ts"

/**
 * - found: on PATH, at a version that meets its constraint if it has one
 * - missing: not on PATH
 * - wrong_version: on PATH, at a version that doesn't meet its constraint
 * - unknown_version: on PATH, but it printed no version to check
 */
export type ToolStatus = "found" | "missing" | "wrong_version" | "unknown_version"

export interface ToolResult {
  readonly tool: PrerequisiteTool
  readonly status: ToolStatus
  /** Where the tool is on PATH, or null when it isn't. */
  readonly path: string | null
  /** The version the tool printed, or null when it wasn't read or printed none. */
  readonly version: string | null
}

/** The block's status: a required tool that isn't found fails it, an optional one makes it a warning. */
export type PrerequisitesStatus = "success" | "warn" | "fail"

export interface LogEntry {
  readonly level: LogLevel
  readonly text: string
}

/** Why a run of bash, to look the tools up or to read a version, gave no output to read. */
export type RunFailure =
  | { readonly reason: "timeout"; readonly timeoutMs: number }
  | { readonly reason: "error"; readonly cause: unknown }

/** What running a tool's version command gave: its output, stderr included, or why it gave none. */
export type ProbeOutcome = { readonly output: string; readonly exitCode: number } | RunFailure

/** A tool's result, with a note for the log that explains a version the check couldn't read. */
export interface CheckedTool {
  readonly result: ToolResult
  readonly note: string | null
}

/** The longest line of a tool's output a log note quotes. */
const MAX_QUOTED_OUTPUT = 200

/**
 * The result for `tool`, found at `path` (null when it isn't on PATH), which
 * printed `version` (null when its version wasn't read or it printed none).
 */
export function evaluateTool(
  tool: PrerequisiteTool,
  path: string | null,
  version: string | null,
): ToolResult {
  if (!path) return { tool, status: "missing", path: null, version: null }
  if (!tool.constraint) return { tool, status: "found", path, version }
  const parsed = version === null ? null : parseVersion(version)
  if (!parsed) return { tool, status: "unknown_version", path, version: null }
  const status = satisfiesConstraint(parsed, tool.constraint) ? "found" : "wrong_version"
  return { tool, status, path, version }
}

/**
 * The result for `tool` from where the lookup found it (null when it isn't on
 * PATH) and how running its version command went (null when its version
 * isn't read). The main process and the test CLI run the commands, each its
 * own way, and both work out the result here.
 */
export function checkTool(
  tool: PrerequisiteTool,
  path: string | null,
  probe: ProbeOutcome | null,
): CheckedTool {
  if (!path || !probe) return { result: evaluateTool(tool, path, null), note: null }
  const command = versionCommand(tool)
  if ("reason" in probe) {
    return {
      result: evaluateTool(tool, path, null),
      note: `"${command}" ${describeRunFailure(probe)}.`,
    }
  }
  const version = extractVersion(probe.output)
  return {
    result: evaluateTool(tool, path, version),
    note: version ? null : quoteOutput(command, probe.output, probe.exitCode),
  }
}

/** What a version command printed when no version could be read from it. */
function quoteOutput(command: string, output: string, exitCode: number): string {
  const firstLine = output
    .split("\n")
    .find((line) => line.trim() !== "")
    ?.trim()
  if (!firstLine) return `"${command}" printed nothing (exit code ${exitCode}).`
  const quoted =
    firstLine.length > MAX_QUOTED_OUTPUT ? `${firstLine.slice(0, MAX_QUOTED_OUTPUT)}…` : firstLine
  return `"${command}" printed: ${quoted}`
}

/** What went wrong, worded to follow a command: "didn't finish within 15 seconds". */
function describeRunFailure(failure: RunFailure): string {
  return failure.reason === "timeout"
    ? `didn't finish within ${failure.timeoutMs / 1000} seconds`
    : `couldn't run: ${errorMessage(failure.cause)}`
}

/** A check's log: each tool's result and its note, in order, then the summary. */
export function checkLog(checked: readonly CheckedTool[]): LogEntry[] {
  const log: LogEntry[] = []
  for (const { result, note } of checked) {
    log.push(describeResult(result))
    if (note) log.push({ level: result.status === "found" ? "INFO" : "WARN", text: note })
  }
  log.push(summarize(checked.map(({ result }) => result)))
  return log
}

/** The log line of a check that couldn't look for its tools on PATH. */
export function lookupFailedLog(failure: RunFailure): LogEntry {
  return {
    level: "ERROR",
    text: `Couldn't look for the tools on PATH: bash ${describeRunFailure(failure)}.`,
  }
}

export function prerequisitesStatus(results: readonly ToolResult[]): PrerequisitesStatus {
  const notFound = results.filter((result) => result.status !== "found")
  if (notFound.some((result) => !result.tool.optional)) return "fail"
  return notFound.length > 0 ? "warn" : "success"
}

/** The exit code a run with this status reports, as a script's would. */
export function statusExitCode(status: PrerequisitesStatus): number {
  return { success: 0, warn: 2, fail: 1 }[status]
}

/**
 * The block's outputs: `<key>_path` for every tool, empty when it isn't on
 * PATH, and `<key>_version` for every tool whose version was read, empty when
 * it printed none. A run returns them whatever its status, since a failed
 * check shows what it found from them, but only a check that passes or warns
 * publishes them for other blocks.
 */
export function prerequisitesOutputs(results: readonly ToolResult[]): Record<string, string> {
  const outputs: Record<string, string> = {}
  for (const { tool, path, version } of results) {
    outputs[`${tool.outputKey}_path`] = path ?? ""
    if (tool.versionArgs && path) outputs[`${tool.outputKey}_version`] = version ?? ""
  }
  return outputs
}

/**
 * The result for each of `spec`'s tools from a run's outputs, in order: null
 * for a tool the run didn't check (it has no `<key>_path` output), such as one
 * added to the runbook since.
 */
export function resultsFromOutputs(
  spec: PrerequisitesSpec,
  outputs: Readonly<Record<string, string>>,
): Array<ToolResult | null> {
  return spec.tools.map((tool) => {
    const path = outputs[`${tool.outputKey}_path`]
    if (path === undefined) return null
    return evaluateTool(tool, path || null, outputs[`${tool.outputKey}_version`] || null)
  })
}

/** The command that reads `tool`'s version, as it would be typed: "tofu --version". */
export function versionCommand(tool: PrerequisiteTool): string {
  return [tool.name, ...(tool.versionArgs ?? []).map(shellQuote)].join(" ")
}

/** `arg` as bash would need it typed: in single quotes unless it has no special characters. */
function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`
}

/** A log line for one tool's result, and its level. */
export function describeResult(result: ToolResult): LogEntry {
  const { tool, status, path, version } = result
  const name = version ? `${tool.name} ${version}` : tool.name
  const needs = tool.version ? ` (needs ${tool.version})` : ""
  const failLevel: LogLevel = tool.optional ? "WARN" : "ERROR"
  const optional = tool.optional ? " This tool is optional." : ""
  switch (status) {
    case "found":
      return { level: "INFO", text: `${name}${needs}: found at ${path}` }
    case "missing":
      return { level: failLevel, text: `${tool.name}: not found on PATH.${optional}` }
    case "wrong_version":
      return {
        level: failLevel,
        text: `${name} at ${path} doesn't meet the version requirement ${tool.version}.${optional}`,
      }
    case "unknown_version":
      return {
        level: failLevel,
        text: `${tool.name} at ${path}: "${versionCommand(tool)}" printed no version number to check against ${tool.version}.${optional}`,
      }
  }
}

/** The run's last log line, which sums up its results. */
export function summarize(results: readonly ToolResult[]): LogEntry {
  switch (prerequisitesStatus(results)) {
    case "success":
      return {
        level: "INFO",
        text:
          results.length === 1
            ? `${results[0]!.tool.name} is installed.`
            : `All ${results.length} tools are installed.`,
      }
    case "warn":
      return {
        level: "WARN",
        text: `The required tools are installed. Optional tools to install or update: ${notFoundNames(results, false)}.`,
      }
    case "fail":
      return {
        level: "ERROR",
        text: `Tools to install or update: ${notFoundNames(results, true)}.`,
      }
  }
}

/** The tools that weren't found, each optional one marked when `markOptional`. */
function notFoundNames(results: readonly ToolResult[], markOptional: boolean): string {
  return results
    .filter((result) => result.status !== "found")
    .map(({ tool }) => (markOptional && tool.optional ? `${tool.name} (optional)` : tool.name))
    .join(", ")
}
