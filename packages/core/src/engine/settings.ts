/**
 * The settings store: the one owner of every setting. It serves
 * `GetSettings`, `ChangeSettings` and `WatchSettings`, and the engine reads
 * the settings a credential provider opens with from it.
 *
 * The settings file (`SettingsFile`) holds
 * `{ "version": SETTINGS_VERSION, "settings": { ... } }`, and `settings`
 * holds only what a person set: the rest take `DEFAULT_SETTINGS`, so a
 * default can change in a later version. Reading the file never fails the
 * engine and never loses what the file holds:
 *
 * - No file: the defaults.
 * - A setting whose value this version does not take, or that it does not
 *   know: the default applies, a problem names it, and the file keeps it.
 * - A newer version: the settings this version knows apply, and every
 *   change is refused, since writing would lose the rest.
 * - Not settings (not JSON, too large, no version): the defaults apply, and
 *   the file is copied aside before a change replaces it.
 * - The file cannot be read, or cannot be copied aside: the defaults apply,
 *   and every change is refused.
 *
 * A change writes back every value the file held, even one this version
 * cannot read, apart from the settings the change names.
 */
import { Context, type Effect, type Stream } from "effect"
import type {
  Caller,
  ChangeSettingsResult,
  Forbidden,
  Settings,
  SettingsChange,
  SettingsNotSaved,
  SettingsView,
} from "./protocol.ts"

/**
 * The version of the settings file this release reads and writes. Adding a
 * setting does not raise it: an older release keeps a setting it does not
 * know. Renaming or removing one, or changing what its values mean, does,
 * and comes with the step that reads the version before.
 */
export const SETTINGS_VERSION = 1

/** Each setting's value until a person sets it. */
export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  instructionMode: false,
  runbookWidth: null,
  askAboutGeneratedFiles: true,
  caBundleFile: null,
  proxy: null,
  agentAccess: false,
  confirmAgentRuns: true,
  recentGitHubHosts: [],
  lastSelectedGitHubHost: null,
  recentGitLabHosts: [],
  lastSelectedGitLabHost: null,
}

export interface SettingsStoreShape {
  /** `GetSettings`. */
  readonly get: Effect.Effect<SettingsView>
  /**
   * `ChangeSettings`, person only. Saves the settings `changes` names, then
   * applies them; if the file cannot be written, nothing changes.
   */
  readonly change: (
    changes: SettingsChange,
  ) => Effect.Effect<ChangeSettingsResult, Forbidden | SettingsNotSaved, Caller>
  /** `WatchSettings`: the settings now, then again after each change, the latest only for a reader that falls behind. */
  readonly watch: Stream.Stream<SettingsView>
}

export class SettingsStore extends Context.Service<SettingsStore, SettingsStoreShape>()(
  "@runbooks/core/engine/SettingsStore",
) {}
