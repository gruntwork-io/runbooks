/**
 * What `runbooks test` runs its engine over, so a test leaves nothing of
 * the person's behind it and reads nothing of theirs:
 *
 * - No saved sessions. The store keeps nothing and finds nothing, so no
 *   test resumes a session, and none is saved for the app to resume.
 * - No settings file. The settings are the defaults: no CA bundle and no
 *   proxy. The app's settings file is neither read nor written.
 * - No credential providers. Each credential block is Unavailable, so a
 *   step that expects one to succeed fails. Running providers belongs to
 *   the plugin transport (work product 2.12).
 *
 * The working and state folders are the caller's: a temporary folder per
 * test case (`testRun.ts`).
 */
import { Effect, Layer, Option } from "effect"
import { CredentialError } from "@runbooks/blocks-core/contract"
import { CredentialProviders } from "@runbooks/core/credential/provider"
import { SessionStore } from "@runbooks/core/sessionStore"
import { SettingsFile } from "@runbooks/core/services/SettingsFile"
import { SettingsStore } from "@runbooks/core/settings"

/** A session store that keeps nothing: every session is new, and none outlives its test. */
export const NoSavedSessions = Layer.succeed(SessionStore, {
  latest: () => Effect.succeed(Option.none()),
  keep: () =>
    Effect.succeed({
      put: () => Effect.void,
      drop: () => Effect.void,
      trust: () => Effect.void,
      close: () => Effect.void,
    }),
  expired: Effect.succeed([]),
  forget: () => Effect.void,
})

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
