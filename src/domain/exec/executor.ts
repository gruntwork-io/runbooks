/**
 * Script execution orchestration.
 */
import { Effect, Ref, Stream } from "effect"
import { FileSystem } from "../../services/FileSystem.ts"
import { ProcessSpawner } from "../../services/ProcessSpawner.ts"
import { Environment } from "../../services/Environment.ts"
import { ExecEnvOverrideError, ExecTimeoutError } from "../../errors/index.ts"
import { buildFileTree } from "../workspace/file-tree.ts"
import { disallowedEnvVars } from "./authEnv.ts"
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
  resolveScriptRunner,
  parseBlockOutputs,
  parseRunbookEnv,
  captureFilesFromDir,
} from "./script.ts"
import type { ScriptSetup, ScriptSource } from "./script.ts"
import { LOG_CHANNELS, logChannelFiles, tagLogLine } from "./logChannels.ts"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default execution timeout in milliseconds (60 minutes). A backstop for hung
 * scripts, not a budget: long terragrunt/tofu applies must not be killed by
 * default. Overridable per-request via `ExecRequest.timeoutMs`.
 */
const DEFAULT_EXEC_TIMEOUT_MS = 60 * 60 * 1000

/** The directories a run uses. */
export interface ExecDirs {
  /** The active git worktree, given to the script as REPO_FILES, or "" for none. */
  readonly workTree: string
  /** Where the files the script writes to GENERATED_FILES are copied. */
  readonly generated: string
  /** Where the run's log file is written, kept after the run. */
  readonly logs: string
  /** Where the script file is written for the run, and removed after it. */
  readonly scripts: string
}

// ---------------------------------------------------------------------------
// Execution Event Types
// ---------------------------------------------------------------------------

export type ExecEvent =
  | { readonly _tag: "log"; readonly event: ExecLogEvent }
  | { readonly _tag: "status"; readonly event: ExecStatusEvent }
  | { readonly _tag: "outputs"; readonly event: BlockOutputsEvent }
  | { readonly _tag: "files_captured"; readonly event: FilesCapturedEvent }
  | { readonly _tag: "session_env"; readonly env: Record<string, string> }
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
  sessionEnvFile: string,
  filesDir: string,
  workTreePath: string,
  logFiles: ReadonlyArray<{ readonly envVar: string; readonly path: string }>,
): Record<string, string> {
  const result = { ...env }
  result["RUNBOOK_OUTPUT"] = outputFile
  result["RUNBOOK_ENV"] = sessionEnvFile
  result["GENERATED_FILES"] = filesDir
  if (workTreePath) {
    result["REPO_FILES"] = workTreePath
  }
  for (const { envVar, path } of logFiles) {
    result[envVar] = path
  }
  return result
}

/**
 * The env a run gets from the session's: the session's own, with the app's
 * PATH when the session has none (a script unset it), so the run can still
 * find bash and its tools.
 */
export const withSystemPath = (sessionEnv: Record<string, string>) =>
  Effect.gen(function* () {
    const env = { ...sessionEnv }
    if (!env["PATH"]) {
      const systemPath = yield* (yield* Environment).get("PATH")
      if (systemPath) env["PATH"] = systemPath
    }
    return env
  })

// ---------------------------------------------------------------------------
// Exit Status
// ---------------------------------------------------------------------------

/**
 * The name of a run's log file: when it started, sortable, plus a random
 * suffix so two runs started in the same millisecond get files of their own.
 */
export function logFileName(startedAt: Date): string {
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-")
  return `${stamp}-${Math.random().toString(36).slice(2, 8)}.log`
}

/**
 * Determine exit status from exit code.
 * Exit code 0 = success, code 2 = warn, anything else = fail.
 * Timeout is always fail with exit code -1.
 */
function determineExitStatus(exitCode: number, timedOut: boolean): ExecStatusEvent {
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
 * outputs, captured files, the variables it set for the session, and done).
 *
 * The script's env is the session's, then the request's overrides (auth
 * blocks' credentials), then `blockEnv` (the block's rendered `env` prop),
 * then the variables Runbooks sets for every run (RUNBOOK_OUTPUT, ...). It
 * runs in `sessionContext.workDir`, with the interpreter `source` and the
 * script's shebang pick (see resolveScriptRunner).
 *
 * The caller is responsible for:
 *  - Resolving the Executable and rendering its `env` and `workingDir` props
 *  - Providing the session execution context (env, workDir)
 *  - Consuming the returned Stream and relaying events to the client (SSE, IPC, etc.)
 *
 * The run's full log is written to a new file in `dirs.logs`, created if it
 * is missing, and kept after the run. Temp files are cleaned up automatically
 * via Effect Scope finalizers.
 */
export const executeScript = (
  scriptContent: string,
  source: ScriptSource,
  request: ExecRequest,
  sessionContext: SessionExecContext,
  dirs: ExecDirs,
  blockEnv: Readonly<Record<string, string>> = {},
) =>
  Effect.gen(function* () {
    // The overrides are an auth block's vars for this run only (see
    // authEnv.ts). Refuse any other name before anything is created, so no
    // caller can set PATH, BASH_ENV, LD_PRELOAD or a runbook-managed var.
    const refused = disallowedEnvVars(request.envVarsOverride ?? {})
    if (refused.length > 0) {
      return yield* new ExecEnvOverrideError({
        names: refused,
        message: `Refused to run with env vars that no auth block passes: ${refused.join(", ")}`,
      })
    }

    log.debug("step 1: getting services")
    const fs = yield* FileSystem
    const spawner = yield* ProcessSpawner

    log.debug("step 2: creating output temp dir")
    // The files the script writes its outputs (RUNBOOK_OUTPUT) and its
    // variables for the session (RUNBOOK_ENV) to
    const outputDir = yield* fs.mkdtemp("runbook-output-")
    const outputFilePath = `${outputDir}/output.txt`
    yield* fs.writeFile(outputFilePath, "")
    const sessionEnvFilePath = `${outputDir}/env.txt`
    yield* fs.writeFile(sessionEnvFilePath, "")
    yield* Effect.addFinalizer(() =>
      fs.rm(outputDir, { recursive: true, force: true }).pipe(Effect.ignore),
    )

    log.debug("step 3: creating files temp dir")
    // Create temp directory for file capture (GENERATED_FILES)
    const filesDir = yield* fs.mkdtemp("runbook-files-")
    yield* Effect.addFinalizer(() =>
      fs.rm(filesDir, { recursive: true, force: true }).pipe(Effect.ignore),
    )

    log.debug("step 3a: creating log channel files")
    // The script's log files, one per level (RUNBOOK_INFO_LOG, ...). The
    // spawner follows them into the log stream and the run's log file. Once
    // the run ends they're deleted.
    const logChannelDir = yield* fs.mkdtemp("runbook-log-channels-")
    yield* Effect.addFinalizer(() =>
      fs.rm(logChannelDir, { recursive: true, force: true }).pipe(Effect.ignore),
    )
    const logFiles = logChannelFiles(logChannelDir, LOG_CHANNELS)
    for (const { path } of logFiles) {
      yield* fs.writeFile(path, "")
    }

    log.debug("step 3b: creating log file")
    // The spawner appends every output line here as it runs, so the file can
    // be tailed while the script runs and opened after it. Unlike the dirs
    // above, it has no cleanup finalizer: it outlives the run.
    yield* fs.mkdir(dirs.logs, { recursive: true })
    const logFilePath = `${dirs.logs}/${logFileName(new Date())}`
    yield* fs.writeFile(logFilePath, "")

    const effectiveTimeoutMs = request.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS

    // Build the execution environment
    let execEnv: Record<string, string> = yield* withSystemPath(sessionContext.env)

    // Apply per-request env var overrides, checked above
    if (request.envVarsOverride && Object.keys(request.envVarsOverride).length > 0) {
      execEnv = { ...execEnv, ...request.envVarsOverride }
    }
    execEnv = { ...execEnv, ...blockEnv }

    // Ends the run before the spawn, with `line` as its only log line
    const failBeforeSpawn = (line: string) =>
      Effect.gen(function* () {
        yield* fs.writeFile(logFilePath, `${line}\n`).pipe(Effect.ignore)
        return {
          logStream: Stream.empty,
          completionEffect: Effect.succeed<ExecEvent[]>([
            { _tag: "log", event: { line, timestamp: new Date().toISOString() } },
            { _tag: "status", event: { status: "fail", exitCode: 1 } },
            { _tag: "done" },
          ]),
          logFilePath,
        }
      })

    const runner = resolveScriptRunner(scriptContent, source, process.platform)
    if (!runner.ok) {
      return yield* failBeforeSpawn(runner.error)
    }

    // Spawning in a missing directory fails as `spawn bash ENOENT`, which
    // names the interpreter, not the directory
    const workDirStat = yield* fs.stat(sessionContext.workDir).pipe(Effect.option)
    if (workDirStat._tag === "None" || !workDirStat.value.isDirectory) {
      log.debug("aborting before spawn: missing working directory", sessionContext.workDir)
      return yield* failBeforeSpawn(`Working directory does not exist: ${sessionContext.workDir}`)
    }

    // A credential path that no longer exists is worth failing on BEFORE the
    // spawn. Every Google client library and the gcloud CLI report it as
    // "Failed to load credential file", naming a temp directory the user never
    // created and cannot inspect — it reads as a cloud-side outage when the
    // cause is always local: an auth block published a path that was superseded
    // before this step ran. Checked here rather than in the auth block because
    // this is the last point that knows which file the child will actually get.
    const credentialsPath = execEnv["GOOGLE_APPLICATION_CREDENTIALS"]
    if (credentialsPath && !(yield* fs.exists(credentialsPath))) {
      log.debug("aborting before spawn: missing credential file", credentialsPath)
      return yield* failBeforeSpawn(
        `Google credentials file no longer exists: ${credentialsPath}\n` +
          `The GoogleAuth block this step references has replaced or released it. ` +
          `Re-authenticate that block, wait for its success card, then run this step again.`,
      )
    }

    // Add standard runbook env vars (RUNBOOK_OUTPUT, RUNBOOK_ENV,
    // GENERATED_FILES, REPO_FILES, and the log files, RUNBOOK_<LEVEL>_LOG)
    execEnv = setupExecEnvVars(
      execEnv,
      outputFilePath,
      sessionEnvFilePath,
      filesDir,
      dirs.workTree,
      logFiles,
    )

    log.debug("step 4: writing script")
    const scriptSetup: ScriptSetup = yield* prepareScript(scriptContent, runner, dirs.scripts)

    log.debug("step 5: spawning process:", scriptSetup.command, scriptSetup.scriptPath)
    const child = yield* spawner.spawn(scriptSetup.command, scriptSetup.args, {
      cwd: sessionContext.workDir,
      env: execEnv,
      logFilePath,
      // Each line is tagged with its file's level and the time it was read
      logChannels: logFiles.map(({ path, level }) => ({
        path,
        formatLine: (line: string) => tagLogLine(line, level, new Date()),
      })),
    })

    // Kill the process group when the scope closes. `kill` is a no-op once the
    // process has closed, so in practice this only acts on interruption (Stop,
    // or quitting mid-run); background jobs a finished script left running
    // survive.
    yield* Effect.addFinalizer(() => child.kill.pipe(Effect.ignore))

    // Timeout watchdog, armed at spawn. It races the timeout against the real
    // exit, so it ends when the process closes and can never flag or signal a
    // run that already finished. The flag is set before the kill, and exitCode
    // resolves only once the killed process closes, so completionEffect always
    // sees it. The kill also ends `output`, which unblocks the log drain.
    const timedOutRef = yield* Ref.make(false)
    yield* child.exitCode.pipe(
      Effect.timeoutOrElse({
        duration: effectiveTimeoutMs,
        orElse: () => Effect.fail(new ExecTimeoutError({ timeoutMs: effectiveTimeoutMs })),
      }),
      Effect.catchTag("ExecTimeoutError", () =>
        Ref.set(timedOutRef, true).pipe(Effect.andThen(child.kill)),
      ),
      Effect.forkScoped,
    )

    log.debug("step 6: building streams")
    // Stream log lines from process output in real-time
    const logStream = Stream.map(
      child.output,
      (outputLine): Extract<ExecEvent, { _tag: "log" }> => ({
        _tag: "log",
        event: {
          line: outputLine.line,
          timestamp: new Date().toISOString(),
          replace: false,
        },
      }),
    )

    // Build completion events as an Effect that runs after logs drain.
    // We return logStream and completionEffect separately because
    // Stream.concat is unreliable within forkDetach + Effect.scoped —
    // the second stream's unwrap never executes after the first ends.
    const completionEffect = Effect.gen(function* () {
      const exitCode = yield* child.exitCode
      const timedOut = yield* Ref.get(timedOutRef)

      const statusEvent = determineExitStatus(exitCode, timedOut)
      const isSuccessOrWarn = statusEvent.status === "success" || statusEvent.status === "warn"

      const events: ExecEvent[] = []

      if (timedOut) {
        const line = `Script execution timed out after ${Math.round(effectiveTimeoutMs / 1000)} seconds`
        // Also end the log file with it, so the file says why the output
        // stops. Best-effort, like the spawner's own writes to it.
        yield* fs.appendFile(logFilePath, `${line}\n`).pipe(Effect.ignore)
        events.push({
          _tag: "log",
          event: { line, timestamp: new Date().toISOString() },
        })
      }

      // RUNBOOK_ENV is read before the status event so its problems log as
      // part of the run
      const sessionEnv = isSuccessOrWarn ? yield* parseRunbookEnv(sessionEnvFilePath) : null
      for (const line of sessionEnv?.problems ?? []) {
        yield* fs.appendFile(logFilePath, `${line}\n`).pipe(Effect.ignore)
        events.push({ _tag: "log", event: { line, timestamp: new Date().toISOString() } })
      }

      events.push({ _tag: "status", event: statusEvent })

      if (isSuccessOrWarn) {
        const outputs = yield* parseBlockOutputs(outputFilePath)
        if (Object.keys(outputs).length > 0) {
          events.push({ _tag: "outputs", event: { outputs } })
        }
      }

      if (sessionEnv) {
        events.push({ _tag: "session_env", env: sessionEnv.env })
      }

      if (isSuccessOrWarn) {
        const capturedFiles: CapturedFile[] = yield* captureFilesFromDir(
          filesDir,
          dirs.generated,
        ).pipe(Effect.catch(() => Effect.succeed([] as CapturedFile[])))

        if (capturedFiles.length > 0) {
          // Send the whole generated-files tree, built the way
          // boilerplate:render builds it, so the Generated panel shows the
          // captured files. A failed walk must not fail a successful run; the
          // event then carries no tree and the panel keeps what it had.
          const built = yield* buildFileTree(dirs.generated).pipe(
            Effect.catch(() => Effect.succeed(null)),
          )
          events.push({
            _tag: "files_captured",
            event: {
              files: capturedFiles,
              count: capturedFiles.length,
              ...(built ? { fileTree: built.tree, ...built.meta } : {}),
            },
          })
        }
      }

      events.push({ _tag: "done" })

      return events
    })

    return { logStream, completionEffect, logFilePath }
  })
