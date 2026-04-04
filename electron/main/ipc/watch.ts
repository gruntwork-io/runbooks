/**
 * IPC handler for watch mode.
 *
 * Starts a file watcher on the runbook directory and streams file change
 * events to the renderer. When a new subscription is requested, any existing
 * watcher is replaced.
 */
import { Effect, Stream } from "effect"
import { ipcMain } from "electron"
import { runtime, runbookConfig, setFileWatcher } from "./runtime.ts"
import { createWatcher } from "../../../src/watcher.ts"
import { ExecutableRegistry } from "../../../src/domain/registry/executable.ts"
import { setExecutableRegistry } from "./runtime.ts"

export function registerWatchHandlers(): void {
  ipcMain.handle(
    "watch:subscribe",
    async (event, params: { runbookPath: string }) => {
      const runbookPath = params.runbookPath || runbookConfig.localPath

      if (!runbookPath) {
        throw new Error("No runbook path provided and none configured")
      }

      // Create the watcher stream and store it
      await runtime.runPromise(
        Effect.gen(function* () {
          const watcherStream = yield* createWatcher(runbookPath)
          setFileWatcher(watcherStream)

          // Fork a fiber to consume events and forward to the renderer.
          // We use runFork so the stream runs in the background.
          yield* Stream.runForEach(watcherStream, (changeEvent) =>
            Effect.gen(function* () {
              // Re-parse the executable registry on file changes
              if (
                changeEvent.path === runbookPath ||
                changeEvent.path.endsWith(".mdx")
              ) {
                const registry = yield* Effect.either(
                  ExecutableRegistry.create(runbookPath),
                )
                if (registry._tag === "Right") {
                  setExecutableRegistry(registry.right)
                }
              }

              event.sender.send("watch:file-change", {
                type: changeEvent.type,
                path: changeEvent.path,
              })
            }),
          ).pipe(
            // Ignore errors from the watcher stream (e.g. if it closes)
            Effect.ignore,
          )
        }),
      ).catch(() => {
        // Watcher stream ended or errored -- this is expected on cleanup
      })

      return { ok: true as const }
    },
  )
}
