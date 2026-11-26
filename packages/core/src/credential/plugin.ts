/**
 * The credential client: a `CredentialProvider` backed by a credential
 * plugin (`plugin/credential.schema.json`), through the transport owner
 * (`PluginProcess`). The engine sees the same provider an in-process one
 * gives it, and never JSON-RPC.
 *
 * The plugin's process:
 * - One per credential block: the engine opens one provider per block, and
 *   a block fixes the plugin and its levels. It starts on the provider's
 *   first call, which the engine makes only once the person trusts the
 *   runbook, so nothing starts before trust.
 * - It lives in a scope of its own inside the one the provider was opened
 *   in, so closing the block's scope, or the session, ends it.
 * - It ends after `signOut`, after a sign-in given up (closing standard
 *   input is the protocol's only cancel), and when the transport ends it.
 *   The next call starts a fresh one, which must describe the same levels,
 *   names and requirements as the first.
 * - It runs with `ProviderConfig.environment`, which the engine builds, and
 *   nothing else of the app's environment.
 *
 * The three secret rules, as the client holds a plugin to them:
 * 1. Only `env` returns secret values, and they are `Redacted` from the
 *    moment they arrive. A value equal to a secret the client knows must be
 *    marked sensitive.
 * 2. A secret the person types goes only into `signIn`'s params.
 * 3. A value marked `file` is a path inside the block's state directory,
 *    which only its owner can read.
 * No identity, target, prompt or error may carry a secret the client knows:
 * one typed into a secret field, or one `env` returned as sensitive. A
 * call that breaks a rule fails with `providerFailed`, and the message
 * names what broke it, never the value.
 */
import path from "node:path"
import { Effect, Exit, Layer, Option, Redacted, Schema, Scope, Semaphore, Stream } from "effect"
import { CredentialError, Requirement } from "@runbooks/blocks-core/contract"
import * as Wire from "../plugin/generated/credential.ts"
import {
  type Method as WireMethod,
  PluginProcess,
  type PluginProtocol,
  type PluginRemoteError,
  type PluginSession,
  type PluginTransportError,
  type StreamMethod,
} from "../plugin/transport.ts"
import { FileSystem } from "../services/FileSystem.ts"
import {
  type Constraints,
  type CredentialEnv,
  type CredentialProvider,
  CredentialProviders,
  type CredentialValue,
  Identity,
  type ProviderConfig,
  ProviderInfo,
  type ResolvedSource,
  type SignInEvent,
  type Target,
} from "./provider.ts"
import { isOwnerOnly, modeText } from "./stateDir.ts"

/**
 * How long the app waits for each method's answer, in milliseconds. The
 * owner sends them in `configure` (`callTimeoutsMillis`) and ends the
 * session when one runs out. Each plugin's own timeouts must fit under
 * these: it answers `timedOut` at least a second before its method's
 * limit, so the person sees why, and the session goes on.
 */
export const CREDENTIAL_LIMITS = {
  configure: 30_000,
  detect: 120_000,
  targets: 120_000,
  select: 120_000,
  env: 120_000,
  signOut: 60_000,
  /** A device code lives about ten minutes, and a person may be slow to start. */
  signIn: 15 * 60_000,
} as const

/**
 * The longest one provider call can take through the client: its own limit,
 * and starting the plugin again before it. The engine waits longer than
 * this, so a plugin's own `timedOut` reaches the person first.
 */
export const CREDENTIAL_CALL_BOUNDS = {
  call:
    CREDENTIAL_LIMITS.configure +
    Math.max(
      CREDENTIAL_LIMITS.detect,
      CREDENTIAL_LIMITS.targets,
      CREDENTIAL_LIMITS.select,
      CREDENTIAL_LIMITS.env,
      CREDENTIAL_LIMITS.signOut,
    ),
  signIn: CREDENTIAL_LIMITS.configure + CREDENTIAL_LIMITS.signIn,
} as const

const method = <P, R>(
  name: keyof typeof CREDENTIAL_LIMITS,
  params: Schema.Codec<P, unknown>,
  result: Schema.Codec<R, unknown>,
): WireMethod<P, R> => ({ name, params, result, timeoutMillis: CREDENTIAL_LIMITS[name] })

const Configure = method("configure", Wire.ConfigureParams, Wire.ConfigureResult)
const Detect = method("detect", Wire.DetectParams, Wire.DetectResult)
const SignIn: StreamMethod<Wire.SignInParams, Wire.SignInPrompt, Wire.SignInResult> = {
  ...method("signIn", Wire.SignInParams, Wire.SignInResult),
  notification: { method: "signIn.prompt", params: Wire.SignInPrompt },
}
const Targets = method("targets", Wire.TargetsParams, Wire.TargetsResult)
const Select = method("select", Wire.SelectParams, Wire.SelectResult)
const Env = method("env", Schema.Struct({}), Wire.EnvResult)
const SignOut = method("signOut", Schema.Struct({}), Wire.SignOutResult)

/** The credential kind, as the owner needs it. */
export const CREDENTIAL_PROTOCOL: PluginProtocol<
  Wire.ErrorKind,
  Wire.ConfigureParams,
  Wire.ConfigureResult
> = {
  kind: "credential",
  errorKinds: Wire.ErrorKind.literals,
  configure: Configure,
  methods: [Detect, SignIn, Targets, Select, Env, SignOut],
}

/**
 * What a plugin started again must describe as the first did: what the
 * engine took from the first. Its methods may differ: a field's choices
 * follow the person's config files, and a tool installed since makes a
 * method available.
 */
const fixedPartOf = (info: ProviderInfo) =>
  JSON.stringify({ levels: info.levels, names: info.names, requirements: info.requirements })

/** A secret shorter than this is not looked for: so short a string turns up in ordinary text. */
const MIN_SCANNED_SECRET = 8
/** The most secrets one provider remembers to look for; the oldest go first. */
const MAX_KNOWN_SECRETS = 256

type Session = PluginSession<Wire.ErrorKind, Wire.ConfigureResult>

/** A session, with the scope that ends it and what it described. */
interface Running {
  readonly session: Session
  readonly scope: Scope.Closeable
}

/** The message of a transport error: what happened, never a line the plugin wrote. */
const transportMessage = (plugin: string, error: PluginTransportError): string => {
  const name = `The ${plugin} credential plugin`
  switch (error._tag) {
    case "PluginNotInstalled":
      return `${name} is not installed for ${error.platform}.`
    case "PluginHashMismatch":
      return `${name}'s binary is not the one this app pins, so it did not start.`
    case "PluginSpawnFailed":
      return `${name} could not start: ${error.message}`
    case "PluginUnsupportedProtocolVersion":
      return `${name} speaks protocol ${error.offered ?? "another version"}; this app speaks ${error.supported}.`
    case "PluginProtocolViolation":
      return `${name} broke the protocol: ${error.message}`
    case "PluginExited":
      return `${name} stopped${error.code === undefined ? "" : ` with exit code ${error.code}`}${error.signal === undefined ? "" : ` on ${error.signal}`}.`
    case "PluginTimedOut":
      return `${name} did not answer ${error.method} within ${Math.round(error.afterMillis / 1000)} seconds.`
    case "PluginTooLarge":
      return `${name} sent more than ${error.max} ${error.limit === "line" ? "bytes in one line" : "sign-in prompts"}.`
  }
}

const RequirementsData = Schema.Array(Requirement)
const ToolData = Schema.Struct({ tool: Schema.String, installUrl: Schema.String })
const decodeIdentity = Schema.decodeUnknownEffect(Schema.toCodecJson(Identity))
const decodeInfo = Schema.decodeUnknownEffect(Schema.toCodecJson(ProviderInfo))
const decodeExpiry = Schema.decodeUnknownEffect(Schema.toCodecJson(Schema.DateTimeUtc))

/**
 * Opens the provider of the credential block `config` serves, backed by
 * the plugin named `plugin`. It starts nothing: the first call does.
 */
export const openPluginProvider = (
  plugin: string,
  config: ProviderConfig,
): Effect.Effect<CredentialProvider, never, Scope.Scope | PluginProcess | FileSystem> =>
  Effect.gen(function* () {
    const owner = yield* PluginProcess
    const files = yield* FileSystem
    const scope = yield* Effect.scope
    const starting = yield* Semaphore.make(1)
    let running: Running | undefined
    /** What the latest session described: a later one must give the same levels, names and requirements. */
    let described: ProviderInfo | undefined
    /** Secrets the client knows and looks for: typed into a secret field, or returned sensitive by env. */
    const secrets: Array<Redacted.Redacted<string>> = []

    const failed = (message: string) => new CredentialError({ kind: "providerFailed", message })
    const name = `The ${plugin} credential plugin`

    const remember = (value: string) => {
      if (value.length < MIN_SCANNED_SECRET) return
      if (secrets.some((known) => Redacted.value(known) === value)) return
      secrets.push(Redacted.make(value))
      if (secrets.length > MAX_KNOWN_SECRETS) secrets.shift()
    }
    const holdsSecret = (text: string) =>
      secrets.some((known) => text.includes(Redacted.value(known)))
    /** Fails when any string in `value` holds a secret the client knows; `what` says where. */
    const noSecretIn = (what: string, value: unknown) =>
      holdsSecret(JSON.stringify(value) ?? "")
        ? Effect.fail(failed(`${name} put a secret in ${what}, so the app refused it.`))
        : Effect.void

    /** Ends the running session, if it is still `which`. The next call starts another. */
    const retire = (which: Running | undefined) =>
      Effect.suspend(() => {
        if (which === undefined || running !== which) return Effect.void
        running = undefined
        return Scope.close(which.scope, Exit.void)
      })

    const configureParams = (fields: Parameters<Parameters<typeof owner.open>[3]>[0]) => ({
      ...fields,
      stateDir: config.stateDir,
      ...Option.match(config.caBundleFile, {
        onNone: () => ({}),
        onSome: (caBundleFile) => ({ caBundleFile }),
      }),
      ...Option.match(config.proxy, { onNone: () => ({}), onSome: (proxy) => ({ proxy }) }),
      settings: config.settings,
    })

    /** The running session, or a new one: the plugin started, configured and checked. */
    const ensure: Effect.Effect<Running, CredentialError> = starting.withPermit(
      Effect.suspend(() => {
        if (running !== undefined) return Effect.succeed(running)
        return Effect.gen(function* () {
          const own = yield* Scope.fork(scope)
          const session = yield* owner
            .open(
              CREDENTIAL_PROTOCOL,
              plugin,
              Object.fromEntries(config.environment),
              configureParams,
            )
            .pipe(
              Scope.provide(own),
              Effect.mapError(errorOf),
              Effect.onError(() => Scope.close(own, Exit.void)),
            )
          const info = yield* infoOf(session.configured).pipe(
            Effect.onError(() => Scope.close(own, Exit.void)),
          )
          if (described !== undefined && fixedPartOf(info) !== fixedPartOf(described)) {
            yield* Scope.close(own, Exit.void)
            return yield* failed(`${name} described itself differently when it started again.`)
          }
          described = info
          running = { session, scope: own }
          return running
        })
      }),
    )

    /** A remote error, its kind as the plugin sent it, or `unknown`; a transport error, `providerFailed`. */
    const errorOf = (
      error: PluginTransportError | PluginRemoteError<Wire.ErrorKind>,
    ): CredentialError => {
      if (error._tag !== "PluginRemoteError") return failed(transportMessage(plugin, error))
      if (holdsSecret(error.message) || holdsSecret(JSON.stringify(error.data)))
        return failed(`${name} put a secret in an error, so the app does not show it.`)
      const message =
        error.kind === "unknown"
          ? `${error.message} (${name} answered with error kind ${error.rawKind}, which this app does not know.)`
          : error.message
      const unmet = Option.getOrUndefined(
        Schema.decodeUnknownOption(RequirementsData)(error.data["unmet"]),
      )
      const tool = Option.getOrUndefined(Schema.decodeUnknownOption(ToolData)(error.data))
      return new CredentialError({
        kind: error.kind,
        message,
        ...(error.kind === "requirementNotMet" && unmet !== undefined ? { unmet } : {}),
        ...(error.kind === "toolMissing" && tool !== undefined
          ? { tool: { name: tool.tool, installUrl: tool.installUrl } }
          : {}),
      })
    }

    /**
     * Runs `use` on a session. A transport error, or a call given up, has
     * ended the session, so the next call starts another.
     */
    const withSession = <A>(
      use: (
        session: Session,
      ) => Effect.Effect<
        A,
        PluginTransportError | PluginRemoteError<Wire.ErrorKind> | CredentialError
      >,
    ): Effect.Effect<A, CredentialError> =>
      Effect.flatMap(ensure, (current) =>
        use(current.session).pipe(
          Effect.catch((error) =>
            error._tag === "CredentialError"
              ? Effect.fail(error)
              : Effect.andThen(
                  error._tag === "PluginRemoteError" ? Effect.void : retire(current),
                  Effect.fail(errorOf(error)),
                ),
          ),
          Effect.onInterrupt(() => retire(current)),
        ),
      )

    const infoOf = (configured: Wire.ConfigureResult) =>
      decodeInfo({
        methods: configured.methods.map((offered) => ({
          name: offered.name,
          label: offered.label,
          fields: offered.fields.map(({ name: field, label, required, secret, choices }) => ({
            name: field,
            label,
            required,
            secret,
            ...(choices === undefined
              ? {}
              : { choices: choices.map(({ value, label: text }) => ({ value, label: text })) }),
          })),
          ...(offered.oneOf === undefined ? {} : { oneOf: offered.oneOf }),
          ...(offered.unavailable === undefined
            ? {}
            : {
                unavailable: {
                  _tag: "CredentialError",
                  kind: offered.unavailable.kind,
                  message: offered.unavailable.message,
                },
              }),
        })),
        levels: configured.levels,
        sources: configured.sources,
        requirements: configured.requirements,
        names: configured.names,
      }).pipe(
        Effect.mapError(() => failed(`${name} described itself in a way this app cannot use.`)),
      )

    const identityOf = (what: string, wire: Wire.Identity) =>
      Effect.andThen(
        noSecretIn(what, wire),
        Effect.mapError(decodeIdentity(wire), () =>
          failed(`${name} answered ${what} with an identity this app cannot read.`),
        ),
      )

    const constraintsOf = (constraints: Constraints) => ({
      pins: { ...constraints.pins },
      requirements: constraints.requirements.map((requirement) => ({ ...requirement })),
    })

    const sourceOf = (source: ResolvedSource): Wire.Source => {
      switch (source.kind) {
        case "env":
          return Option.match(source.prefix, {
            onNone: () => ({ kind: "env" }),
            onSome: (prefix) => ({ kind: "env", prefix }),
          })
        case "values":
          return {
            kind: "values",
            from: source.from,
            values: Object.fromEntries(
              Object.entries(source.values).map(([key, { value }]) => [key, Redacted.value(value)]),
            ),
          }
        case "named":
          return { kind: "named", name: source.name }
      }
    }

    /** Checks a value marked `file`: an absolute path inside the state directory, owner-only. */
    const checkFile = (value: Wire.EnvValue) =>
      Effect.gen(function* () {
        const where = `${name} named ${value.name} a credential file`
        if (!path.isAbsolute(value.value)) return yield* failed(`${where} by a relative path.`)
        if (!(yield* files.isContainedInReal(value.value, config.stateDir)))
          return yield* failed(`${where} outside its state folder ${config.stateDir}.`)
        const stat = yield* files
          .stat(value.value)
          .pipe(Effect.mapError(() => failed(`${where} that is not there.`)))
        if (!isOwnerOnly(stat.mode))
          return yield* failed(`${where} that others can read (mode ${modeText(stat.mode)}).`)
      })

    const envOf = (wire: Wire.EnvResult) =>
      Effect.gen(function* () {
        const info = described
        const seen = new Set<string>()
        for (const value of wire.values) {
          if (info !== undefined && !info.names.includes(value.name))
            return yield* failed(`${name} returned ${value.name}, a name it did not declare.`)
          if (seen.has(value.name)) return yield* failed(`${name} returned ${value.name} twice.`)
          seen.add(value.name)
          if (!value.sensitive && holdsSecret(value.value))
            return yield* failed(
              `${name} returned a secret in ${value.name} without marking it sensitive.`,
            )
          if (value.file) yield* checkFile(value)
        }
        for (const value of wire.values) if (value.sensitive) remember(value.value)
        const expiresAt =
          wire.expiresAt === undefined
            ? Option.none()
            : Option.some(
                yield* decodeExpiry(wire.expiresAt).pipe(
                  Effect.mapError(() => failed(`${name} returned an expiry this app cannot read.`)),
                ),
              )
        return {
          values: wire.values.map((value): CredentialValue => ({
            name: value.name,
            value: Redacted.make(value.value),
            sensitive: value.sensitive,
            to: value.to,
            file: value.file,
          })),
          expiresAt,
        } satisfies CredentialEnv
      })

    const promptOf = (prompt: Wire.SignInPrompt): Effect.Effect<SignInEvent, CredentialError> =>
      Effect.gen(function* () {
        yield* noSecretIn("a sign-in prompt", prompt)
        switch (prompt.kind) {
          case "openUrl":
            if (prompt.url === undefined)
              return yield* failed(`${name} asked to open a page without naming it.`)
            return { _tag: "OpenUrl", url: prompt.url, code: Option.fromUndefinedOr(prompt.code) }
          case "showCode":
            if (prompt.code === undefined)
              return yield* failed(`${name} asked to show a code without giving it.`)
            return { _tag: "ShowCode", code: prompt.code }
          case "waiting":
            return { _tag: "Waiting" }
        }
      })

    return {
      describe: Effect.flatMap(ensure, () =>
        described === undefined
          ? Effect.die(new Error("a started session has described itself"))
          : Effect.succeed(described),
      ),

      detect: (sources, constraints) =>
        withSession((session) =>
          Effect.gen(function* () {
            const result = yield* session.call(Detect, {
              sources: sources.map(sourceOf),
              ...constraintsOf(constraints),
            })
            if (!result.found) return Option.none()
            yield* noSecretIn("a detection source's name", result.source)
            const identity = yield* identityOf("detect", result.identity)
            return Option.some({ identity, source: result.source })
          }),
        ),

      signIn: (chosen, fields, constraints) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const current = yield* ensure
            const offered = described?.methods.find((each) => each.name === chosen)
            // Rule 2: what the person types into a secret field is a secret from now on.
            for (const field of offered?.fields ?? [])
              if (field.secret && Object.hasOwn(fields, field.name))
                remember(Redacted.value(fields[field.name] as Redacted.Redacted<string>))
            /** Whether the plugin answered: with a result, or an error that ends only the call. */
            let answered = false
            return current.session
              .stream(SignIn, {
                method: chosen,
                fields: Object.fromEntries(
                  Object.entries(fields).map(([field, value]) => [field, Redacted.value(value)]),
                ),
                ...constraintsOf(constraints),
              })
              .pipe(
                Stream.mapEffect((item) => {
                  if (item._tag === "Notification") return promptOf(item.params)
                  answered = true
                  return Effect.map(identityOf("signIn", item.result), (identity): SignInEvent => ({
                    _tag: "SignedIn",
                    identity,
                  }))
                }),
                Stream.catch((error) => {
                  if (error._tag === "PluginRemoteError") answered = true
                  return Stream.fail(error._tag === "CredentialError" ? error : errorOf(error))
                }),
                // Closed before the plugin answered, the sign-in was given up or broke a
                // rule; either way the session is over, and the next call starts another.
                Stream.ensuring(Effect.suspend(() => (answered ? Effect.void : retire(current)))),
              )
          }),
        ),

      targets: (level, parent) =>
        withSession((session) =>
          Effect.gen(function* () {
            const result = yield* session.call(Targets, {
              level,
              ...Option.match(parent, { onNone: () => ({}), onSome: (id) => ({ parent: id }) }),
            })
            yield* noSecretIn("a target", result.targets)
            return result.targets.map(({ id, name: label }): Target => ({ id, name: label }))
          }),
        ),

      select: (targets) =>
        withSession((session) =>
          Effect.flatMap(session.call(Select, { targets: { ...targets } }), (identity) =>
            identityOf("select", identity),
          ),
        ),

      env: withSession((session) => Effect.flatMap(session.call(Env, {}), envOf)),

      // The plugin deletes what it wrote, then its process ends with the sign-in.
      signOut: Effect.flatMap(ensure, (current) =>
        withSession((session) => session.call(SignOut, {})).pipe(
          Effect.ensuring(retire(current)),
          Effect.asVoid,
        ),
      ),
    } satisfies CredentialProvider
  })

/** `CredentialProviders` whose every provider is a plugin, by its registry name. */
export const pluginCredentialProviders: Layer.Layer<
  CredentialProviders,
  never,
  PluginProcess | FileSystem
> = Layer.effect(
  CredentialProviders,
  Effect.gen(function* () {
    const owner = yield* PluginProcess
    const files = yield* FileSystem
    return CredentialProviders.of({
      open: (plugin, config) =>
        openPluginProvider(plugin, config).pipe(
          Effect.provideService(PluginProcess, owner),
          Effect.provideService(FileSystem, files),
        ),
    })
  }),
)
