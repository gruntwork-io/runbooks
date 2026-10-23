/**
 * IPC handler for script execution with streaming.
 *
 * Runs a script via the executeScript Effect and streams its logs to the
 * renderer process via event.sender.send(). The handler returns the final
 * status and the script's outputs together when execution completes.
 *
 * A <Prerequisites> block runs through here too: its registry entry holds a
 * tool list, which executePrerequisites checks in place of a script.
 */
import * as nodePath from "node:path"
import { Effect, Stream } from "effect"
import { ipcMain } from "electron"
import { runtime, sessionManager, executableRegistry } from "./runtime.ts"
import { resolveGeneratedDir, resolveRunLogsDir } from "./path-guard.ts"
import { executeScript } from "../../../src/domain/exec/executor.ts"
import { executePrerequisites } from "../../../src/domain/prerequisites/check.ts"
import { appendPathEntries, filterCapturedEnv } from "../../../src/domain/session/manager.ts"
import { renderBlockEnv, renderScriptForExec } from "../../../src/domain/exec/render.ts"
import type { ExecRequest, ExecStatusEvent } from "../../../src/types.ts"
import { encodeOutputs, type OutputValues } from "../../../src/domain/exec/outputValues.ts"
import { PathRefreshError } from "../../../src/errors/index.ts"
import { errorMessage } from "../../../src/errors/message.ts"
import type { IpcEventMap } from "../../shared/channels.ts"
import { readLoginShellPath } from "../shell-env.ts"
import { makeLogger } from "../logger.ts"

const log = makeLogger("ipc:exec")

type ExecEventChannel = Extract<keyof IpcEventMap, `exec:${string}`>

// ---------------------------------------------------------------------------
// Active execution tracking for cancellation support
// ---------------------------------------------------------------------------

// Active executions keyed by the renderer-supplied executionId, so a later
// exec:cancel can interrupt a *specific* run. Aborting a controller interrupts
// the Effect fiber (the signal is passed to runPromise below), which closes the
// execution scope and runs the child-process kill finalizer in executor.ts.
// `done` settles once that has happened, so quit can wait for it.
const activeExecutions = new Map<string, { controller: AbortController; done: Promise<unknown> }>()
// Fallback target for exec:cancel calls that don't name an executionId.
let mostRecentExecutionId: string | null = null
// Counter for synthesizing an id when a caller doesn't supply one.
let execSeq = 0

function abortExecution(id: string): boolean {
  const execution = activeExecutions.get(id)
  if (!execution) return false
  execution.controller.abort()
  activeExecutions.delete(id)
  if (mostRecentExecutionId === id) mostRecentExecutionId = null
  return true
}

/** Whether a script is running. exec:run runs one at a time. */
export function isExecutionRunning(): boolean {
  return activeExecutions.size > 0
}

/**
 * Cancel every running execution and wait until each has been interrupted,
 * i.e. its kill finalizer has sent SIGTERM to the script's process group.
 * Called on quit and before switching sessions: scripts run detached, so
 * nothing else stops them.
 */
export async function cancelAllExecutions(): Promise<void> {
  const pending = [...activeExecutions.values()]
  for (const { controller } of pending) controller.abort()
  await Promise.allSettled(pending.map((e) => e.done))
}

/**
 * Read PATH again from the user's login shell, for a <Prerequisites> check
 * that can't find a tool. Its directories go on the end of process.env's PATH,
 * which sessions opened later start from, and of the live session's (unless
 * `generation` no longer names it), skipping those already there.
 */
const refreshPath = (generation: number) =>
  Effect.gen(function* () {
    const login = yield* Effect.tryPromise({
      try: () => readLoginShellPath(),
      catch: (err) => new PathRefreshError({ message: errorMessage(err) }),
    })
    const entries = login.path.split(nodePath.delimiter)
    const { path, added } = appendPathEntries(process.env.PATH ?? "", entries, nodePath.delimiter)
    process.env.PATH = path
    if (added.length > 0) log.info(`Added to PATH from ${login.shell}:`, added.join(", "))
    // The session is gone only if a different runbook opened mid-check.
    yield* sessionManager.appendToPath(entries, nodePath.delimiter, generation).pipe(Effect.ignore)
    return { source: `your login shell (${login.shell})`, entries }
  })

export function registerExecHandlers(): void {
  ipcMain.handle("exec:run", async (event, params: ExecRequest) => {
    log.debug("handler called for:", params.executableId)
    const executionId = params.executionId ?? `main-${++execSeq}`
    // The entry below would replace a run still registered under this id and
    // leave it unreachable by Stop and by quit.
    abortExecution(executionId)
    const abortController = new AbortController()
    mostRecentExecutionId = executionId

    // Every event names its run, since several runs stream to one renderer.
    // Interruption takes effect at the fiber's next yield point, so an aborted
    // run can still reach a send.
    const send = (channel: ExecEventChannel, payload: object) => {
      if (abortController.signal.aborted) return
      event.sender.send(channel, { ...payload, executionId })
    }

    try {
      // Run execution directly (no forkDetach). The IPC handler awaits
      // the result, which is exactly the same as forkDetach + Fiber.await
      // but without the scope/fiber lifecycle issues that caused hangs.
      //
      // The abort signal is passed to runPromise: when exec:cancel aborts it,
      // Effect interrupts this fiber, which closes the scope and runs the
      // process.kill finalizer (executor.ts) — that's what actually stops the
      // running child (and its process group).
      const run = runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            // Get execution context from the session
            const context = yield* sessionManager.getExecContext()

            if (!executableRegistry) {
              throw new Error("No runbook loaded")
            }

            const executableId = params.executableId ?? ""
            const executable = yield* executableRegistry.getExecutable(executableId)
            const isPrerequisites = executable.componentType === "prerequisites"

            // Render template variables using the Go template engine. Values
            // go in verbatim and a template error fails the run (see
            // renderScriptForExec).
            let scriptContent = executable.content
            if (params.templateVarValues && !isPrerequisites) {
              scriptContent = yield* renderScriptForExec(
                scriptContent,
                params.templateVarValues as Record<string, unknown>,
              )
            }

            // The block's `env` prop, from the registry's copy of the runbook,
            // rendered with the same values. They reach the script as env
            // vars, so nothing in them is parsed as shell.
            const blockEnv = yield* renderBlockEnv(
              executable.env,
              (params.templateVarValues ?? {}) as Record<string, unknown>,
            )

            const workTreePath = sessionManager.getActiveWorkTreePath()
            const outputPath = (yield* resolveGeneratedDir()).absolutePath
            const logsDir = yield* resolveRunLogsDir(executable.componentId)

            // Execute the script, or check the tools — returns log stream +
            // completion effect
            const { logStream, completionEffect, logFilePath } = isPrerequisites
              ? yield* executePrerequisites(
                  scriptContent,
                  context,
                  logsDir,
                  refreshPath(context.generation),
                )
              : yield* executeScript(
                  scriptContent,
                  executable.language,
                  params,
                  context,
                  workTreePath,
                  outputPath,
                  logsDir,
                  blockEnv,
                )

            // Surface the on-disk log path up front so the UI can offer it
            // (e.g. a "copy log path" action) while the script is still running.
            send("exec:log-file", { path: logFilePath })

            // Phase 1: Stream log events to renderer in real-time
            log.debug("Phase 1: starting log stream drain")
            yield* Stream.runForEach(logStream, (logEvent) =>
              Effect.sync(() => {
                send("exec:log", logEvent.event)
              }),
            )
            log.debug("Phase 1 complete, starting Phase 2")

            // Phase 2: After logs drain, run completion
            let finalStatus: ExecStatusEvent | null = null
            let outputs: OutputValues = {}
            const completionEvents = yield* completionEffect
            log.debug("Phase 2 complete, got", completionEvents.length, "events")

            for (const execEvent of completionEvents) {
              if (abortController.signal.aborted) break
              switch (execEvent._tag) {
                case "log":
                  send("exec:log", execEvent.event)
                  break
                case "status":
                  finalStatus = execEvent.event
                  break
                case "outputs":
                  outputs = execEvent.event.outputs
                  break
                case "files_captured":
                  send("exec:files-captured", execEvent.event)
                  break
                case "env_captured": {
                  // Applied as a delta against the env the script started
                  // with, not a replacement: auth blocks may have written to
                  // the session while the script ran (see applyCapturedEnv).
                  // That start env is the session snapshot plus this run's
                  // block-scoped overrides (awsAuthId, githubAuthId, ...) and
                  // `env` prop, filtered like the capture. Otherwise the
                  // per-run credentials and variables read as exports and
                  // land in the session, and keys the filter drops (BASH_*,
                  // SHLVL, ...) read as unsets and are deleted from it.
                  yield* sessionManager.applyCapturedEnv({
                    before: filterCapturedEnv({
                      ...context.env,
                      ...params.envVarsOverride,
                      ...blockEnv,
                    }),
                    after: filterCapturedEnv(execEvent.env),
                    startWorkDir: context.workDir,
                    pwd: execEvent.pwd,
                    generation: context.generation,
                  })
                  break
                }
                case "done":
                  break
              }
            }

            log.debug("execution complete, status:", finalStatus?.status)
            if (!finalStatus) return { status: null }
            // The status and the outputs go back in one reply. Sent as
            // separate events, the renderer can see a finished run before its
            // outputs and take it for a run that published none.
            return { status: finalStatus, outputs: encodeOutputs(outputs) }
          }),
        ),
        { signal: abortController.signal },
      )
      activeExecutions.set(executionId, { controller: abortController, done: run.catch(() => {}) })
      return await run
    } catch (err) {
      log.debug("caught error:", err)
      if (abortController.signal.aborted) {
        return { status: null, cancelled: true }
      }
      throw err
    } finally {
      // Only remove our own entry. Renderer execution ids restart after a
      // reload, so a newer run may already be registered under this id, and
      // deleting it would leave that run unreachable by Stop and by quit.
      if (activeExecutions.get(executionId)?.controller === abortController) {
        activeExecutions.delete(executionId)
        if (mostRecentExecutionId === executionId) mostRecentExecutionId = null
      }
    }
  })

  ipcMain.handle("exec:cancel", async (_event, params?: { executionId?: string }) => {
    // Target a specific run when named; otherwise fall back to the most recent.
    const id = params?.executionId ?? mostRecentExecutionId
    if (id) abortExecution(id)
    return { ok: true as const }
  })
}
