/**
 * Owns the single watch-mode file watcher.
 *
 * At most one watcher runs at a time, keyed on the runbook it watches:
 * starting a watcher for a different runbook interrupts the previous one,
 * which closes its file watcher. Kept free of Electron imports; watch.ts
 * wires it to the app runtime and the main window.
 */
import { Effect, Fiber, Stream } from "effect"
import { createWatcher } from "../../../src/watcher.ts"
import type { FileSystem } from "../../../src/services/FileSystem.ts"
import { makeLogger } from "../logger.ts"

const log = makeLogger("ipc:watch")

/** The part of a ManagedRuntime the watcher needs to fork its fiber. */
export interface WatcherRuntime {
  runFork: <A, E>(effect: Effect.Effect<A, E, FileSystem>) => Fiber.RuntimeFiber<A, E>
}

export interface RunbookWatcher {
  /**
   * Watch `runbookPath` and call `onReload` whenever it changes. A no-op when
   * that runbook is already being watched; a watcher for any other runbook is
   * stopped first.
   */
  start: (runbookPath: string) => void
  /** Stop the running watcher, if any. Resolves once its file watcher is closed. */
  stop: () => Promise<void>
}

export function makeRunbookWatcher(runtime: WatcherRuntime, onReload: () => void): RunbookWatcher {
  let active: { runbookPath: string; fiber: Fiber.RuntimeFiber<void> } | null = null

  const watchRunbook = (runbookPath: string) =>
    Effect.gen(function* () {
      const changes = yield* createWatcher(runbookPath)
      yield* Stream.runForEach(changes, () =>
        Effect.sync(() => {
          // A replaced or stopped watcher can deliver one last event before
          // its interruption lands; only the runbook being watched reloads.
          if (active?.runbookPath === runbookPath) onReload()
        }),
      )
    }).pipe(
      Effect.catchAll((err) =>
        Effect.sync(() => log.warn(`stopped watching ${runbookPath}:`, err)),
      ),
    )

  const stop = (): Promise<void> => {
    const current = active
    if (!current) return Promise.resolve()
    active = null
    return Effect.runPromise(Fiber.interrupt(current.fiber).pipe(Effect.asVoid))
  }

  const start = (runbookPath: string): void => {
    // A watcher that died (e.g. a file watcher error) is replaced, not kept.
    if (active?.runbookPath === runbookPath && active.fiber.unsafePoll() === null) {
      return
    }
    void stop()
    active = { runbookPath, fiber: runtime.runFork(watchRunbook(runbookPath)) }
  }

  return { start, stop }
}
