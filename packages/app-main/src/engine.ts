/**
 * The engine the window drives: `serveEngine` over the blocks' registry and
 * the Node layers, as the CLI's entry points build theirs. What it keeps
 * goes in the app's user data folder, which the entry point passes in:
 *
 * - `settings.json`, the settings store's file. It never reads the old
 *   app's folder: there is no import of today's settings.
 * - `v0/sessions/dirs` and `v0/sessions/state`: each session's working
 *   folder and credential provider state, by session id.
 *
 * Until the sessions database is wired (row 3n), it keeps no session, so it
 * resumes none, and retention never drops a session's folders. Until the
 * plugin transport, no credential provider opens; the registry has no
 * credential block yet.
 */
import path from "node:path"
import { Effect, Layer } from "effect"
import type { Rpc } from "effect/rpc"
import { CredentialError } from "@runbooks/blocks-core/contract"
import * as registry from "@runbooks/blocks"
import { CredentialProviders } from "@runbooks/core/credential/provider"
import { serveEngine } from "@runbooks/core/handlers"
import type { EngineCommand } from "@runbooks/core/protocol"
import { NoSavedSessions } from "@runbooks/core/sessionStore"
import { SettingsStore } from "@runbooks/core/settings"
import { ChildProcessSpawnerLive } from "@runbooks/platform-node/layers/ChildProcessSpawner"
import { NodeFileSystemLive } from "@runbooks/platform-node/layers/NodeFileSystem"
import { nodeSettingsFile } from "@runbooks/platform-node/layers/NodeSettingsFile"

export interface AppEngineOptions {
  /** The app's user data folder. */
  readonly userData: string
  /** Checked against a runbook's `runbooks:` requirement. */
  readonly appVersion: string
  /** The app's process environment, read at the entry point. */
  readonly processEnvironment: Readonly<Record<string, string>>
}

const NoCredentialProviders = Layer.succeed(CredentialProviders, {
  open: (provider) =>
    Effect.fail(
      new CredentialError({
        kind: "providerFailed",
        message: `The app does not run credential providers yet, so ${provider} cannot sign in.`,
      }),
    ),
})

/** The engine's protocol handlers, over an engine of their own. */
export const appEngine = (options: AppEngineOptions): Layer.Layer<Rpc.ToHandler<EngineCommand>> =>
  serveEngine({
    registry,
    appVersion: options.appVersion,
    workingFolders: path.join(options.userData, "v0", "sessions", "dirs"),
    stateFolders: path.join(options.userData, "v0", "sessions", "state"),
    processEnvironment: options.processEnvironment,
  }).pipe(
    Layer.provide(SettingsStore.layer.pipe(Layer.provide(nodeSettingsFile(options.userData)))),
    Layer.provide(NoCredentialProviders),
    Layer.provide(NoSavedSessions),
    Layer.provide(Layer.mergeAll(NodeFileSystemLive, ChildProcessSpawnerLive)),
  )
