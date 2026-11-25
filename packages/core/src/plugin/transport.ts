/**
 * The plugin transport: how the app talks to a bundled binary over JSON-RPC
 * on standard input and output. One service, the transport owner, starts
 * every plugin; nothing else may spawn one. A block never sees JSON-RPC: it
 * asks for a typed client (the credential client, later the driver client)
 * built on a `PluginSession`.
 *
 * The wire messages are generated from `plugin/base.schema.json` into
 * `./generated/base.ts`.
 */
import type { Effect, Redacted, Scope, Stream } from "effect"
import { Context, Schema } from "effect"

/** The protocol version this app speaks. `configure` fails with `unsupportedProtocolVersion` on any other. */
export const PROTOCOL_VERSION = "1"

/** A closed set: the engine has to know when each kind may start, what env it gets and what its notifications mean. */
export const PluginKind = Schema.Literals(["credential", "driver"])
export type PluginKind = typeof PluginKind.Type

/** An OS and architecture a binary is built for, as the lock file keys them. */
export const Platform = Schema.Literals([
  "darwin-arm64",
  "darwin-amd64",
  "linux-arm64",
  "linux-amd64",
  "windows-amd64",
])
export type Platform = typeof Platform.Type

export const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)).pipe(
  Schema.brand("Sha256"),
)
export type Sha256 = typeof Sha256.Type

/**
 * One plugin, as `resources/plugins.lock` pins it. Adding a plugin of an
 * existing kind is one entry. A runbook cannot name a binary of its own.
 */
export const PluginEntry = Schema.Struct({
  /**
   * Unique within its kind: `aws`. The binary is `runbooks-<kind>-<name>`,
   * with `.exe` on Windows, as the plugins' release names it.
   */
  name: Schema.NonEmptyString,
  kind: PluginKind,
  version: Schema.NonEmptyString,
  /** Platforms the release builds. Fetching for one that is missing fails; it never downloads unverified. */
  sha256: Schema.Record(Schema.String, Sha256).check(Schema.isPropertyNames(Platform)),
})
export type PluginEntry = typeof PluginEntry.Type

/** The transport owner's limits. Each one fails with a typed error that names it. */
export const LIMITS = {
  /** A call that has no answer by then fails with `PluginTimedOut`. Sign-in sets its own. */
  callTimeoutMillis: 30_000,
  /** One line either way: the plugin's on standard output, or a request the owner would write. */
  maxLineBytes: 1024 * 1024,
  /** Standard error's last this many bytes are kept for `PluginExited`. More never fails. */
  maxStderrBytes: 64 * 1024,
  /** Notifications one streaming call may produce. */
  maxStreamItems: 10_000,
  /**
   * After standard input closes, how long the plugin has to exit before it
   * is killed. A plugin must stop what it started within it: the owner's
   * kill reaches only the plugin's process group, and the Azure plugin
   * starts `az` in a group of its own, which it kills itself.
   */
  exitGraceMillis: 5_000,
} as const

// ---------------------------------------------------------------------------
// Transport errors: a closed set
// ---------------------------------------------------------------------------

/** The plugin has no binary for this platform in `resources/bin`. */
export class PluginNotInstalled extends Schema.TaggedError<PluginNotInstalled>()(
  "PluginNotInstalled",
  { plugin: Schema.String, platform: Schema.String },
) {}

/** The binary's SHA-256 is not the one the lock file pins. It does not start. */
export class PluginHashMismatch extends Schema.TaggedError<PluginHashMismatch>()(
  "PluginHashMismatch",
  { plugin: Schema.String, expected: Schema.String, actual: Schema.String },
) {}

export class PluginSpawnFailed extends Schema.TaggedError<PluginSpawnFailed>()(
  "PluginSpawnFailed",
  { plugin: Schema.String, message: Schema.String },
) {}

/**
 * `configure` answered with a protocol version this app does not speak, or
 * refused this app's with error kind `unsupportedProtocolVersion`. A refusal
 * names no version of the plugin's own, so `offered` is absent.
 */
export class PluginUnsupportedProtocolVersion extends Schema.TaggedError<PluginUnsupportedProtocolVersion>()(
  "PluginUnsupportedProtocolVersion",
  { plugin: Schema.String, offered: Schema.optionalKey(Schema.String), supported: Schema.String },
) {}

/**
 * A line that is not JSON, a message that fails its schema, a response to no
 * open request, or a notification with no request. `message` says which,
 * and never quotes the line: it may hold a secret.
 */
export class PluginProtocolViolation extends Schema.TaggedError<PluginProtocolViolation>()(
  "PluginProtocolViolation",
  { plugin: Schema.String, message: Schema.String },
) {}

/** The plugin exited, so its session is over. `stderr` is its last `maxStderrBytes` bytes. */
export class PluginExited extends Schema.TaggedError<PluginExited>()("PluginExited", {
  plugin: Schema.String,
  code: Schema.optionalKey(Schema.Int),
  signal: Schema.optionalKey(Schema.String),
  stderr: Schema.String,
}) {}

export class PluginTimedOut extends Schema.TaggedError<PluginTimedOut>()("PluginTimedOut", {
  plugin: Schema.String,
  method: Schema.String,
  afterMillis: Schema.Int,
}) {}

/** A line or a stream's items passed its limit. */
export class PluginTooLarge extends Schema.TaggedError<PluginTooLarge>()("PluginTooLarge", {
  plugin: Schema.String,
  limit: Schema.Literals(["line", "streamItems"]),
  max: Schema.Int,
}) {}

export const PluginTransportError = Schema.Union([
  PluginNotInstalled,
  PluginHashMismatch,
  PluginSpawnFailed,
  PluginUnsupportedProtocolVersion,
  PluginProtocolViolation,
  PluginExited,
  PluginTimedOut,
  PluginTooLarge,
])
export type PluginTransportError = typeof PluginTransportError.Type

/**
 * An error the plugin answered with. `kind` is parsed into the kind's
 * closed set, with `unknown` for a kind this app does not know yet: a
 * binary can gain one before the app does. `message` is for a person.
 */
export interface PluginRemoteError<K extends string> {
  readonly _tag: "PluginRemoteError"
  readonly plugin: string
  readonly method: string
  readonly kind: K | "unknown"
  /** The kind as the plugin sent it, for logs. */
  readonly rawKind: string
  readonly message: string
  /** `data` beyond `kind`: unmet scopes, the missing tool's install link. */
  readonly data: { readonly [field: string]: unknown }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** A method of a kind: its name and the schemas its params and result decode with. */
export interface Method<P, R> {
  readonly name: string
  readonly params: Schema.Codec<P, unknown>
  readonly result: Schema.Codec<R, unknown>
  /** How long the call may take, `LIMITS.callTimeoutMillis` when absent. A sign-in sets its own. */
  readonly timeoutMillis?: number
}

/** A method that sends notifications before its result, such as `signIn`. */
export interface StreamMethod<P, N, R> extends Method<P, R> {
  readonly notification: { readonly method: string; readonly params: Schema.Codec<N, unknown> }
}

export type StreamItem<N, R> =
  | { readonly _tag: "Notification"; readonly params: N }
  | { readonly _tag: "Result"; readonly result: R }

/** What the owner puts in every `configure`. */
export interface ConfigureFields {
  /** `PROTOCOL_VERSION`. */
  readonly protocolVersion: string
  /** The calling app and its version: runbooks/0.31.0. */
  readonly caller: string
}

/**
 * What the owner needs of a kind (the credential protocol, later the
 * driver's): the kind's own error kinds and its `configure`, whose params
 * hold `ConfigureFields` and whose result holds `protocolVersion`.
 */
export interface PluginProtocol<K extends string, P, C> {
  readonly kind: PluginKind
  readonly errorKinds: ReadonlyArray<K>
  readonly configure: Method<P, C>
}

/**
 * One running plugin, configured. A timeout, a protocol violation, a line or
 * a stream's items past its limit, or an exit ends the session: standard
 * input closes, and every open call fails with the error that ended it, as
 * does every later call. A call or stream given up before its answer ends it
 * too, since closing standard input is the protocol's only cancel: the calls
 * left fail with `PluginExited` once the plugin stops. A remote error ends
 * only its call.
 */
export interface PluginSession<K extends string, C> {
  /** What the plugin answered to `configure`. */
  readonly configured: C
  readonly call: <P, R>(
    method: Method<P, R>,
    params: P,
  ) => Effect.Effect<R, PluginTransportError | PluginRemoteError<K>>
  /** Ends with exactly one `Result`. Closing it early cancels the call by closing standard input. */
  readonly stream: <P, N, R>(
    method: StreamMethod<P, N, R>,
    params: P,
  ) => Stream.Stream<StreamItem<N, R>, PluginTransportError | PluginRemoteError<K>>
}

/** The transport owner. The only code that starts a plugin binary. */
export class PluginProcess extends Context.Service<
  PluginProcess,
  {
    /**
     * Starts a plugin of `protocol`'s kind by registry name, never by path,
     * after checking its hash, then calls `configure` with `configure`'s
     * params before anything else. The child gets exactly `env`, not the
     * app's own environment. Closing the scope closes standard input, waits
     * `LIMITS.exitGraceMillis`, then kills the plugin and what it started.
     */
    readonly open: <K extends string, P, C>(
      protocol: PluginProtocol<K, P, C>,
      plugin: string,
      env: { readonly [name: string]: Redacted.Redacted<string> },
      configure: (fields: ConfigureFields) => P,
    ) => Effect.Effect<
      PluginSession<K, C>,
      PluginTransportError | PluginRemoteError<K>,
      Scope.Scope
    >
  }
>()("@runbooks/core/plugin/PluginProcess") {}
