/**
 * The credential client against plugins in memory (`memoryPluginProcess`):
 * each test scripts what the plugin answers, a broken plugin included, and
 * checks what the engine gets. The client against a real process, through
 * the transport owner, is in
 * `packages/platform-node/src/integration/credential/client.test.ts`.
 */
import { describe, expect, it } from "bun:test"
import { DateTime, Effect, Exit, Fiber, Layer, Option, Redacted, type Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { CredentialError } from "@runbooks/blocks-core/contract"
import * as Wire from "../plugin/generated/credential.ts"
import { memoryPluginProcess, type PluginHandler, type PluginRefusal } from "../plugin/memory.ts"
import { PROTOCOL_VERSION } from "../plugin/transport.ts"
import { FileSystem, type FileSystemShape } from "../services/FileSystem.ts"
import { testFileSystem } from "../test-utils/TestFileSystem.ts"
import { CREDENTIAL_LIMITS, openPluginProvider, pluginCredentialProviders } from "./plugin.ts"
import { type CredentialProvider, CredentialProviders, type ProviderConfig } from "./provider.ts"

const STATE = "/state/s1/cloud"
/** Long enough to be looked for: the client ignores a secret under 8 characters. */
const SECRET = "typed-secret-0001"
const RETURNED_SECRET = "returned-secret-0001"

const CONFIGURED: Wire.ConfigureResult = {
  methods: [
    {
      name: "token",
      label: "Token",
      fields: [
        { name: "token", label: "Token", required: true, secret: true },
        { name: "region", label: "Region", required: false, secret: false },
      ],
    },
    {
      name: "cli",
      label: "CLI",
      fields: [],
      unavailable: { kind: "toolMissing", message: "Install the CLI." },
    },
  ],
  levels: [{ name: "account", label: "Account", chosen: "afterSignIn" }],
  sources: ["cli"],
  requirements: ["scopes"],
  names: ["CLOUD_TOKEN", "CLOUD_ACCOUNT", "CLOUD_FILE"],
  protocolVersion: PROTOCOL_VERSION,
  driverVersion: "0.0.0",
}

const IDENTITY: Wire.Identity = {
  principal: "someone@example.com",
  kind: "user",
  method: "token",
  targets: { account: { id: "111", name: "Production" } },
}

const value = (name: string, text: string, more: Partial<Wire.EnvValue> = {}): Wire.EnvValue => ({
  name,
  value: text,
  sensitive: false,
  to: ["env"],
  file: false,
  ...more,
})

type Answer = (
  params: unknown,
  notify: Parameters<PluginHandler["answer"]>[2],
) => Effect.Effect<unknown, PluginRefusal, FileSystem>

/** What each process of the plugin got and did, in the order they started. */
interface Processes {
  readonly envs: Array<{ readonly [name: string]: string }>
  readonly configures: Array<unknown>
  /** For each process, whether a call to it was given up and interrupted. */
  readonly interrupted: Array<boolean>
}

/**
 * A plugin whose `configure` answers `configured` (by process, from the
 * second on when it is a list) and whose other methods answer `answers`.
 */
const scripted = (
  answers: { readonly [method: string]: Answer },
  processes: Processes,
  configured: ReadonlyArray<Wire.ConfigureResult> = [CONFIGURED],
) => ({
  "credential/cloud": (env: { readonly [name: string]: string }) =>
    Effect.sync((): PluginHandler<FileSystem> => {
      const index = processes.envs.length
      processes.envs.push(env)
      processes.interrupted.push(false)
      return {
        answer: (method, params, notify) => {
          if (method === "configure") {
            processes.configures.push(params)
            return Effect.succeed(configured[Math.min(index, configured.length - 1)])
          }
          const answer = Object.hasOwn(answers, method) ? answers[method] : undefined
          return answer === undefined
            ? Effect.fail({ kind: "invalidParams", message: `no ${method} in this test` })
            : answer(params, notify).pipe(
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    processes.interrupted[index] = true
                  }),
                ),
              )
        },
      }
    }),
})

const config = (more: Partial<ProviderConfig> = {}): ProviderConfig => ({
  stateDir: STATE,
  environment: new Map([
    ["PATH", Redacted.make("/usr/bin:/bin")],
    ["CLOUD_TOKEN", Redacted.make("ambient")],
  ]),
  caBundleFile: Option.none(),
  proxy: Option.none(),
  settings: { region: "north" },
  ...more,
})

/** An in-memory filesystem with the block's state folder made owner-only, as the engine makes it. */
const stateFolder = () => {
  const fs = testFileSystem({}, [])
  Effect.runSync(fs.mkdir(STATE, { recursive: true, mode: 0o700 }))
  return fs
}

/** Runs `use` on a provider of the scripted plugin; `processes` notes each process it started. */
const withProvider = <A, E>(
  answers: { readonly [method: string]: Answer },
  use: (
    provider: CredentialProvider,
    processes: Processes,
    fs: FileSystemShape,
  ) => Effect.Effect<A, E, Scope.Scope>,
  options: {
    readonly configured?: ReadonlyArray<Wire.ConfigureResult>
    readonly config?: ProviderConfig
  } = {},
): Promise<A> => {
  const processes: Processes = { envs: [], configures: [], interrupted: [] }
  const fs = stateFolder()
  const files = Layer.succeed(FileSystem, fs)
  const owner = memoryPluginProcess(
    "runbooks/test",
    scripted(answers, processes, options.configured),
  )
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const provider = yield* openPluginProvider("cloud", options.config ?? config())
        return yield* use(provider, processes, fs)
      }),
    ).pipe(Effect.provide(Layer.provideMerge(owner, files))),
  )
}

const failureOf = <A>(effect: Effect.Effect<A, CredentialError>) =>
  Effect.map(Effect.exit(effect), (exit) => {
    if (Exit.isSuccess(exit)) throw new Error("it succeeded")
    const error = Exit.findErrorOption(exit)
    if (Option.isNone(error)) throw new Error("it died")
    return error.value
  })

const refuse =
  (kind: string, message: string, data?: PluginRefusal["data"]): Answer =>
  () =>
    Effect.fail(data === undefined ? { kind, message } : { kind, message, data })

const answers =
  (result: unknown): Answer =>
  () =>
    Effect.succeed(result)

/** A sign-in that answers `IDENTITY` after `prompts`. */
const signingIn =
  (prompts: ReadonlyArray<{ readonly [field: string]: unknown }> = []): Answer =>
  (_params, notify) =>
    Effect.andThen(
      Effect.forEach(prompts, (prompt) => notify("signIn.prompt", prompt), { discard: true }),
      Effect.succeed(IDENTITY),
    )

const signIn = (provider: CredentialProvider, fields: Record<string, string> = { token: SECRET }) =>
  Stream.runCollect(
    provider.signIn(
      "token",
      Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, Redacted.make(v)])),
      { pins: {}, requirements: [] },
    ),
  )

// ---------------------------------------------------------------------------
// The process
// ---------------------------------------------------------------------------

describe("the plugin's process", () => {
  it("starts on the provider's first call, not when it is opened, and serves every call after", async () => {
    const started = await withProvider(
      { detect: answers({ found: false }) },
      (provider, processes) =>
        Effect.gen(function* () {
          const before = processes.envs.length
          yield* provider.describe
          yield* provider.detect([{ kind: "env", prefix: Option.none() }], {
            pins: {},
            requirements: [],
          })
          return [before, processes.envs.length]
        }),
    )
    expect(started).toEqual([0, 1])
  })

  it("is configured with the block's state folder, network settings, settings and each method's limit", async () => {
    const configures = await withProvider(
      {},
      (provider, processes) => Effect.as(provider.describe, processes.configures),
      {
        config: config({
          caBundleFile: Option.some("/etc/corp/ca.pem"),
          proxy: Option.some("http://proxy.corp:3128"),
        }),
      },
    )
    expect(configures).toEqual([
      {
        protocolVersion: PROTOCOL_VERSION,
        caller: "runbooks/test",
        callTimeoutsMillis: CREDENTIAL_LIMITS,
        stateDir: STATE,
        caBundleFile: "/etc/corp/ca.pem",
        proxy: "http://proxy.corp:3128",
        settings: { region: "north" },
      },
    ])
  })

  it("runs with the environment the engine built for it, and nothing else", async () => {
    const envs = await withProvider({}, (provider, processes) =>
      Effect.as(provider.describe, processes.envs),
    )
    expect(envs).toEqual([{ PATH: "/usr/bin:/bin", CLOUD_TOKEN: "ambient" }])
  })

  it("ends with a sign-in given up, and the next call starts a fresh one", async () => {
    const result = await withProvider(
      {
        signIn: (_params, notify) =>
          Effect.andThen(notify("signIn.prompt", { kind: "waiting" }), Effect.never),
        env: refuse("notSignedIn", "Sign in first."),
      },
      (provider, processes) =>
        Effect.gen(function* () {
          const shown = yield* Stream.runCollect(
            Stream.take(
              provider.signIn(
                "token",
                { token: Redacted.make(SECRET) },
                { pins: {}, requirements: [] },
              ),
              1,
            ),
          )
          const after = yield* failureOf(provider.env)
          return { shown, after: after.kind, processes }
        }),
    )
    expect(result.shown).toEqual([{ _tag: "Waiting" }])
    expect(result.processes.envs).toHaveLength(2)
    expect(result.processes.interrupted).toEqual([true, false])
    expect(result.after).toBe("notSignedIn")
  })

  it("ends after it signs out, and the next call starts a fresh one", async () => {
    const started = await withProvider(
      { signOut: answers({}), detect: answers({ found: false }) },
      (provider, processes) =>
        Effect.gen(function* () {
          yield* provider.describe
          yield* provider.signOut
          const between = processes.envs.length
          yield* provider.detect([], { pins: {}, requirements: [] })
          return [between, processes.envs.length]
        }),
    )
    expect(started).toEqual([1, 2])
  })

  it("starts again after a transport error, which is providerFailed", async () => {
    const result = await withProvider(
      { targets: answers({ targets: "not a list" }), detect: answers({ found: false }) },
      (provider, processes) =>
        Effect.gen(function* () {
          const error = yield* failureOf(provider.targets("account", Option.none()))
          yield* provider.detect([], { pins: {}, requirements: [] })
          return { error, started: processes.envs.length }
        }),
    )
    expect(result.error.kind).toBe("providerFailed")
    expect(result.error.message).toContain("broke the protocol")
    expect(result.started).toBe(2)
  })

  it("keeps running after the plugin's own timedOut, which ends only that call", async () => {
    const result = await withProvider(
      {
        detect: refuse("timedOut", "The SSO portal did not answer."),
        env: refuse("notSignedIn", "no"),
      },
      (provider, processes) =>
        Effect.gen(function* () {
          const error = yield* failureOf(provider.detect([], { pins: {}, requirements: [] }))
          yield* Effect.exit(provider.env)
          return { kind: error.kind, started: processes.envs.length }
        }),
    )
    expect(result).toEqual({ kind: "timedOut", started: 1 })
  })

  it("refuses a fresh process that describes other levels or names than the first", async () => {
    const error = await withProvider(
      { signOut: answers({}) },
      (provider) =>
        Effect.gen(function* () {
          yield* provider.describe
          yield* provider.signOut
          return yield* failureOf(provider.describe)
        }),
      { configured: [CONFIGURED, { ...CONFIGURED, names: [...CONFIGURED.names, "CLOUD_MORE"] }] },
    )
    expect(error.kind).toBe("providerFailed")
  })
})

describe("plugin credential providers", () => {
  it("open a block's provider by its registry name, as a plugin through the owner", async () => {
    const processes: Processes = { envs: [], configures: [], interrupted: [] }
    const info = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const providers = yield* CredentialProviders
          const provider = yield* providers.open("cloud", config())
          return yield* provider.describe
        }),
      ).pipe(
        Effect.provide(
          pluginCredentialProviders.pipe(
            Layer.provideMerge(memoryPluginProcess("runbooks/test", scripted({}, processes))),
            Layer.provideMerge(Layer.succeed(FileSystem, stateFolder())),
          ),
        ),
      ),
    )
    expect(info.names).toEqual(CONFIGURED.names)
    expect(processes.envs).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// What the engine gets
// ---------------------------------------------------------------------------

describe("what the engine gets", () => {
  it("describes the methods, levels and names configure answered, an unavailable method's reason as an error", async () => {
    const info = await withProvider({}, (provider) => provider.describe)
    expect(info.names).toEqual(CONFIGURED.names)
    expect(info.levels).toEqual(CONFIGURED.levels)
    expect(info.methods[0]?.fields.map((field) => [field.name, field.secret])).toEqual([
      ["token", true],
      ["region", false],
    ])
    const unavailable = info.methods[1]?.unavailable
    expect(unavailable).toBeInstanceOf(CredentialError)
    expect(unavailable).toMatchObject({ kind: "toolMissing", message: "Install the CLI." })
  })

  it("gives each error kind as the plugin answered it", async () => {
    const kinds = Wire.ErrorKind.literals.filter((kind) => kind !== "notConfigured")
    for (const kind of kinds) {
      const error = await withProvider({ detect: refuse(kind, `It was ${kind}.`) }, (provider) =>
        failureOf(provider.detect([], { pins: {}, requirements: [] })),
      )
      expect([error.kind, error.message]).toEqual([kind, `It was ${kind}.`])
    }
  })

  it("gives an error kind this app does not know as unknown, naming the plugin's kind", async () => {
    const error = await withProvider(
      { detect: refuse("quotaExceeded", "Too many calls.") },
      (provider) => failureOf(provider.detect([], { pins: {}, requirements: [] })),
    )
    expect(error.kind).toBe("unknown")
    expect(error.message).toContain("Too many calls.")
    expect(error.message).toContain("quotaExceeded")
  })

  it("gives what a requirementNotMet lacks, and the tool a toolMissing names", async () => {
    const unmet = [{ kind: "scopes", scopes: ["admin"] }] as const
    const [lacking, missing] = await withProvider(
      {
        detect: refuse("requirementNotMet", "It lacks admin.", { unmet }),
        targets: refuse("toolMissing", "Install the CLI.", {
          tool: "cloud",
          installUrl: "https://cloud.example/install",
        }),
      },
      (provider) =>
        Effect.all([
          failureOf(provider.detect([], { pins: {}, requirements: [] })),
          failureOf(provider.targets("account", Option.none())),
        ]),
    )
    expect(lacking.unmet).toEqual(unmet)
    expect(missing.tool).toEqual({ name: "cloud", installUrl: "https://cloud.example/install" })
  })

  it("gives sign-in prompts as events, then the identity", async () => {
    const events = await withProvider(
      {
        signIn: signingIn([
          { kind: "openUrl", url: "https://cloud.example/device", code: "ABCD-1234" },
          { kind: "showCode", code: "ABCD-1234" },
          { kind: "waiting" },
        ]),
      },
      (provider) => Effect.andThen(provider.describe, signIn(provider)),
    )
    expect(events.map((event) => event._tag)).toEqual([
      "OpenUrl",
      "ShowCode",
      "Waiting",
      "SignedIn",
    ])
    expect(events[0]).toEqual({
      _tag: "OpenUrl",
      url: "https://cloud.example/device",
      code: Option.some("ABCD-1234"),
    })
  })

  it("gives env's values Redacted, with their expiry", async () => {
    const env = await withProvider(
      {
        env: answers({
          values: [
            value("CLOUD_TOKEN", RETURNED_SECRET, { sensitive: true }),
            value("CLOUD_ACCOUNT", "111"),
          ],
          expiresAt: "2026-11-25T18:00:00Z",
        }),
      },
      (provider) => provider.env,
    )
    expect(
      env.values.map((each) => [each.name, Redacted.isRedacted(each.value), each.sensitive]),
    ).toEqual([
      ["CLOUD_TOKEN", true, true],
      ["CLOUD_ACCOUNT", true, false],
    ])
    expect(Option.map(env.expiresAt, DateTime.formatIso)).toEqual(
      Option.some("2026-11-25T18:00:00.000Z"),
    )
  })
})

// ---------------------------------------------------------------------------
// The secret rules
// ---------------------------------------------------------------------------

describe("the secret rules", () => {
  /** The error, after checking its message quotes neither secret. */
  const quotesNoSecret = (error: CredentialError) => {
    expect(error.message).not.toContain(SECRET)
    expect(error.message).not.toContain(RETURNED_SECRET)
    return error
  }

  it("refuses an env value with a name configure did not declare", async () => {
    const error = await withProvider(
      { env: answers({ values: [value("CLOUD_OTHER", "x")] }) },
      (provider) => Effect.andThen(provider.describe, failureOf(provider.env)),
    )
    expect(error.kind).toBe("providerFailed")
    expect(error.message).toContain("CLOUD_OTHER")
  })

  it("refuses a secret typed into a sign-in that env returns as not sensitive", async () => {
    const error = await withProvider(
      { signIn: signingIn(), env: answers({ values: [value("CLOUD_TOKEN", SECRET)] }) },
      (provider) =>
        Effect.gen(function* () {
          yield* provider.describe
          yield* signIn(provider)
          return yield* failureOf(provider.env)
        }),
    )
    expect(quotesNoSecret(error).kind).toBe("providerFailed")
  })

  it("stops a sign-in whose prompt shows a typed secret, and ends the plugin's process", async () => {
    const result = await withProvider(
      { signIn: signingIn([{ kind: "showCode", code: SECRET }]) },
      (provider, processes) =>
        Effect.gen(function* () {
          yield* provider.describe
          const error = yield* failureOf(signIn(provider))
          yield* provider.describe
          return { error, started: processes.envs.length }
        }),
    )
    expect(quotesNoSecret(result.error).kind).toBe("providerFailed")
    expect(result.started).toBe(2)
  })

  it("does not show an error that quotes a typed secret", async () => {
    const error = await withProvider(
      { signIn: refuse("accessDenied", `The token ${SECRET} is wrong.`) },
      (provider) => Effect.andThen(provider.describe, failureOf(signIn(provider))),
    )
    expect(quotesNoSecret(error).kind).toBe("providerFailed")
  })

  it("does not show an error whose data quotes a secret env returned", async () => {
    const error = await withProvider(
      {
        env: answers({ values: [value("CLOUD_TOKEN", RETURNED_SECRET, { sensitive: true })] }),
        targets: refuse("accessDenied", "Denied.", { detail: `token ${RETURNED_SECRET}` }),
      },
      (provider) =>
        Effect.andThen(provider.env, failureOf(provider.targets("account", Option.none()))),
    )
    expect(quotesNoSecret(error).kind).toBe("providerFailed")
  })

  it("refuses an identity or a target that holds a secret env returned", async () => {
    const [selected, targets] = await withProvider(
      {
        env: answers({ values: [value("CLOUD_TOKEN", RETURNED_SECRET, { sensitive: true })] }),
        select: answers({ ...IDENTITY, principal: RETURNED_SECRET }),
        targets: answers({ targets: [{ id: "111", name: `key ${RETURNED_SECRET}` }] }),
      },
      (provider) =>
        Effect.andThen(
          provider.env,
          Effect.all([
            failureOf(provider.select({ account: "111" })),
            failureOf(provider.targets("account", Option.none())),
          ]),
        ),
    )
    expect([quotesNoSecret(selected).kind, quotesNoSecret(targets).kind]).toEqual([
      "providerFailed",
      "providerFailed",
    ])
  })

  it("looks for no secret shorter than 8 characters, which ordinary text holds by chance", async () => {
    const identity = await withProvider(
      {
        signIn: signingIn(),
        select: answers({ ...IDENTITY, principal: "a user named abc" }),
      },
      (provider) =>
        Effect.gen(function* () {
          yield* provider.describe
          yield* signIn(provider, { token: "abc" })
          return yield* provider.select({ account: "111" })
        }),
    )
    expect(identity.principal).toBe("a user named abc")
  })
})

describe("a file credential", () => {
  /** An env answer naming `file` as CLOUD_FILE, after writing it with `mode` when given. */
  const naming =
    (file: string, mode?: number): Answer =>
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem
        if (mode !== undefined) yield* Effect.orDie(fs.writeFile(file, "{}", { mode }))
        return { values: [value("CLOUD_FILE", file, { file: true })] }
      })

  const envWith = (answer: Answer) =>
    withProvider({ env: answer }, (provider) =>
      Effect.andThen(provider.describe, Effect.exit(provider.env)),
    )

  it("is taken when it is inside the block's state folder, readable by its owner only", async () => {
    const exit = await envWith(naming(`${STATE}/key.json`, 0o600))
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  it.each([
    ["outside the state folder", naming("/state/s1/key.json", 0o600), "outside its state folder"],
    ["readable by others", naming(`${STATE}/key.json`, 0o644), "mode 644"],
    ["by a relative path", naming("cloud/key.json"), "relative path"],
    ["that is not there", naming(`${STATE}/gone.json`), "not there"],
  ])("is refused %s", async (_case, answer, says) => {
    const exit = await envWith(answer)
    const error = Exit.findErrorOption(exit)
    expect(Option.map(error, (found) => [found.kind, found.message.includes(says)])).toEqual(
      Option.some(["providerFailed", true]),
    )
  })
})

describe("the plugin's own time", () => {
  it("is each method's limit, which configure tells it, under the engine's", () => {
    expect(CREDENTIAL_LIMITS).toEqual({
      configure: 30_000,
      detect: 120_000,
      targets: 120_000,
      select: 120_000,
      env: 120_000,
      signOut: 60_000,
      signIn: 900_000,
    })
  })

  it("runs out at the method's limit, which ends the plugin's process", async () => {
    const result = await withProvider({ detect: () => Effect.never }, (provider, processes) =>
      Effect.gen(function* () {
        yield* provider.describe
        const call = yield* Effect.forkChild(provider.detect([], { pins: {}, requirements: [] }))
        yield* TestClock.adjust(CREDENTIAL_LIMITS.detect)
        const error = yield* failureOf(Fiber.join(call))
        yield* provider.describe
        return { error, started: processes.envs.length }
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(result.error.kind).toBe("providerFailed")
    expect(result.error.message).toContain("did not answer detect within 120 seconds")
    expect(result.started).toBe(2)
  })
})
