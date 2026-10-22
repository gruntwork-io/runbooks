/**
 * Runs a <Prerequisites> block's check in the main process. exec:run hands
 * it the tool list the block registered in place of a script, and the run
 * reaches the renderer the way a script's does: log lines, a status, and
 * outputs.
 */
import { Effect, Result, Stream, type Cause } from "effect"
import { delimiter } from "node:path"
import { FileSystem } from "../../services/FileSystem.ts"
import { ProcessSpawner, collectOutput } from "../../services/ProcessSpawner.ts"
import type { PathRefreshError, SpawnError } from "../../errors/index.ts"
import type { SessionExecContext } from "../../types.ts"
import { logFileName, withSystemPath, type ExecEvent } from "../exec/executor.ts"
import { appendPathEntries } from "../session/manager.ts"
import { tagLogLine } from "../exec/logChannels.ts"
import { parsePrerequisitesSpec, type PrerequisiteTool, type PrerequisitesSpec } from "./spec.ts"
import {
  LOOKUP_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
  lookupArgs,
  parseLookupOutput,
  probeArgs,
} from "./lookup.ts"
import {
  checkLog,
  checkTool,
  lookupFailedLog,
  prerequisitesOutputs,
  prerequisitesStatus,
  statusExitCode,
  unmetRequirements,
  type CheckedTool,
  type LogEntry,
  type PrerequisitesStatus,
  type ProbeOutcome,
  type RunFailure,
  type ToolResult,
} from "./results.ts"

/**
 * PATH as read again from where the app got it when it started. Reading it
 * also adds its directories to the session's PATH, so the blocks that run
 * next find the tools too.
 */
export interface FreshPath {
  /** Where PATH was read from, for the log, such as "your login shell (/bin/zsh)". */
  readonly source: string
  /** Its directories, in order. */
  readonly entries: readonly string[]
}

/** Why a spawned bash gave no output: it timed out, or couldn't run. */
function runFailure(failure: SpawnError | Cause.TimeoutError, timeoutMs: number): RunFailure {
  return failure._tag === "TimeoutError"
    ? { reason: "timeout", timeoutMs }
    : { reason: "error", cause: failure.cause }
}

/**
 * Check `spec`'s tools with the session's env and working directory, the way
 * a script would find them. When a tool the runbook needs isn't on PATH,
 * `refreshPath` (if given) runs once, and the missing tools are looked for
 * again with its directories added to the end of PATH. A tool of an `anyOf`
 * list whose other tool was found isn't needed, so it doesn't count. Fails
 * only when bash can't look for the tools at all.
 */
export const checkPrerequisites = (
  spec: PrerequisitesSpec,
  session: SessionExecContext,
  refreshPath?: Effect.Effect<FreshPath, PathRefreshError>,
) =>
  Effect.gen(function* () {
    const spawner = yield* ProcessSpawner
    const cwd = session.workDir || undefined
    const log: LogEntry[] = []
    let env = yield* withSystemPath(session.env)

    const lookUp = (names: readonly string[]) =>
      spawner.spawn("bash", lookupArgs(names), { cwd, env }).pipe(
        Effect.flatMap((proc) => collectOutput(proc, LOOKUP_TIMEOUT_MS)),
        Effect.map(({ lines }) =>
          parseLookupOutput(lines.filter((l) => l.source === "stdout").map((l) => l.line)),
        ),
      )

    const paths = yield* lookUp(spec.tools.map((tool) => tool.name))
    const check = (tools: readonly PrerequisiteTool[]) =>
      Effect.forEach(
        tools,
        (tool) => {
          const path = paths.get(tool.name) ?? null
          if (!path || !tool.versionArgs) return Effect.succeed(checkTool(tool, path, null))
          return spawner.spawn("bash", probeArgs(path, tool.versionArgs), { cwd, env }).pipe(
            Effect.flatMap((proc) => collectOutput(proc, PROBE_TIMEOUT_MS)),
            Effect.map(({ lines, exitCode }): ProbeOutcome => ({
              output: lines.map((l) => l.line).join("\n"),
              exitCode,
            })),
            Effect.catch((failure) => Effect.succeed(runFailure(failure, PROBE_TIMEOUT_MS))),
            Effect.map((probe) => checkTool(tool, path, probe)),
          )
        },
        { concurrency: 4 },
      )
    let checked: readonly CheckedTool[] = yield* check(spec.tools)

    // The tools that aren't on PATH, of the requirements the check didn't meet
    const missing = unmetRequirements(
      spec,
      checked.map(({ result }) => result),
    ).flatMap(({ tools }) => tools.filter((tool) => !paths.has(tool.name)))
    if (missing.length > 0 && refreshPath) {
      const names = missing.map((tool) => tool.name)
      const notOnPath = `${names.join(", ")} ${names.length === 1 ? "wasn't" : "weren't"} on PATH`
      const refreshed = yield* Effect.result(refreshPath)
      if (Result.isFailure(refreshed)) {
        log.push({
          level: "WARN",
          text: `${notOnPath}, and PATH couldn't be read again: ${refreshed.failure.message}`,
        })
      } else {
        const { source, entries } = refreshed.success
        const { path, added } = appendPathEntries(env["PATH"] ?? "", entries, delimiter)
        if (added.length === 0) {
          log.push({
            level: "INFO",
            text: `${notOnPath}, so Runbooks read PATH again from ${source}. It has no directories that weren't on PATH already.`,
          })
        } else {
          log.push({
            level: "INFO",
            text: `${notOnPath}, so Runbooks read PATH again from ${source} and added ${added.join(", ")}.`,
          })
          env = { ...env, PATH: path }
          for (const [name, found] of yield* lookUp(names)) paths.set(name, found)
          const rechecked = yield* check(missing.filter((tool) => paths.has(tool.name)))
          checked = checked.map(
            (old) =>
              rechecked.find(({ result }) => result.tool.name === old.result.tool.name) ?? old,
          )
        }
      }
    }

    const results: ToolResult[] = checked.map(({ result }) => result)
    return { results, log: [...log, ...checkLog(spec, checked)] }
  })

/**
 * Run a <Prerequisites> block's check from the YAML its registry entry holds,
 * and return it in executeScript's shape, so exec:run relays it like a
 * script's run. The log goes to a new file in `logsDir`, as a script's does.
 *
 * Unlike a script's, the outputs come back whatever the status: they say
 * which tools were found, which is what a failed check has to show. The
 * renderer publishes them for other blocks only when the check passes or warns.
 */
export const executePrerequisites = (
  yamlText: string,
  session: SessionExecContext,
  logsDir: string,
  refreshPath?: Effect.Effect<FreshPath, PathRefreshError>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    yield* fs.mkdir(logsDir, { recursive: true })
    const logFilePath = `${logsDir}/${logFileName(new Date())}`
    yield* fs.writeFile(logFilePath, "")

    const completionEffect = Effect.gen(function* () {
      let status: PrerequisitesStatus = "fail"
      let outputs: Record<string, string> | null = null
      let log: readonly LogEntry[]

      const parsed = parsePrerequisitesSpec(yamlText)
      if (!parsed.ok) {
        log = [{ level: "ERROR", text: parsed.error }]
      } else {
        const checked = yield* Effect.result(checkPrerequisites(parsed.spec, session, refreshPath))
        if (Result.isFailure(checked)) {
          log = [lookupFailedLog(runFailure(checked.failure, LOOKUP_TIMEOUT_MS))]
        } else {
          status = prerequisitesStatus(parsed.spec, checked.success.results)
          outputs = prerequisitesOutputs(checked.success.results)
          log = checked.success.log
        }
      }

      const at = new Date()
      const lines = log.map(({ level, text }) => tagLogLine(text, level, at))
      // Best-effort, like the spawner's writes to a script's log file.
      yield* fs
        .writeFile(logFilePath, lines.map((line) => `${line}\n`).join(""))
        .pipe(Effect.ignore)

      const timestamp = at.toISOString()
      const events: ExecEvent[] = lines.map((line) => ({ _tag: "log", event: { line, timestamp } }))
      events.push({ _tag: "status", event: { status, exitCode: statusExitCode(status) } })
      if (outputs) events.push({ _tag: "outputs", event: { outputs } })
      events.push({ _tag: "done" })
      return events
    })

    return { logStream: Stream.empty, completionEffect, logFilePath }
  })
