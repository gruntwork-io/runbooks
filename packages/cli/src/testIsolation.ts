/**
 * What `runbooks test` runs its engine over, so a test leaves nothing of
 * the person's behind it and reads nothing of theirs:
 *
 * - No saved sessions: the core's `NoSavedSessions` keeps nothing and
 *   finds nothing, so no test resumes a session, and none is saved for the
 *   app to resume.
 * - No settings file. The settings are the defaults: no CA bundle and no
 *   proxy. The app's settings file is neither read nor written.
 * - Credential providers the caller gives: the entry point's sign in only
 *   with the fake's logins (`@runbooks/blocks/fakes`) until the plugin
 *   transport runs the real ones, and a test's own may open none
 *   (`NoCredentialProviders`).
 *
 * The working and state folders are the caller's: a temporary folder per
 * test case (`testRun.ts`).
 */
import { Effect, Layer, Option } from "effect"
import { CredentialError } from "@runbooks/blocks-core/contract"
import { CredentialProviders } from "@runbooks/core/credential/provider"
import { SettingsFile } from "@runbooks/core/services/SettingsFile"
import { SettingsStore } from "@runbooks/core/settings"

/** Settings with no file behind them: the defaults, and a change kept in memory only. */
export const DefaultSettings = SettingsStore.layer.pipe(
  Layer.provide(
    Layer.succeed(SettingsFile, {
      path: "(none: runbooks test reads no settings file)",
      read: Effect.succeed(Option.none()),
      replace: () => Effect.void,
      keepAside: Effect.succeed("(none)"),
      imported: Effect.succeed(true),
      markImported: Effect.void,
    }),
  ),
)

/** No credential provider can be opened. */
export const NoCredentialProviders = Layer.succeed(CredentialProviders, {
  open: (provider) =>
    Effect.fail(
      new CredentialError({
        kind: "providerFailed",
        message: `runbooks test does not run credential providers yet, so ${provider} cannot sign in.`,
      }),
    ),
})
