/**
 * Script execution orchestration.
 */
import { Effect, Stream } from "effect"
import { FileSystem } from "../../services/FileSystem.ts"
import { ProcessSpawner } from "../../services/ProcessSpawner.ts"
import { Environment } from "../../services/Environment.ts"
import { ExecTimeoutError } from "../../errors/index.ts"
import { makeLogger } from "../../logger.ts"

const log = makeLogger("domain:exec")
import type {
  ExecRequest,
  ExecLogEvent,
  ExecStatusEvent,
  BlockOutputsEvent,
  FilesCapturedEvent,
  CapturedFile,
  SessionExecContext,
} from "../../types.ts"
import {
  prepareScript,
  parseBlockOutputs,
  parseEnvCapture,
  captureFilesFromDir,
} from "./script.ts"
import type { ScriptSetup } from "./script.ts"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default execution timeout in milliseconds (5 minutes). Overridable per-request via `ExecRequest.timeoutMs`. */
const DEFAULT_EXEC_TIMEOUT_MS = 5 * 60 * 1000

// ---------------------------------------------------------------------------
// Execution Event Types
// ---------------------------------------------------------------------------

export type ExecEvent =
  | { readonly _tag: "log"; readonly event: ExecLogEvent }
  | { readonly _tag: "status"; readonly event: ExecStatusEvent }
  | { readonly _tag: "outputs"; readonly event: BlockOutputsEvent }
  | { readonly _tag: "files_captured"; readonly event: FilesCapturedEvent }
  | { readonly _tag: "env_captured"; readonly env: Record<string, string>; readonly pwd: string }
  | { readonly _tag: "done" }

// ---------------------------------------------------------------------------
// Environment Variable Helpers
// ---------------------------------------------------------------------------

/**
 * Build the standard runbook-managed environment variables that are injected
 * into every script execution.
 */
function setupExecEnvVars(
  env: Record<string, string>,
  outputFile: string,
  filesDir: string,
  workTreePath: string,
): Record<string, string> {
  const result = { ...env }
  result["RUNBOOK_OUTPUT"] = outputFile
  result["GENERATED_FILES"] = filesDir
  if (workTreePath) {
    result["REPO_FILES"] = workTreePath
  }
  return result
}

// ---------------------------------------------------------------------------
// Exit Status
// ---------------------------------------------------------------------------

/**
 * Determine exit status from exit code.
 * Exit code 0 = success, code 2 = warn, anything else = fail.
 * Timeout is always fail with exit code -1.
 */
function determineExitStatus(
  exitCode: number,
  timedOut: boolean,
): ExecStatusEvent {
  if (timedOut) {
    return { status: "fail", exitCode: -1 }
  }
  switch (exitCode) {
    case 0:
      return { status: "success", exitCode: 0 }
    case 2:
      return { status: "warn", exitCode: 2 }
    default:
      return { status: "fail", exitCode }
  }
}

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

/**
 * Execute a script and return a Stream of execution events (log lines, status,
 * outputs, captured files, environment capture, and done).
 *
 * The caller is responsible for:
 *  - Resolving the Executable and rendering template variables before calling this
 *  - Providing the session execution context (env, workDir)
 *  - Consuming the returned Stream and relaying events to the client (SSE, IPC, etc.)
 *
 * Temp files are cleaned up automatically via Effect Scope finalizers.
 */
export const executeScript = (
  scriptContent: string,
  language: string,
  request: ExecRequest,
  sessionContext: SessionExecContext,
  workTreePath: string,
  outputPath: string,
) =>
  Effect.gen(function* () {
    log.debug("step 1: getting services")
    const fs = yield* FileSystem
    const spawner = yield* ProcessSpawner
    const env = yield* Environment

    log.debug("step 2: creating output temp dir")
    // Create temp file for block outputs (RUNBOOK_OUTPUT)
    const outputDir = yield* fs.mkdtemp("runbook-output-")
    const outputFilePath = `${outputDir}/output.txt`
    yield* fs.writeFile(outputFilePath, "")
    yield* Effect.addFinalizer(() =>
      fs.rm(outputDir, { recursive: true, force: true }).pipe(Effect.ignore),
    )

    log.debug("step 3: creating files temp dir")
    // Create temp directory for file capture (GENERATED_FILES)
    const filesDir = yield* fs.mkdtemp("runbook-files-")
    yield* Effect.addFinalizer(() =>
      fs.rm(filesDir, { recursive: true, force: true }).pipe(Effect.ignore),
    )

    log.debug("step 3b: creating log file")
    // Create a durable log file for this execution. The spawner appends every
    // stdout/stderr line here as it runs, so the file can be tailed externally
    // and inspected after the fact. NOTE: unlike the dirs above, we intentionally
    // do NOT register a cleanup finalizer — the file must outlive the execution
    // so the user can open it from the surfaced path. These live under the OS
    // temp dir, which the OS reclaims on its own schedule.
    const logsDir = yield* fs.mkdtemp("runbook-logs-")
    const logFilePath = `${logsDir}/exec.log`
    yield* fs.writeFile(logFilePath, "")

    const effectiveTimeoutMs = request.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS

    log.debug("step 4: preparing script")
    // Prepare script for execution (handles interpreter detection, env capture wrapping, temp files)
    const scriptSetup: ScriptSetup = yield* prepareScript(scriptContent, language)

    // Build the execution environment
    let execEnv: Record<string, string> = { ...sessionContext.env }

    // Ensure PATH is available
    if (!execEnv["PATH"]) {
      const systemPath = yield* env.get("PATH")
      if (systemPath) {
        execEnv["PATH"] = systemPath
      }
    }

    // Apply per-request env var overrides
    if (request.envVarsOverride && Object.keys(request.envVarsOverride).length > 0) {
      execEnv = { ...execEnv, ...request.envVarsOverride }
    }

    // Add standard runbook env vars (RUNBOOK_OUTPUT, GENERATED_FILES, REPO_FILES)
    execEnv = setupExecEnvVars(execEnv, outputFilePath, filesDir, workTreePath)

    const cmdArgs = [...scriptSetup.args, scriptSetup.scriptPath]

    log.debug("step 5: spawning process:", scriptSetup.interpreter, cmdArgs[cmdArgs.length - 1])
    const process = yield* spawner.spawn(scriptSetup.interpreter, cmdArgs, {
      cwd: sessionContext.workDir || undefined,
      env: execEnv,
      logFilePath,
    })

    // Kill the child process when the scope closes (e.g. on cancellation)
    yield* Effect.addFinalizer(() => process.kill.pipe(Effect.ignore))

    log.debug("step 6: building streams")
    // Stream log lines from process output in real-time
    const logStream = Stream.map(process.output, (outputLine): Extract<ExecEvent, { _tag: "log" }> => ({
      _tag: "log",
      event: {
        line: outputLine.line,
        timestamp: new Date().toISOString(),
        replace: false,
      },
    }))

    // Build completion events as an Effect that runs after logs drain.
    // We return logStream and completionEffect separately because
    // Stream.concat is unreliable within forkDaemon + Effect.scoped —
    // the second stream's unwrap never executes after the first ends.
    const completionEffect = Effect.gen(function* () {
      const exitResult = yield* process.exitCode.pipe(
        Effect.timeoutFail({
          duration: effectiveTimeoutMs,
          onTimeout: () => new ExecTimeoutError({ timeoutMs: effectiveTimeoutMs }),
        }),
        Effect.either,
      )

      const timedOut = exitResult._tag === "Left" && exitResult.left._tag === "ExecTimeoutError"
      const exitCode = exitResult._tag === "Right" ? exitResult.right : -1

      if (timedOut) {
        yield* process.kill.pipe(Effect.ignore)
      }

      const statusEvent = determineExitStatus(exitCode, timedOut)
      const isSuccessOrWarn = statusEvent.status === "success" || statusEvent.status === "warn"

      const events: ExecEvent[] = []

      if (timedOut) {
        events.push({
          _tag: "log",
          event: {
            line: `Script execution timed out after ${Math.round(effectiveTimeoutMs / 1000)} seconds`,
            timestamp: new Date().toISOString(),
          },
        })
      }

      events.push({ _tag: "status", event: statusEvent })

      if (isSuccessOrWarn) {
        const outputs = yield* parseBlockOutputs(outputFilePath)
        if (Object.keys(outputs).length > 0) {
          events.push({ _tag: "outputs", event: { outputs } })
        }
      }

      if (isSuccessOrWarn && scriptSetup.isBashScript) {
        const captured = yield* parseEnvCapture(
          scriptSetup.envCapturePath,
          scriptSetup.pwdCapturePath,
        )
        if (captured.env) {
          events.push({
            _tag: "env_captured",
            env: captured.env,
            pwd: captured.pwd,
          })
        }
      }

      if (isSuccessOrWarn) {
        const capturedFiles: CapturedFile[] = yield* captureFilesFromDir(
          filesDir,
          outputPath,
        ).pipe(Effect.catchAll(() => Effect.succeed([] as CapturedFile[])))

        if (capturedFiles.length > 0) {
          events.push({
            _tag: "files_captured",
            event: {
              files: capturedFiles,
              count: capturedFiles.length,
              fileTree: null,
            },
          })
        }
      }

      events.push({ _tag: "done" })

      return events
    })

    return { logStream, completionEffect, logFilePath }
  })
