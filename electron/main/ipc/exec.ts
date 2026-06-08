/**
 * IPC handler for script execution with streaming.
 *
 * Runs a script via the executeScript Effect, then forwards events to the
 * renderer process via event.sender.send(). The handler returns the final
 * status when execution completes.
 */
import { Effect, Stream } from "effect"
import { ipcMain } from "electron"
import {
  runtime,
  sessionManager,
  executableRegistry,
  runbookConfig,
} from "./runtime.ts"
import { executeScript } from "../../../src/domain/exec/executor.ts"
import { filterCapturedEnv } from "../../../src/domain/session/manager.ts"
import { BoilerplateRenderer } from "../../../src/services/BoilerplateRenderer.ts"
import { resolveInputTemplates } from "../../../src/domain/boilerplate/flattenInputs.ts"
import type { ExecRequest, ExecStatusEvent } from "../../../src/types.ts"
import { makeLogger } from "../logger.ts"

const log = makeLogger("ipc:exec")

// ---------------------------------------------------------------------------
// Shell escaping for template variable injection prevention
// ---------------------------------------------------------------------------

function shellEscape(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'"
}

/**
 * Recursively shell-escape all string leaf values in a nested object.
 * Non-string values (numbers, booleans, arrays, nested objects) are passed
 * through so the template engine can handle them (e.g. range, toJson).
 */
function shellEscapeDeep(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") {
      result[key] = shellEscape(value)
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) => {
        if (typeof item === "string") return shellEscape(item)
        if (item !== null && typeof item === "object") return shellEscapeDeep(item as Record<string, unknown>)
        return item
      })
    } else if (value !== null && typeof value === "object") {
      result[key] = shellEscapeDeep(value as Record<string, unknown>)
    } else {
      result[key] = value
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Active execution tracking for cancellation support
// ---------------------------------------------------------------------------

// Active executions keyed by the renderer-supplied executionId, so a later
// exec:cancel can interrupt a *specific* run. Aborting a controller interrupts
// the Effect fiber (the signal is passed to runPromise below), which closes the
// execution scope and runs the child-process kill finalizer in executor.ts.
const activeExecutions = new Map<string, AbortController>()
// Fallback target for exec:cancel calls that don't name an executionId.
let mostRecentExecutionId: string | null = null
// Counter for synthesizing an id when a caller doesn't supply one.
let execSeq = 0

function abortExecution(id: string): boolean {
  const controller = activeExecutions.get(id)
  if (!controller) return false
  controller.abort()
  activeExecutions.delete(id)
  if (mostRecentExecutionId === id) mostRecentExecutionId = null
  return true
}

export function registerExecHandlers(): void {
  ipcMain.handle(
    "exec:run",
    async (event, params: ExecRequest) => {
      log.debug("handler called for:", params.executableId || params.componentId)
      // Only one execution runs at a time: cancel (interrupt + kill) any others.
      for (const controller of activeExecutions.values()) controller.abort()
      activeExecutions.clear()

      const executionId = params.executionId ?? `main-${++execSeq}`
      const abortController = new AbortController()
      activeExecutions.set(executionId, abortController)
      mostRecentExecutionId = executionId

      try {
        // Run execution directly (no forkDaemon). The IPC handler awaits
        // the result, which is exactly the same as forkDaemon + Fiber.await
        // but without the scope/fiber lifecycle issues that caused hangs.
        //
        // The abort signal is passed to runPromise: when exec:cancel aborts it,
        // Effect interrupts this fiber, which closes the scope and runs the
        // process.kill finalizer (executor.ts) — that's what actually stops the
        // running child (and its process group). The signal.aborted checks below
        // are a belt-and-suspenders guard against a stray send in the small
        // window before interruption takes effect at the next yield point.
        return await runtime.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              // Get execution context from the session
              const context = yield* sessionManager.getExecContext()

              if (!executableRegistry) {
                throw new Error("No runbook loaded")
              }

              const executableId = params.executableId ?? params.componentId ?? ""
              const executable = yield* executableRegistry.getExecutable(executableId)

              // Render template variables using the Go template engine
              let scriptContent = executable.content
              if (params.templateVarValues) {
                const renderer = yield* BoilerplateRenderer
                const rawVars = params.templateVarValues as Record<string, unknown>

                // Resolve nested input templates first. An input value can itself
                // be a template — e.g. a Template block exposes
                //   LogsAccountEmail = "{{ .inputs.EmailUsername }}+logs@{{ .inputs.EmailDomainName }}"
                // via inputsId. A single renderFile pass would insert that value
                // verbatim, leaving the inner `{{ .inputs.* }}` unrendered. We
                // resolve the inputs namespace to a fixed point against the other
                // inputs/outputs first — mirroring what flattenVariables does for
                // the Template render path so exec and render behave identically.
                const rawInputs =
                  rawVars.inputs &&
                  typeof rawVars.inputs === "object" &&
                  !Array.isArray(rawVars.inputs)
                    ? (rawVars.inputs as Record<string, unknown>)
                    : {}
                const resolvedInputs = yield* resolveInputTemplates(
                  rawInputs,
                  rawVars.outputs,
                )
                const resolvedVars = { ...rawVars, inputs: resolvedInputs }

                const escapedVars = shellEscapeDeep(resolvedVars)
                scriptContent = yield* renderer.renderFile(scriptContent, escapedVars)
              }

              const workTreePath = sessionManager.getActiveWorkTreePath()
              const outputPath = runbookConfig.localPath
                ? runbookConfig.localPath.replace(/\/[^/]+$/, "/output")
                : ""

              // Execute the script — returns log stream + completion effect
              const { logStream, completionEffect, logFilePath } = yield* executeScript(
                scriptContent,
                executable.language,
                params,
                context,
                workTreePath,
                outputPath,
              )

              // Surface the on-disk log path up front so the UI can offer it
              // (e.g. a "copy log path" action) while the script is still running.
              if (!abortController.signal.aborted) {
                event.sender.send("exec:log-file", { path: logFilePath })
              }

              // Phase 1: Stream log events to renderer in real-time
              log.debug("Phase 1: starting log stream drain")
              yield* Stream.runForEach(logStream, (logEvent) =>
                Effect.sync(() => {
                  if (!abortController.signal.aborted) {
                    event.sender.send("exec:log", logEvent.event)
                  }
                }),
              )
              log.debug("Phase 1 complete, starting Phase 2")

              // Phase 2: After logs drain, run completion
              let finalStatus: ExecStatusEvent | null = null
              const completionEvents = yield* completionEffect
              log.debug("Phase 2 complete, got", completionEvents.length, "events")

              for (const execEvent of completionEvents) {
                if (abortController.signal.aborted) break
                switch (execEvent._tag) {
                  case "log":
                    event.sender.send("exec:log", execEvent.event)
                    break
                  case "status":
                    finalStatus = execEvent.event
                    event.sender.send("exec:status", execEvent.event)
                    break
                  case "outputs":
                    event.sender.send("exec:outputs", execEvent.event)
                    break
                  case "files_captured":
                    event.sender.send("exec:files-captured", execEvent.event)
                    break
                  case "env_captured": {
                    const filteredEnv = filterCapturedEnv(execEvent.env)
                    yield* sessionManager.updateSessionEnv(filteredEnv, execEvent.pwd)
                    break
                  }
                  case "done":
                    break
                }
              }

              log.debug("execution complete, status:", finalStatus?.status)
              return { status: finalStatus }
            }),
          ),
          { signal: abortController.signal },
        )
      } catch (err) {
        log.debug("caught error:", err)
        if (abortController.signal.aborted) {
          return { status: null, cancelled: true }
        }
        throw err
      } finally {
        activeExecutions.delete(executionId)
        if (mostRecentExecutionId === executionId) mostRecentExecutionId = null
      }
    },
  )

  ipcMain.handle("exec:cancel", async (_event, params?: { executionId?: string }) => {
    // Target a specific run when named; otherwise fall back to the most recent.
    const id = params?.executionId ?? mostRecentExecutionId
    if (id) abortExecution(id)
    return { ok: true as const }
  })
}
