/**
 * The settings as the window follows them: as `GetSettings` gave them when
 * it opened the runbook (`app.tsx`), then each change `WatchSettings`
 * streams, so a change shows without a reload.
 */
import { Cause, Effect, Stream } from "effect"
import type { EngineClient, Settings } from "@runbooks/core/protocol"

/** The settings now, for React to read (`useSyncExternalStore`). Undefined: none were read. */
export interface SettingsStore {
  readonly get: () => Settings | undefined
  /** Calls `listener` after each change, until the function it returns is called. */
  readonly subscribe: (listener: () => void) => () => void
}

/** A store of `initial` until `set` is called. */
export function makeSettingsStore(
  initial: Settings | undefined,
): SettingsStore & { readonly set: (settings: Settings) => void } {
  let settings = initial
  const listeners = new Set<() => void>()
  return {
    get: () => settings,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set: (next) => {
      settings = next
      for (const listener of listeners) listener()
    },
  }
}

/**
 * Calls `publish` with the settings after each change. When the watch
 * fails, as the engine not answering or a defect makes it, the window keeps
 * the settings it has, and following the session goes on. Unmounting
 * interrupts.
 */
export const followSettings = (
  engine: EngineClient,
  publish: (settings: Settings) => void,
): Effect.Effect<void> =>
  Stream.runForEach(engine.WatchSettings(), (view) =>
    Effect.sync(() => publish(view.settings)),
  ).pipe(
    Effect.catchTag("RpcClientError", () => Effect.void),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.void,
    ),
  )
