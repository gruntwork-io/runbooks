/**
 * IPC handler for script execution with streaming.
 *
 * Runs a script via the executeScript Effect, then subscribes to the resulting
 * Stream of ExecEvents and forwards each event to the renderer process via
 * event.sender.send(). The handler returns the final status when the stream
 * completes.
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
import type { ExecRequest, ExecStatusEvent } from "../../../src/types.ts"

// ---------------------------------------------------------------------------
// Shell escaping for template variable injection prevention
// ---------------------------------------------------------------------------

function shellEscape(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'"
}

// ---------------------------------------------------------------------------
// Active execution fiber for cancellation support
// ---------------------------------------------------------------------------

let activeExecFiber: Fiber.RuntimeFiber<any, any> | null = null

export function registerExecHandlers(): void {
  ipcMain.handle(
    "exec:run",
    async (event, params: ExecRequest) => {
      // Cancel any existing execution
      if (activeExecFiber) {
        await runtime.runPromise(Fiber.interrupt(activeExecFiber)).catch(() => {})
        activeExecFiber = null
      }

      const fiber = await runtime.runPromise(
        Effect.fork(
          Effect.scoped(
            Effect.gen(function* () {
              // Get execution context from the session (no token needed for IPC)
              const context = yield* sessionManager.getExecContext()

              // Resolve the executable from the registry
              if (!executableRegistry) {
                throw new Error("No runbook loaded")
              }

              const executableId = params.executableId ?? params.componentId ?? ""
              const executable = yield* executableRegistry.getExecutable(executableId)

              // Render template variables into the script content with shell escaping
              let scriptContent = executable.content
              if (params.templateVarValues) {
                for (const [key, value] of Object.entries(params.templateVarValues)) {
                  const placeholder = `{{.${key}}}`
                  scriptContent = scriptContent.replaceAll(placeholder, shellEscape(String(value)))
                }
              }

              // Get the active worktree path for REPO_FILES
              const workTreePath = sessionManager.getActiveWorkTreePath()

              // Determine output path from runbook config
              const outputPath = runbookConfig.localPath
                ? runbookConfig.localPath.replace(/\/[^/]+$/, "/output")
                : ""

              // Execute the script and get the event stream
              const eventStream: Stream.Stream<ExecEvent, any, any> = yield* executeScript(
                scriptContent,
                executable.language,
                params,
                context,
                workTreePath,
                outputPath,
              )

              // Consume the stream, forwarding events to the renderer
              let finalStatus: ExecStatusEvent | null = null

              yield* Stream.runForEach(eventStream, (execEvent) =>
                Effect.gen(function* () {
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
                }),
              )

              return { status: finalStatus }
            }),
          ),
        ),
      )

      activeExecFiber = fiber

      const exit = await runtime.runPromise(Fiber.await(fiber))
      activeExecFiber = null

      if (exit._tag === "Failure" && Cause.isInterruptedOnly(exit.cause)) {
        return { status: null, cancelled: true }
      }

      return Exit.match(exit, {
        onSuccess: (value) => value,
        onFailure: (cause) => { throw Cause.squash(cause) },
      })
    },
  )

  ipcMain.handle("exec:cancel", async () => {
    if (activeExecFiber) {
      await runtime.runPromise(Fiber.interrupt(activeExecFiber)).catch(() => {})
      activeExecFiber = null
    }
    return { ok: true as const }
  })
}
