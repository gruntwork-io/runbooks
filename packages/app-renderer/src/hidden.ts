/**
 * What the person asked a runbook's display blocks not to show again, as a
 * note's "Don't show me this again" asks: the `hiddenInRunbooks` setting.
 * This module alone reads and changes it. A key hides only in the runbook
 * it was hidden in, so two runbooks' notes with the same key are hidden
 * apart, and it lasts across launches, since the engine keeps the settings.
 *
 * The setting is bounded (`HIDDEN_LIMITS`): the runbook hidden in longest
 * ago, and a runbook's oldest key, are forgotten past the most it keeps,
 * and a key or a runbook path it could not keep is not hidden.
 */
import { Cause, Effect, Schema } from "effect"
import { type EngineClient, HIDDEN_LIMITS, Settings } from "@runbooks/core/protocol"
import type { SettingsStore } from "./settings.ts"

type HiddenInRunbooks = Settings["hiddenInRunbooks"]

const isKept = Schema.is(Settings.fields.hiddenInRunbooks)

/** The keys hidden in `runbook`, the one hidden last first. */
export function hiddenKeysIn(hidden: HiddenInRunbooks, runbook: string): ReadonlyArray<string> {
  return hidden.find((entry) => entry.runbook === runbook)?.keys ?? []
}

/**
 * `hidden` with `key` hidden in `runbook`: that runbook first, and the key
 * first in it. The list it was given when the key is hidden already, or
 * when the setting could not keep it.
 */
export function withHidden(
  hidden: HiddenInRunbooks,
  runbook: string,
  key: string,
): HiddenInRunbooks {
  const keys = hiddenKeysIn(hidden, runbook)
  if (keys.includes(key)) return hidden
  const next = [
    { runbook, keys: [key, ...keys].slice(0, HIDDEN_LIMITS.keys) },
    ...hidden.filter((entry) => entry.runbook !== runbook),
  ].slice(0, HIDDEN_LIMITS.runbooks)
  return isKept(next) ? next : hidden
}

/**
 * Asks the engine, as the person, to keep `key` hidden in `runbook`, and
 * keeps the settings it answers with in `settings`, so the next hide starts
 * from them. Nothing is asked before the settings are read, nor for a key
 * hidden already. When the engine does not keep it, the settings stay as
 * they are and the note is hidden only until the runbook is drawn again.
 */
export const askToHide = (
  engine: EngineClient,
  settings: SettingsStore & { readonly set: (settings: Settings) => void },
  runbook: string,
  key: string,
): Effect.Effect<void> =>
  Effect.suspend(() => {
    const now = settings.get()
    if (now === undefined) return Effect.void
    const next = withHidden(now.hiddenInRunbooks, runbook, key)
    if (next === now.hiddenInRunbooks) return Effect.void
    return engine.ChangeSettings({ changes: { hiddenInRunbooks: next } }).pipe(
      Effect.flatMap((result) =>
        Effect.sync(() => {
          if (result._tag === "Changed") settings.set(result.settings.settings)
        }),
      ),
      // Refused (Forbidden, SettingsNotSaved), unanswered or failed: the settings stay as they are.
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.void,
      ),
    )
  })
