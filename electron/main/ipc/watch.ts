/**
 * IPC handler for watch mode.
 *
 * Starts a file watcher on the runbook directory and streams file change
 * events to the renderer. When a new subscription is requested, any existing
 * watcher is replaced.
 */
import { Effect, Stream } from "effect"
import { ipcMain } from "electron"
import { runtime, runbookConfig, setExecutableRegistry } from "./runtime.ts"
import { createWatcher } from "../../../src/watcher.ts"
import { ExecutableRegistry } from "../../../src/domain/registry/executable.ts"
import { validateSessionPath } from "./path-guard.ts"

export function registerWatchHandlers(): void {
  ipcMain.handle(
    "watch:subscribe",
    async (event, params: { runbookPath: string }) => {
      // Prefer the already-trusted runbookConfig.localPath; only use the
      // renderer-supplied path if it passes validation.
      let runbookPath = runbookConfig.localPath
      if (params.runbookPath && params.runbookPath !== runbookPath) {
        runbookPath = await runtime.runPromise(validateSessionPath(params.runbookPath))
      }

      if (!runbookPath) {
        throw new Error("No runbook path provided and none configured")
      }

      // Create the watcher stream, then fork stream consumption into a
      // background fiber so the handler can return immediately.
      await runtime.runPromise(
        Effect.gen(function* () {
          const watcherStream = yield* createWatcher(runbookPath)

          yield* Effect.forkDaemon(
            Stream.runForEach(watcherStream, (changeEvent) =>
              Effect.gen(function* () {
                // Re-parse the executable registry on file changes unless
              // --disable-live-file-reload was passed (keeps the registry
              // frozen at startup so only pre-validated scripts can run).
                if (
                  !runbookConfig.disableLiveFileReload &&
                  (changeEvent.path === runbookPath ||
                  changeEvent.path.endsWith(".mdx"))
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
            ).pipe(Effect.ignore),
          )
        }),
      )

      return { ok: true as const }
    },
  )
}
