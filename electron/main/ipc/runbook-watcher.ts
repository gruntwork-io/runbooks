/**
 * Owns the file watchers for the open runbook: the watch-mode watcher on the
 * runbook file, and the watcher on the script files its blocks run.
 *
 * Each runs at most one watch at a time, keyed on what it watches: starting
 * it on something else interrupts the previous watch, which closes its file
 * watcher. Kept free of Electron imports; watch.ts wires them to the app
 * runtime and the main window.
 */
import { Effect, Fiber, Stream } from "effect"
import { createScriptWatcher, createWatcher } from "../../../src/watcher.ts"
import type { FileChangeEvent, FileSystem } from "../../../src/services/FileSystem.ts"
import type { FileWatchError } from "../../../src/errors/index.ts"
import { makeLogger } from "../logger.ts"

const log = makeLogger("ipc:watch")

/** The part of a ManagedRuntime the watcher needs to fork its fiber. */
export interface WatcherRuntime {
  runFork: <A, E>(effect: Effect.Effect<A, E, FileSystem>) => Fiber.RuntimeFiber<A, E>
}

export interface RunbookWatcher {
  /**
   * Watch `runbookPath` and call `onReload` with it whenever it changes. A
   * no-op when that runbook is already being watched; a watcher for any other
   * runbook is stopped first.
   */
  start: (runbookPath: string) => void
  /** Stop the running watcher, if any. Resolves once its file watcher is closed. */
  stop: () => Promise<void>
}

export interface ScriptWatcher {
  /**
   * Watch `scriptPaths` and call `onChange` with the ones that were written,
   * once per burst of writes. A no-op when exactly those files are already
   * being watched; a watcher on any other set is stopped first, and an empty
   * set only stops it.
   */
  watch: (scriptPaths: readonly string[]) => void
  /** Stop the running watcher, if any. Resolves once its file watcher is closed. */
  stop: () => Promise<void>
}

export function makeRunbookWatcher(
  runtime: WatcherRuntime,
  onReload: (runbookPath: string) => void,
): RunbookWatcher {
  const watch = makeKeyedWatch<FileChangeEvent>(runtime)
  return {
    start: (runbookPath) =>
      watch.start({
        key: runbookPath,
        label: runbookPath,
        changes: createWatcher(runbookPath),
        onChange: () => onReload(runbookPath),
      }),
    stop: watch.stop,
  }
}

export function makeScriptWatcher(
  runtime: WatcherRuntime,
  onChange: (scriptsWritten: string[]) => void,
): ScriptWatcher {
  const watch = makeKeyedWatch<string[]>(runtime)
  return {
    watch: (scriptPaths) => {
      if (scriptPaths.length === 0) {
        void watch.stop()
        return
      }
      watch.start({
        key: [...scriptPaths].sort().join("\n"),
        label: `${scriptPaths.length} script file(s)`,
        changes: createScriptWatcher(scriptPaths),
        onChange,
      })
    },
    stop: watch.stop,
  }
}

interface WatchTarget<T> {
  /** Identifies what is watched: starting the same key again is a no-op. */
  key: string
  /** Names what is watched in the log. */
  label: string
  changes: Effect.Effect<Stream.Stream<T, FileWatchError>, never, FileSystem>
  onChange: (change: T) => void
}

function makeKeyedWatch<T>(runtime: WatcherRuntime) {
  let active: { key: string; fiber: Fiber.RuntimeFiber<void> } | null = null

  const run = (target: WatchTarget<T>) =>
    Effect.gen(function* () {
      const changes = yield* target.changes
      yield* Stream.runForEach(changes, (change) =>
        Effect.sync(() => {
          // A replaced or stopped watcher can deliver one last event before
          // its interruption lands; only the target being watched reports it.
          if (active?.key === target.key) target.onChange(change)
        }),
      )
    }).pipe(
      Effect.catchAll((err) =>
        Effect.sync(() => log.warn(`stopped watching ${target.label}:`, err)),
      ),
    )

  const stop = (): Promise<void> => {
    const current = active
    if (!current) return Promise.resolve()
    active = null
    return Effect.runPromise(Fiber.interrupt(current.fiber).pipe(Effect.asVoid))
  }

  const start = (target: WatchTarget<T>): void => {
    // A watcher that died (e.g. a file watcher error) is replaced, not kept.
    if (active?.key === target.key && active.fiber.unsafePoll() === null) {
      return
    }
    void stop()
    active = { key: target.key, fiber: runtime.runFork(run(target)) }
  }

  return { start, stop }
}
