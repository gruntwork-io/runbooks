/**
 * The fake credential plugin: the credential protocol
 * (`plugin/credential.schema.json`) answered from a script, by a
 * `PluginHandler`. It runs in memory (`memoryPluginProcess`) for the
 * engine's tests and a dev mode with no binaries, and as a process
 * (`packages/platform-node/src/fixtures/credentialFake.ts`) for the
 * credential client's tests through the transport owner. The contract
 * suite holds it to what the real plugins do.
 *
 * It answers as the real plugins do: nothing but `notConfigured` before
 * `configure`; `invalidParams` for a bad method, field, pin or requirement
 * before it does anything else; `notSignedIn` for `env`, `targets` and
 * `select` before a sign-in; a credential that expires by `Clock`, so a
 * test moves it with `TestClock`, and that `env` refreshes within 5 minutes
 * of its expiry when it can be; a sign-in that waits for the person
 * answers `timedOut` a second before its method's limit; and `signOut`
 * deletes the file it wrote. A script can make any method answer any
 * error kind, one the app does not know included, and `faults` break the
 * secret rules on purpose, for the client's tests.
 */
import path from "node:path"
import { Clock, Effect, Layer, Option, Schema } from "effect"
import * as Wire from "../plugin/generated/credential.ts"
import {
  memoryPluginProcess,
  type PluginFactory,
  type PluginHandler,
  type PluginRefusal,
} from "../plugin/memory.ts"
import { PROTOCOL_VERSION } from "../plugin/transport.ts"
import { FileSystem } from "../services/FileSystem.ts"
import { EXPIRY_WARNING_MILLIS } from "./lifecycle.ts"
import { pluginCredentialProviders } from "./plugin.ts"
import type { CredentialProviders } from "./provider.ts"

/** A login the fake knows, by the token that signs in as it. */
export interface FakeLogin {
  /** Typed into a method's `token` field, or found by a detection source under `<prefix>_TOKEN`. */
  readonly token: string
  readonly principal: string
  readonly kind: Wire.Identity["kind"]
  /** The target ids it may select at each level, by level name. At a level not listed, any. */
  readonly access?: { readonly [level: string]: ReadonlyArray<string> }
  readonly scopes?: ReadonlyArray<string>
  readonly roles?: ReadonlyArray<string>
  /** How long its credential lasts after a sign-in or a refresh. It never expires without one. */
  readonly lifetimeMillis?: number
  /**
   * Whether `env` gets a new credential once the last expires within
   * `EXPIRY_WARNING_MILLIS`, as the contract asks. Otherwise `env` gives the
   * last one until it has expired, then answers `expired`.
   */
  readonly refreshable?: boolean
  /** Its credential has expired already: signing in or detecting it answers `expired`. */
  readonly expired?: boolean
}

export interface FakeMethod {
  readonly name: string
  readonly label: string
  /** A field named `token` holds the token it signs in with. */
  readonly fields: ReadonlyArray<Wire.Field>
  readonly oneOf?: ReadonlyArray<ReadonlyArray<string>>
  /** Why it cannot be used: signing in with it answers this. */
  readonly unavailable?: { readonly kind: Wire.ErrorKind; readonly message: string }
  /** What it shows the person, in order, before it signs in. */
  readonly prompts?: ReadonlyArray<"openUrl" | "showCode" | "waiting">
  /** How long it then waits for the person: none, a time, or until it runs out of time. */
  readonly waitMillis?: number | "untilLimit"
  /** The token it signs in with when it has no `token` field: a browser sign-in. */
  readonly signsInAs?: string
}

/** A target, under its parent at the level before when it has one. */
export interface FakeTarget {
  readonly id: string
  readonly name: string
  readonly parent?: string
}

/** A way to break the secret rules or the declared names, for the credential client's tests. */
export type FakeFault =
  /** `env` returns a name `configure` did not list. */
  | "undeclaredName"
  /** `env` returns the token as not sensitive. */
  | "secretNotSensitive"
  /** A sign-in prompt's code is the token typed in. */
  | "secretInPrompt"
  /** Signing in with an unknown token answers an error that quotes it. */
  | "secretInError"
  /** The identity's principal is the token typed in. */
  | "secretInIdentity"
  /** The credentials file is written next to the state directory, not in it. */
  | "fileOutsideStateDir"
  /** The credentials file is written readable by everyone. */
  | "fileReadableByOthers"

export interface FakeScript {
  /** What every name it sets starts with: `FAKE` gives FAKE_TOKEN and FAKE_ACCOUNT. */
  readonly prefix: string
  readonly methods: ReadonlyArray<FakeMethod>
  readonly levels: ReadonlyArray<Wire.Level>
  /** The targets at each level, by level name. */
  readonly targets: { readonly [level: string]: ReadonlyArray<FakeTarget> }
  /** The detection sources it names itself, each with the token of the login it finds there. */
  readonly named?: { readonly [source: string]: string }
  readonly requirements: ReadonlyArray<Wire.RequirementKind>
  readonly logins: ReadonlyArray<FakeLogin>
  /** Whether `env` names a credentials file it writes in the state directory, owner-only. */
  readonly file?: boolean
  /** Errors to answer instead of a result, by method name: any kind, one the app does not know included. */
  readonly refuse?: { readonly [method: string]: PluginRefusal }
  readonly faults?: ReadonlyArray<FakeFault>
}

/** A script with every part a provider has: three methods, two levels, a named source, expiry. */
export const FAKE_SCRIPT: FakeScript = {
  prefix: "FAKE",
  methods: [
    {
      name: "token",
      label: "Token",
      fields: [{ name: "token", label: "Token", required: true, secret: true }],
    },
    {
      name: "browser",
      label: "Browser",
      fields: [],
      prompts: ["openUrl", "waiting"],
      signsInAs: "fake-browser-token-0001",
    },
    {
      name: "device",
      label: "Device code",
      fields: [
        {
          name: "region",
          label: "Region",
          required: false,
          secret: false,
          choices: [
            { value: "north", label: "North" },
            { value: "south", label: "South" },
          ],
        },
      ],
      prompts: ["showCode"],
      waitMillis: "untilLimit",
      signsInAs: "fake-browser-token-0001",
    },
  ],
  levels: [
    { name: "account", label: "Account", chosen: "afterSignIn" },
    { name: "role", label: "Role", chosen: "afterSignIn", optional: true },
  ],
  targets: {
    account: [
      { id: "111111111111", name: "Production" },
      { id: "222222222222", name: "Staging" },
    ],
    role: [
      { id: "Admin", name: "Admin", parent: "111111111111" },
      { id: "ReadOnly", name: "Read only", parent: "111111111111" },
      { id: "Admin", name: "Admin", parent: "222222222222" },
    ],
  },
  named: { cli: "fake-cli-token-0001" },
  requirements: ["scopes"],
  logins: [
    {
      token: "fake-token-0001-secret",
      principal: "fake-user@example.com",
      kind: "user",
      scopes: ["read"],
      lifetimeMillis: 60 * 60_000,
      refreshable: true,
    },
    {
      token: "fake-browser-token-0001",
      principal: "fake-browser@example.com",
      kind: "user",
      access: { account: ["111111111111"] },
      scopes: ["read", "write"],
    },
    {
      token: "fake-cli-token-0001",
      principal: "fake-cli@example.com",
      kind: "user",
      access: { account: ["222222222222"] },
    },
    {
      token: "fake-expired-token-0001",
      principal: "fake-expired@example.com",
      kind: "user",
      expired: true,
    },
  ],
  file: true,
}

/** The name `env` gives a value: `FAKE_TOKEN`, `FAKE_ACCOUNT`. */
export const fakeName = (script: Pick<FakeScript, "prefix">, part: string) =>
  `${script.prefix}_${part.toUpperCase()}`

/** Every name the fake may set: its `configure`'s `names`. */
export const fakeNames = (script: Pick<FakeScript, "prefix" | "levels" | "file">) => [
  fakeName(script, "token"),
  ...script.levels.map((level) => fakeName(script, level.name)),
  ...(script.file === true ? [fakeName(script, "credentialsFile")] : []),
]

/** The file `env` names, in the state directory. */
const CREDENTIALS_FILE = "credentials.json"
/** Owner only: what the real plugins write a credential file with. */
const FILE_MODE = 0o600
/** A plugin answers `timedOut` this long before its method's limit, as the contract asks. */
const ANSWER_BEFORE_LIMIT_MILLIS = 1_000

interface SignedIn {
  readonly login: FakeLogin
  readonly method: string
  readonly selected: Map<string, Wire.Target | null>
  issuedAt: number
}

interface Configured {
  readonly script: FakeScript
  readonly stateDir: string
  readonly limits: { readonly [method: string]: number }
}

const refusal = (kind: Wire.ErrorKind, message: string, data?: PluginRefusal["data"]) =>
  Effect.fail<PluginRefusal>(data === undefined ? { kind, message } : { kind, message, data })

const invalid = (message: string) => refusal("invalidParams", message)

/** Decodes `params`, or answers `invalidParams` naming no value: one could be a secret. */
const decodeParams = <T>(schema: Schema.Codec<T, unknown>, params: unknown, method: string) =>
  Effect.mapError(Schema.decodeUnknownEffect(schema)(params), () => ({
    kind: "invalidParams",
    message: `The params of ${method} do not match its schema.`,
  }))

/**
 * The fake plugin. `scriptOf` reads the script from `configure`'s
 * settings, or ignores them; it returns a message when they name none.
 * `environment` is its process's, where an `env` source finds a token.
 */
export const fakeCredentialPlugin =
  (
    scriptOf: (settings: { readonly [name: string]: string }) => FakeScript | string,
  ): PluginFactory<FileSystem> =>
  (environment) =>
    Effect.sync((): PluginHandler<FileSystem> => {
      let configured: Configured | undefined
      let signedIn: SignedIn | undefined

      const faulty = (fault: FakeFault) => configured?.script.faults?.includes(fault) === true

      const configure = (params: unknown) =>
        Effect.gen(function* () {
          const wire = yield* decodeParams(Wire.ConfigureParams, params, "configure")
          if (wire.protocolVersion !== PROTOCOL_VERSION)
            return yield* refusal(
              "unsupportedProtocolVersion",
              `The fake speaks protocol ${PROTOCOL_VERSION} only.`,
            )
          if (!path.isAbsolute(wire.stateDir))
            return yield* invalid("stateDir is not an absolute path.")
          const script = scriptOf(wire.settings ?? {})
          if (typeof script === "string") return yield* invalid(script)
          configured = { script, stateDir: wire.stateDir, limits: wire.callTimeoutsMillis }
          return {
            methods: script.methods.map((method) => ({
              name: method.name,
              label: method.label,
              fields: method.fields,
              ...(method.oneOf === undefined ? {} : { oneOf: method.oneOf }),
              ...(method.unavailable === undefined ? {} : { unavailable: method.unavailable }),
            })),
            levels: script.levels,
            sources: Object.keys(script.named ?? {}),
            requirements: script.requirements,
            names: fakeNames(script),
            protocolVersion: PROTOCOL_VERSION,
            driverVersion: "0.0.0-fake",
          } satisfies Wire.ConfigureResult
        })

      /** Pins at levels it declares, and requirements of kinds it checks; `invalidParams` otherwise. */
      const checkConstraints = (
        script: FakeScript,
        pins: Wire.Pins,
        requirements: ReadonlyArray<Wire.Requirement>,
      ) =>
        Effect.gen(function* () {
          for (const level of Object.keys(pins))
            if (!script.levels.some((declared) => declared.name === level))
              return yield* invalid(`The fake has no level ${level}.`)
          for (const requirement of requirements)
            if (!script.requirements.includes(requirement.kind))
              return yield* invalid(`The fake checks no ${requirement.kind}.`)
        })

      /** The login's access against the pins and requirements: `pinMismatch`, `requirementNotMet`. */
      const accept = (
        script: FakeScript,
        login: FakeLogin,
        pins: Wire.Pins,
        requirements: ReadonlyArray<Wire.Requirement>,
      ) =>
        Effect.gen(function* () {
          if (login.expired === true)
            return yield* refusal("expired", "The login has expired: sign in again.")
          for (const [level, id] of Object.entries(pins))
            if (!mayReach(script, login, level, id))
              return yield* refusal("pinMismatch", `The login cannot reach ${level} ${id}.`)
          const unmet = requirements.flatMap((requirement): Array<Wire.Requirement> => {
            if (requirement.kind === "scopes") {
              const missing = requirement.scopes.filter((scope) => !login.scopes?.includes(scope))
              return missing.length === 0 ? [] : [{ kind: "scopes", scopes: missing }]
            }
            const missing = requirement.roles.filter((role) => !login.roles?.includes(role.role))
            return missing.length === 0 ? [] : [{ kind: "roles", roles: missing }]
          })
          if (unmet.length > 0)
            return yield* refusal("requirementNotMet", "The login lacks what the block requires.", {
              unmet,
            })
          const selected = new Map<string, Wire.Target | null>()
          for (const [level, id] of Object.entries(pins)) {
            const target = targetOf(script, level, id)
            if (target !== undefined) selected.set(level, target)
          }
          return selected
        })

      const signInWith = (
        login: FakeLogin,
        method: string,
        selected: Map<string, Wire.Target | null>,
      ) =>
        Effect.map(Clock.currentTimeMillis, (now) => {
          signedIn = { login, method, selected, issuedAt: now }
          return signedIn
        })

      const identityOf = (state: SignedIn) => ({
        principal: faulty("secretInIdentity") ? state.login.token : state.login.principal,
        kind: state.login.kind,
        method: state.method,
        targets: Object.fromEntries(state.selected),
        ...Option.match(expiryOf(state), {
          onNone: () => ({}),
          onSome: (expiresAt) => ({ expiresAt: new Date(expiresAt).toISOString() }),
        }),
      })

      const loginOf = (script: FakeScript, token: string) =>
        script.logins.find((login) => login.token === token)

      const detect = (script: FakeScript, params: unknown) =>
        Effect.gen(function* () {
          const wire = yield* decodeParams(Wire.DetectParams, params, "detect")
          yield* checkConstraints(script, wire.pins, wire.requirements)
          const tokenName = fakeName(script, "token")
          for (const source of wire.sources) {
            const named = script.named ?? {}
            if (source.kind === "named" && !Object.hasOwn(named, source.name))
              return yield* invalid(`The fake names no source ${source.name}.`)
            const found =
              source.kind === "env"
                ? { token: environment[`${source.prefix ?? ""}${tokenName}`], source: "env" }
                : source.kind === "values"
                  ? { token: source.values[tokenName], source: source.from }
                  : { token: named[source.name], source: source.name }
            if (found.token === undefined) continue
            const login = loginOf(script, found.token)
            if (login === undefined)
              return yield* refusal(
                "accessDenied",
                `The token in ${found.source} is not one the fake knows.`,
              )
            const selected = yield* accept(script, login, wire.pins, wire.requirements)
            const state = yield* signInWith(login, found.source, selected)
            return { found: true, identity: identityOf(state), source: found.source }
          }
          return { found: false }
        })

      const signIn = (
        script: FakeScript,
        limits: Configured["limits"],
        params: unknown,
        notify: Parameters<PluginHandler["answer"]>[2],
      ) =>
        Effect.gen(function* () {
          const wire = yield* decodeParams(Wire.SignInParams, params, "signIn")
          const method = script.methods.find((offered) => offered.name === wire.method)
          if (method === undefined) return yield* invalid(`The fake has no method ${wire.method}.`)
          if (method.unavailable !== undefined)
            return yield* refusal(method.unavailable.kind, method.unavailable.message)
          for (const name of Object.keys(wire.fields))
            if (!method.fields.some((field) => field.name === name))
              return yield* invalid(`${method.name} has no field ${name}.`)
          for (const field of method.fields) {
            const value = wire.fields[field.name]
            if (field.required && (value === undefined || value === ""))
              return yield* invalid(`${field.label} is required.`)
            if (value !== undefined && field.choices !== undefined)
              if (!field.choices.some((choice) => choice.value === value))
                return yield* invalid(`${field.label} is not one of its choices.`)
          }
          for (const group of method.oneOf ?? [])
            if (group.filter((name) => (wire.fields[name] ?? "") !== "").length !== 1)
              return yield* invalid(`Give exactly one of ${group.join(", ")}.`)
          yield* checkConstraints(script, wire.pins, wire.requirements)

          const token = wire.fields["token"] ?? method.signsInAs ?? ""
          for (const kind of method.prompts ?? []) {
            const code = faulty("secretInPrompt") ? token : "FAKE-CODE"
            yield* notify(
              "signIn.prompt",
              kind === "openUrl"
                ? { kind, url: "https://fake.invalid/device", code }
                : kind === "showCode"
                  ? { kind, code }
                  : { kind },
            )
          }
          const budget = (limits["signIn"] ?? Number.POSITIVE_INFINITY) - ANSWER_BEFORE_LIMIT_MILLIS
          const wait = method.waitMillis === "untilLimit" ? budget : (method.waitMillis ?? 0)
          if (wait > 0) yield* Effect.sleep(Math.min(wait, budget))
          if (wait >= budget)
            return yield* refusal("timedOut", "Nobody finished the sign-in in time.")

          const login = loginOf(script, token)
          if (login === undefined)
            return yield* refusal(
              "accessDenied",
              faulty("secretInError")
                ? `The token ${token} is not one the fake knows.`
                : "The token is not one the fake knows.",
            )
          const selected = yield* accept(script, login, wire.pins, wire.requirements)
          return identityOf(yield* signInWith(login, method.name, selected))
        })

      const targets = (script: FakeScript, params: unknown) =>
        Effect.gen(function* () {
          const wire = yield* decodeParams(Wire.TargetsParams, params, "targets")
          const level = script.levels.find((declared) => declared.name === wire.level)
          if (level === undefined) return yield* invalid(`The fake has no level ${wire.level}.`)
          if (level.chosen === "afterSignIn" && signedIn === undefined)
            return yield* refusal("notSignedIn", "Sign in first.")
          const login = signedIn?.login
          return {
            targets: (script.targets[level.name] ?? [])
              .filter((target) => wire.parent === undefined || target.parent === wire.parent)
              .filter(
                (target) => login === undefined || mayReach(script, login, level.name, target.id),
              )
              .map(({ id, name }) => ({ id, name })),
          }
        })

      const select = (script: FakeScript, params: unknown) =>
        Effect.gen(function* () {
          const wire = yield* decodeParams(Wire.SelectParams, params, "select")
          const state = signedIn
          if (state === undefined) return yield* refusal("notSignedIn", "Sign in first.")
          for (const [name, id] of Object.entries(wire.targets)) {
            const level = script.levels.find((declared) => declared.name === name)
            if (level === undefined) return yield* invalid(`The fake has no level ${name}.`)
            if (id === null) {
              if (level.optional !== true) return yield* invalid(`Choose a ${level.label}.`)
              state.selected.set(name, null)
              continue
            }
            const target = targetOf(script, name, id)
            if (target === undefined || !mayReach(script, state.login, name, id))
              return yield* invalid(`${id} is not a ${level.label} the login can choose.`)
            state.selected.set(name, target)
          }
          return identityOf(state)
        })

      const env = (config: Configured) =>
        Effect.gen(function* () {
          const { script, stateDir } = config
          const state = signedIn
          if (state === undefined) return yield* refusal("notSignedIn", "Sign in first.")
          const now = yield* Clock.currentTimeMillis
          const expiry = expiryOf(state)
          // The contract refreshes a credential that expires within the engine's warning window.
          if (Option.isSome(expiry) && expiry.value - now <= EXPIRY_WARNING_MILLIS) {
            if (state.login.refreshable === true) state.issuedAt = now
            else if (now >= expiry.value)
              return yield* refusal("expired", "The credential has expired: sign in again.")
          }
          const values: Array<Wire.EnvValue> = [
            {
              name: fakeName(script, "token"),
              value: state.login.token,
              sensitive: !faulty("secretNotSensitive"),
              to: ["env"],
              file: false,
            },
          ]
          for (const [level, target] of state.selected)
            if (target !== null)
              values.push({
                name: fakeName(script, level),
                value: target.id,
                sensitive: false,
                to: ["env", "output"],
                file: false,
              })
          if (script.file === true) {
            const file = faulty("fileOutsideStateDir")
              ? path.join(path.dirname(stateDir), CREDENTIALS_FILE)
              : path.join(stateDir, CREDENTIALS_FILE)
            const files = yield* FileSystem
            yield* files.rm(file, { force: true }).pipe(
              Effect.andThen(
                files.writeFile(file, JSON.stringify({ token: state.login.token }), {
                  mode: faulty("fileReadableByOthers") ? 0o644 : FILE_MODE,
                }),
              ),
              Effect.mapError(() => ({
                kind: "internal",
                message: "The credentials file could not be written.",
              })),
            )
            values.push({
              name: fakeName(script, "credentialsFile"),
              value: file,
              sensitive: false,
              to: ["env"],
              file: true,
            })
          }
          if (faulty("undeclaredName"))
            values.push({
              name: fakeName(script, "undeclared"),
              value: "x",
              sensitive: false,
              to: ["env"],
              file: false,
            })
          return {
            values,
            ...Option.match(expiryOf(state), {
              onNone: () => ({}),
              onSome: (expiresAt) => ({ expiresAt: new Date(expiresAt).toISOString() }),
            }),
          } satisfies Wire.EnvResult
        })

      const signOut = (config: Configured) =>
        Effect.gen(function* () {
          signedIn = undefined
          const files = yield* FileSystem
          yield* files.rm(path.join(config.stateDir, CREDENTIALS_FILE), { force: true }).pipe(
            Effect.mapError(() => ({
              kind: "internal",
              message: "The credentials file could not be deleted.",
            })),
          )
          return {}
        })

      return {
        answer: (method, params, notify) =>
          Effect.gen(function* () {
            const refused = configured?.script.refuse?.[method]
            if (refused !== undefined) return yield* Effect.fail(refused)
            if (method === "configure") return yield* configure(params)
            const config = configured
            if (config === undefined)
              return yield* refusal("notConfigured", "Call configure first.")
            switch (method) {
              case "detect":
                return yield* detect(config.script, params)
              case "signIn":
                return yield* signIn(config.script, config.limits, params, notify)
              case "targets":
                return yield* targets(config.script, params)
              case "select":
                return yield* select(config.script, params)
              case "env":
                return yield* env(config)
              case "signOut":
                return yield* signOut(config)
              default:
                return yield* invalid(`The fake has no method ${method}.`)
            }
          }),
      }
    })

/** When the credential expires, in epoch milliseconds: never without a lifetime. */
const expiryOf = (state: SignedIn): Option.Option<number> =>
  state.login.lifetimeMillis === undefined
    ? Option.none()
    : Option.some(state.issuedAt + state.login.lifetimeMillis)

const targetOf = (script: FakeScript, level: string, id: string): Wire.Target | undefined => {
  const found = script.targets[level]?.find((target) => target.id === id)
  return found === undefined ? undefined : { id: found.id, name: found.name }
}

/** Whether `login` may select target `id` at `level`: one the level lists, and the login's access allows. */
const mayReach = (script: FakeScript, login: FakeLogin, level: string, id: string) =>
  targetOf(script, level, id) !== undefined && (login.access?.[level]?.includes(id) ?? true)

/**
 * `CredentialProviders` whose providers are the fake, run in memory behind
 * the credential client: each provider name in `scripts` answers from its
 * script, and any other name is not installed. The engine's tests use it,
 * and so can a dev mode with no binaries.
 */
export const fakeCredentialProviders = (scripts: {
  readonly [provider: string]: FakeScript
}): Layer.Layer<CredentialProviders, never, FileSystem> =>
  pluginCredentialProviders.pipe(
    Layer.provide(
      memoryPluginProcess(
        "runbooks/fake",
        Object.fromEntries(
          Object.entries(scripts).map(([name, script]) => [
            `credential/${name}`,
            fakeCredentialPlugin(() => script),
          ]),
        ),
      ),
    ),
  )
