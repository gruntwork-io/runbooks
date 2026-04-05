/**
 * IPC handler for script execution with streaming.
 *
 * Runs a script via the executeScript Effect, then subscribes to the resulting
 * Stream of ExecEvents and forwards each event to the renderer process via
 * event.sender.send(). The handler returns the final status when the stream
 * completes.
 */
import { Effect, Stream } from "effect"
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

export function registerExecHandlers(): void {
  ipcMain.handle(
    "exec:run",
    async (event, params: { request: ExecRequest; token: string }) => {
      const { request, token } = params

      return runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            // Validate the session token and get execution context
            const context = yield* sessionManager.validateToken(token)
            if (!context) {
              throw new Error("Invalid session token")
            }

            // Resolve the executable from the registry
            if (!executableRegistry) {
              throw new Error("No runbook loaded")
            }

            const executableId = request.executableId ?? request.componentId ?? ""
            const executable = yield* executableRegistry.getExecutable(executableId)

            // Render template variables into the script content
            let scriptContent = executable.content
            if (request.templateVarValues) {
              for (const [key, value] of Object.entries(request.templateVarValues)) {
                const placeholder = `{{.${key}}}`
                scriptContent = scriptContent.replaceAll(placeholder, String(value))
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
              request,
              context,
              workTreePath,
              outputPath,
            )

            // Consume the stream, forwarding events to the renderer
            let finalStatus: ExecStatusEvent | null = null

            yield* Stream.runForEach(eventStream, (execEvent) =>
              Effect.sync(() => {
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
                  case "env_captured":
                    // Update the session environment with captured changes
                    const filteredEnv = filterCapturedEnv(execEvent.env)
                    sessionManager.updateSessionEnv(filteredEnv, execEvent.pwd)
                    break
                  case "done":
                    break
                }
              }),
            )

            return { status: finalStatus }
          }),
        ),
      )
    },
  )
}
