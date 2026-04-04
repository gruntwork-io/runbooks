/**
 * Script execution orchestration.
 * Port of api/exec.go and api/exec_stream.go.
 */
import { Effect, Stream } from "effect"
import { FileSystem } from "../../services/FileSystem.ts"
import { ProcessSpawner } from "../../services/ProcessSpawner.ts"
import { Environment } from "../../services/Environment.ts"
import { ExecTimeoutError } from "../../errors/index.ts"
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

/** Execution timeout in milliseconds (5 minutes). */
const EXEC_TIMEOUT_MS = 5 * 60 * 1000

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

/**
 * Merge per-request env var overrides into a base env record.
 * Override values replace any existing keys in the base record.
 */
function mergeEnvVars(
  base: Record<string, string>,
  overrides: Record<string, string>,
): Record<string, string> {
  return { ...base, ...overrides }
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
    const fs = yield* FileSystem
    const spawner = yield* ProcessSpawner
    const env = yield* Environment

    // Create temp file for block outputs (RUNBOOK_OUTPUT)
    const outputDir = yield* fs.mkdtemp("runbook-output-")
    const outputFilePath = `${outputDir}/output.txt`
    yield* fs.writeFile(outputFilePath, "")
    yield* Effect.addFinalizer(() =>
      fs.rm(outputDir, { recursive: true, force: true }).pipe(Effect.ignore),
    )

    // Create temp directory for file capture (GENERATED_FILES)
    const filesDir = yield* fs.mkdtemp("runbook-files-")
    yield* Effect.addFinalizer(() =>
      fs.rm(filesDir, { recursive: true, force: true }).pipe(Effect.ignore),
    )

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
      execEnv = mergeEnvVars(execEnv, request.envVarsOverride)
    }

    // Add standard runbook env vars (RUNBOOK_OUTPUT, GENERATED_FILES, REPO_FILES)
    execEnv = setupExecEnvVars(execEnv, outputFilePath, filesDir, workTreePath)

    // Build command arguments: [...interpreterArgs, scriptPath]
    const cmdArgs = [...scriptSetup.args, scriptSetup.scriptPath]

    // Spawn the process
    const process = yield* spawner.spawn(scriptSetup.interpreter, cmdArgs, {
      cwd: sessionContext.workDir || undefined,
      env: execEnv,
    })

    // Phase 1: Stream log lines from process output
    const logStream = Stream.map(process.output, (outputLine): ExecEvent => ({
      _tag: "log",
      event: {
        line: outputLine.line,
        timestamp: new Date().toISOString(),
        replace: false,
      },
    }))

    // Phase 2: After output stream completes, handle completion (exit status,
    // block outputs, env capture, file capture)
    const completionStream = Stream.unwrap(
      Effect.gen(function* () {
        // Wait for the process to exit, with a timeout
        const exitResult = yield* process.exitCode.pipe(
          Effect.timeoutFail({
            duration: EXEC_TIMEOUT_MS,
            onTimeout: () => new ExecTimeoutError({ timeoutMs: EXEC_TIMEOUT_MS }),
          }),
          Effect.either,
        )

        // Determine if we timed out
        const timedOut = exitResult._tag === "Left" && exitResult.left._tag === "ExecTimeoutError"
        const exitCode = exitResult._tag === "Right" ? exitResult.right : -1

        // If timed out, kill the process
        if (timedOut) {
          yield* process.kill.pipe(Effect.ignore)
        }

        const statusEvent = determineExitStatus(exitCode, timedOut)
        const isSuccessOrWarn = statusEvent.status === "success" || statusEvent.status === "warn"

        const completionEvents: ExecEvent[] = []

        // Add timeout log message if applicable
        if (timedOut) {
          completionEvents.push({
            _tag: "log",
            event: {
              line: `Script execution timed out after ${EXEC_TIMEOUT_MS / 1000 / 60} minutes`,
              timestamp: new Date().toISOString(),
            },
          })
        }

        // Add status event
        completionEvents.push({ _tag: "status", event: statusEvent })

        // Parse and emit block outputs on success/warn
        if (isSuccessOrWarn) {
          const outputs = yield* parseBlockOutputs(outputFilePath)
          if (Object.keys(outputs).length > 0) {
            completionEvents.push({
              _tag: "outputs",
              event: { outputs },
            })
          }
        }

        // Capture environment changes from bash scripts
        if (isSuccessOrWarn && scriptSetup.isBashScript) {
          const captured = yield* parseEnvCapture(
            scriptSetup.envCapturePath,
            scriptSetup.pwdCapturePath,
          )
          if (captured.env) {
            completionEvents.push({
              _tag: "env_captured",
              env: captured.env,
              pwd: captured.pwd,
            })
          }
        }

        // Capture files from GENERATED_FILES directory
        if (isSuccessOrWarn) {
          const capturedFiles: CapturedFile[] = yield* captureFilesFromDir(
            filesDir,
            outputPath,
          ).pipe(Effect.catchAll(() => Effect.succeed([] as CapturedFile[])))

          if (capturedFiles.length > 0) {
            completionEvents.push({
              _tag: "files_captured",
              event: {
                files: capturedFiles,
                count: capturedFiles.length,
                fileTree: null,
              },
            })
          }
        }

        // Done event
        completionEvents.push({ _tag: "done" })

        return Stream.fromIterable(completionEvents)
      }),
    )

    return Stream.concat(logStream, completionStream)
  })
