/**
 * The engine the window drives: `serveEngine` over the blocks' registry and
 * the Node layers, as the CLI's entry points build theirs. What it keeps
 * goes in the app's user data folder, which the entry point passes in:
 *
 * - `settings.json`, the settings store's file. It never reads the old
 *   app's folder: there is no import of today's settings.
 * - `v0/sessions/db/sessions.db`, the sessions database
 *   (`nodeSessionDatabase`): what each session saves, so that opening its
 *   runbook again resumes it. Each payload is encrypted with the cipher the
 *   entry point passes in (`sessionCipher.ts`), and none is saved where it
 *   gives none. Where the file cannot be used, this run's sessions are kept
 *   in memory, with a warning. It is never today's app's database, which
 *   is in today's user data folder.
 * - `v0/sessions/dirs` and `v0/sessions/state`: each session's working
 *   folder and credential provider state, by session id. At each start the
 *   engine drops, with their folders, the sessions retention names
 *   (`SessionStore.expired`): unused for `MAX_SESSION_AGE_MILLIS`, or past
 *   the `MAX_KEPT_SESSIONS` used last.
 *
 * Until the plugin transport, no real credential provider opens. In dev mode
 * (`fakeCredentialsOn`), credential blocks sign in against the fakes
 * (`@runbooks/blocks/fakes`), which run in memory and start no binary.
 */
import path from "node:path"
import { Effect, Layer } from "effect"
import type { Rpc } from "effect/rpc"
import { CredentialError } from "@runbooks/blocks-core/contract"
import * as registry from "@runbooks/blocks"
import { fakeScripts } from "@runbooks/blocks/fakes"
import { fakeCredentialProviders } from "@runbooks/core/credential/fake"
import { CredentialProviders } from "@runbooks/core/credential/provider"
import { serveEngine } from "@runbooks/core/handlers"
import type { EngineCommand } from "@runbooks/core/protocol"
import type { SessionCipher } from "@runbooks/core/services/SessionCipher"
import { SessionStore } from "@runbooks/core/sessionStore"
import { SettingsStore } from "@runbooks/core/settings"
import { ChildProcessSpawnerLive } from "@runbooks/platform-node/layers/ChildProcessSpawner"
import { NodeFileSystemLive } from "@runbooks/platform-node/layers/NodeFileSystem"
import { nodeSessionDatabase } from "@runbooks/platform-node/layers/NodeSessionDatabase"
import { nodeSettingsFile } from "@runbooks/platform-node/layers/NodeSettingsFile"

export interface AppEngineOptions {
  /** The app's user data folder. */
  readonly userData: string
  /** Checked against a runbook's `runbooks:` requirement. */
  readonly appVersion: string
  /** The app's process environment, read at the entry point. */
  readonly processEnvironment: Readonly<Record<string, string>>
  /** Whether credential blocks sign in against the fake providers: `fakeCredentialsOn`. */
  readonly fakeCredentials: boolean
  /** What encrypts each saved session's payloads: in the app, `safeStorageCipher`. */
  readonly sessionCipher: Layer.Layer<SessionCipher>
}

/** The variable that asks an app that is not packaged for the fake credential providers. */
export const FAKE_CREDENTIALS = "RUNBOOKS_FAKE_CREDENTIALS"

/**
 * The dev mode: whether credential blocks sign in against the fakes. Only
 * an app that is not packaged (Electron's `app.isPackaged`, which an
 * environment cannot change), started with RUNBOOKS_FAKE_CREDENTIALS=1. A
 * packaged app never does, whatever its environment says.
 */
export const fakeCredentialsOn = (
  packaged: boolean,
  environment: Readonly<Record<string, string>>,
): boolean => !packaged && environment[FAKE_CREDENTIALS] === "1"

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
    Layer.provide(
      options.fakeCredentials ? fakeCredentialProviders(fakeScripts) : NoCredentialProviders,
    ),
    Layer.provide(
      SessionStore.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            nodeSessionDatabase(path.join(options.userData, "v0", "sessions", "db")),
            options.sessionCipher,
          ),
        ),
      ),
    ),
    Layer.provide(Layer.mergeAll(NodeFileSystemLive, ChildProcessSpawnerLive)),
  )
