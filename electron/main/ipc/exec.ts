/**
 * IPC handler for script execution with streaming.
 *
 * Runs a script via the executeScript Effect, then forwards events to the
 * renderer process via event.sender.send(). The handler returns the final
 * status when execution completes.
 */
import { Effect, Stream, Fiber, Exit, Cause } from "effect"
import { ipcMain } from "electron"
import {
  runtime,
  sessionManager,
  executableRegistry,
  runbookConfig,
} from "./runtime.ts"
import { executeScript, type ExecEvent } from "../../../src/domain/exec/executor.ts"
import { filterCapturedEnv } from "../../../src/domain/session/manager.ts"
import { BoilerplateRenderer } from "../../../src/services/BoilerplateRenderer.ts"
import type { ExecRequest, ExecStatusEvent } from "../../../src/types.ts"

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
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
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

let activeAbortController: AbortController | null = null

export function registerExecHandlers(): void {
  ipcMain.handle(
    "exec:run",
    async (event, params: ExecRequest) => {
      // debugLog("[ipc:exec] handler called for:", params.executableId || params.componentId)
      // Cancel any existing execution
      if (activeAbortController) {
        activeAbortController.abort()
        activeAbortController = null
      }

      const abortController = new AbortController()
      activeAbortController = abortController

      try {
        // Run execution directly (no forkDaemon). The IPC handler awaits
        // the result, which is exactly the same as forkDaemon + Fiber.await
        // but without the scope/fiber lifecycle issues that caused hangs.
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
                const escapedVars = shellEscapeDeep(params.templateVarValues as Record<string, unknown>)
                scriptContent = yield* renderer.renderFile(scriptContent, escapedVars)
              }

              const workTreePath = sessionManager.getActiveWorkTreePath()
              const outputPath = runbookConfig.localPath
                ? runbookConfig.localPath.replace(/\/[^/]+$/, "/output")
                : ""

              // Execute the script — returns log stream + completion effect
              const { logStream, completionEffect } = yield* executeScript(
                scriptContent,
                executable.language,
                params,
                context,
                workTreePath,
                outputPath,
              )

              // Phase 1: Stream log events to renderer in real-time
              // debugLog("[exec] Phase 1: starting log stream drain")
              yield* Stream.runForEach(logStream, (logEvent) =>
                Effect.sync(() => {
                  if (!abortController.signal.aborted) {
                    event.sender.send("exec:log", logEvent.event)
                  }
                }),
              )
              // debugLog("[exec] Phase 1 complete, starting Phase 2")

              // Phase 2: After logs drain, run completion
              let finalStatus: ExecStatusEvent | null = null
              const completionEvents = yield* completionEffect
              // debugLog("[exec] Phase 2 complete, got", completionEvents.length, "events")

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

              // debugLog("[ipc:exec] execution complete, status:", finalStatus?.status)
              return { status: finalStatus }
            }),
          ),
        )
      } catch (err) {
        // debugLog("[ipc:exec] caught error:", err)
        if (abortController.signal.aborted) {
          return { status: null, cancelled: true }
        }
        throw err
      } finally {
        if (activeAbortController === abortController) {
          activeAbortController = null
        }
      }
    },
  )

  ipcMain.handle("exec:cancel", async () => {
    if (activeAbortController) {
      activeAbortController.abort()
      activeAbortController = null
    }
    return { ok: true as const }
  })
}
