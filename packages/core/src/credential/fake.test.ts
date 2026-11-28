/**
 * The fake credential plugin, behind the credential client in memory, as
 * the engine and its tests meet it. The contract suite holds it to what
 * the real plugins do (`credentialProviderContract`); these tests cover
 * what a script controls.
 */
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  DateTime,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Redacted,
  Result,
  type Scope,
  Stream,
} from "effect"
import { TestClock } from "effect/testing"
import type { CredentialError } from "@runbooks/blocks-core/contract"
import type { BlockStatus } from "@runbooks/blocks-core/status"
import { FileSystem, type FileSystemShape } from "../services/FileSystem.ts"
import {
  credentialProviderContract,
  FAKE_SCENARIOS,
} from "../test-utils/credentialProviderContract.ts"
import { type EnvSession, type UseEnvSession, withEnvSession } from "../test-utils/envSessions.ts"
import { makeTestFileSystem, testFileSystem } from "../test-utils/TestFileSystem.ts"
import { makeRecordingSpawner } from "../test-utils/TestSpawner.ts"
import {
  FAKE_SCRIPT,
  type FakeFault,
  type FakeScript,
  fakeCredentialPlugin,
  fakeCredentialProviders,
} from "./fake.ts"
import { EXPIRY_WARNING_MILLIS } from "./lifecycle.ts"
import { CREDENTIAL_LIMITS } from "./plugin.ts"
import {
  type Constraints,
  type CredentialProvider,
  CredentialProviders,
  type ProviderConfig,
} from "./provider.ts"

const STATE = "/state/s1/fake"
const TOKEN = "fake-token-0001-secret"
const DONE: BlockStatus = { _tag: "Done", outcome: "success" }
const NONE: Constraints = { pins: {}, requirements: [] }

const config = (environment: Record<string, string> = {}): ProviderConfig => ({
  stateDir: STATE,
  environment: new Map(Object.entries(environment).map(([k, v]) => [k, Redacted.make(v)])),
  caBundleFile: Option.none(),
  proxy: Option.none(),
  settings: {},
})

/** Runs `use` on the fake's provider, with the block's state folder made, on the test clock. */
const withFake = <A, E>(
  use: (provider: CredentialProvider, fs: FileSystemShape) => Effect.Effect<A, E, Scope.Scope>,
  options: { readonly script?: FakeScript; readonly environment?: Record<string, string> } = {},
): Promise<A> => {
  const fs = testFileSystem({}, [])
  Effect.runSync(fs.mkdir(STATE, { recursive: true, mode: 0o700 }))
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const providers = yield* CredentialProviders
        const provider = yield* providers.open("fake", config(options.environment))
        yield* provider.describe
        return yield* use(provider, fs)
      }),
    ).pipe(
      Effect.provide(
        fakeCredentialProviders({ fake: options.script ?? FAKE_SCRIPT }).pipe(
          Layer.provide(Layer.succeed(FileSystem, fs)),
        ),
      ),
      Effect.provide(TestClock.layer()),
    ),
  )
}

const signIn = (
  provider: CredentialProvider,
  method: string,
  fields: Record<string, string>,
  constraints: Constraints = NONE,
) =>
  Stream.runCollect(
    provider.signIn(
      method,
      Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, Redacted.make(v)])),
      constraints,
    ),
  )

const kindOf = <A>(effect: Effect.Effect<A, CredentialError>) =>
  Effect.map(Effect.flip(effect), (error) => error.kind)

const revealedEnv = (provider: CredentialProvider) =>
  Effect.map(provider.env, (env) =>
    env.values.map((value) => ({ ...value, value: Redacted.value(value.value) })),
  )

describe("the fake credential plugin", () => {
  it("answers notConfigured before configure, and invalidParams for a method it lacks", async () => {
    const answers = await Effect.runPromise(
      Effect.gen(function* () {
        const plugin = yield* fakeCredentialPlugin(() => FAKE_SCRIPT)({})
        const notify = () => Effect.void
        const early = yield* Effect.flip(plugin.answer("env", {}, notify))
        yield* plugin.answer(
          "configure",
          { protocolVersion: "1", caller: "test", callTimeoutsMillis: {}, stateDir: STATE },
          notify,
        )
        const unknown = yield* Effect.flip(plugin.answer("refresh", {}, notify))
        const relative = yield* Effect.flip(
          plugin.answer(
            "configure",
            { protocolVersion: "1", caller: "test", callTimeoutsMillis: {}, stateDir: "state" },
            notify,
          ),
        )
        return [early.kind, unknown.kind, relative.kind]
      }).pipe(Effect.provide(makeTestFileSystem())),
    )
    expect(answers).toEqual(["notConfigured", "invalidParams", "invalidParams"])
  })

  it("signs in with a typed token, then gives env the token, each chosen target, and an owner-only file", async () => {
    const result = await withFake((provider, fs) =>
      Effect.gen(function* () {
        const events = yield* signIn(
          provider,
          "token",
          { token: TOKEN },
          {
            pins: { account: "111111111111" },
            requirements: [],
          },
        )
        const values = yield* revealedEnv(provider)
        const stat = yield* fs.stat(`${STATE}/credentials.json`)
        return { events, values, mode: Option.getOrNull(stat.mode) }
      }),
    )
    expect(result.events).toMatchObject([
      {
        _tag: "SignedIn",
        identity: {
          principal: "fake-user@example.com",
          method: "token",
          targets: { account: { id: "111111111111", name: "Production" } },
        },
      },
    ])
    expect(
      result.values.map(({ name, value, sensitive, file }) => [name, value, sensitive, file]),
    ).toEqual([
      ["FAKE_TOKEN", TOKEN, true, false],
      ["FAKE_ACCOUNT", "111111111111", false, false],
      ["FAKE_CREDENTIALSFILE", `${STATE}/credentials.json`, false, true],
    ])
    expect(result.mode).toBe(0o600)
  })

  it("refuses a bad method, field, choice, pin or requirement with invalidParams, before anything else", async () => {
    const kinds = await withFake((provider) =>
      Effect.all([
        kindOf(signIn(provider, "password", {})),
        kindOf(signIn(provider, "token", {})),
        kindOf(signIn(provider, "token", { token: TOKEN, user: "me" })),
        kindOf(signIn(provider, "device", { region: "west" })),
        kindOf(
          signIn(provider, "token", { token: TOKEN }, { pins: { project: "p" }, requirements: [] }),
        ),
        kindOf(
          signIn(
            provider,
            "token",
            { token: TOKEN },
            {
              pins: {},
              requirements: [{ kind: "roles", roles: [{ role: "Owner" }] }],
            },
          ),
        ),
      ]),
    )
    expect(kinds as ReadonlyArray<string>).toEqual(Array(6).fill("invalidParams"))
  })

  it("answers pinMismatch, requirementNotMet with what is unmet, accessDenied and expired", async () => {
    const errors = await withFake((provider) =>
      Effect.all(
        [
          signIn(
            provider,
            "token",
            { token: TOKEN },
            { pins: { account: "999" }, requirements: [] },
          ),
          signIn(
            provider,
            "token",
            { token: TOKEN },
            {
              pins: {},
              requirements: [{ kind: "scopes", scopes: ["read", "admin"] }],
            },
          ),
          signIn(provider, "token", { token: "not-a-known-token" }),
          signIn(provider, "token", { token: "fake-expired-token-0001" }),
        ].map(Effect.flip),
      ),
    )
    expect(errors.map((error) => error.kind)).toEqual([
      "pinMismatch",
      "requirementNotMet",
      "accessDenied",
      "expired",
    ])
    expect(errors[1]?.unmet).toEqual([{ kind: "scopes", scopes: ["admin"] }])
  })

  it("shows a browser sign-in's prompts; a device sign-in waits until a second before its limit, then times out", async () => {
    const result = await withFake((provider) =>
      Effect.gen(function* () {
        const browser = yield* signIn(provider, "browser", {})
        const device = yield* Effect.forkChild(Effect.flip(signIn(provider, "device", {})))
        yield* TestClock.adjust(CREDENTIAL_LIMITS.signIn - 1_001)
        const early = device.pollUnsafe()
        yield* TestClock.adjust(1)
        const error = yield* Fiber.join(device)
        // The plugin answered: its process goes on, and still holds the browser sign-in.
        const after = yield* revealedEnv(provider)
        return { browser: browser.map((event) => event._tag), early, error, after }
      }),
    )
    expect(result.browser).toEqual(["OpenUrl", "Waiting", "SignedIn"])
    expect(result.early).toBeUndefined()
    expect(result.error.kind).toBe("timedOut")
    expect(result.after[0]?.value).toBe("fake-browser-token-0001")
  })

  it("detects a login in its environment, in values, and in a named source, in order", async () => {
    const found = await withFake(
      (provider) =>
        Effect.all([
          provider.detect([{ kind: "env", prefix: Option.none() }], NONE),
          provider.detect(
            [
              { kind: "env", prefix: Option.some("OTHER_") },
              {
                kind: "values",
                from: "keys",
                values: { FAKE_TOKEN: { value: Redacted.make(TOKEN), secret: true } },
              },
            ],
            NONE,
          ),
          provider.detect([{ kind: "named", name: "cli" }], NONE),
          provider.detect([{ kind: "env", prefix: Option.some("OTHER_") }], NONE),
        ]),
      { environment: { FAKE_TOKEN: "fake-browser-token-0001" } },
    )
    expect(
      found.map((detected) =>
        Option.map(detected, ({ identity, source }) => [identity.principal, source]),
      ),
    ).toEqual([
      Option.some(["fake-browser@example.com", "env"]),
      Option.some(["fake-user@example.com", "keys"]),
      Option.some(["fake-cli@example.com", "cli"]),
      Option.none(),
    ])
  })

  it("lists the targets the login may reach at each level, under a parent, and selects one", async () => {
    const result = await withFake((provider) =>
      Effect.gen(function* () {
        const before = yield* kindOf(provider.targets("account", Option.none()))
        yield* signIn(provider, "browser", {})
        const accounts = yield* provider.targets("account", Option.none())
        const roles = yield* provider.targets("role", Option.some("111111111111"))
        const identity = yield* provider.select({ account: "111111111111", role: null })
        const refused = yield* kindOf(provider.select({ account: "222222222222" }))
        return { before, accounts, roles, targets: identity.targets, refused }
      }),
    )
    expect(result).toEqual({
      before: "notSignedIn",
      accounts: [{ id: "111111111111", name: "Production" }],
      roles: [
        { id: "Admin", name: "Admin" },
        { id: "ReadOnly", name: "Read only" },
      ],
      targets: { account: { id: "111111111111", name: "Production" }, role: null },
      refused: "invalidParams",
    })
  })

  it("expires by the clock: env refreshes a credential that can be, and answers expired for another", async () => {
    const lasting: FakeScript = {
      ...FAKE_SCRIPT,
      logins: [{ ...FAKE_SCRIPT.logins[0]!, refreshable: false }],
    }
    const hour = 60 * 60_000
    const [refreshed, expired] = await Promise.all(
      [FAKE_SCRIPT, lasting].map((script) =>
        withFake(
          (provider) =>
            Effect.gen(function* () {
              yield* signIn(provider, "token", { token: TOKEN })
              const first = yield* provider.env
              yield* TestClock.adjust(hour)
              const later = yield* Effect.result(provider.env)
              return { first: first.expiresAt, later }
            }),
          { script },
        ),
      ),
    )
    expect(Option.map(refreshed!.first, DateTime.toEpochMillis)).toEqual(Option.some(hour))
    expect(
      Result.isSuccess(refreshed!.later) &&
        Option.map(refreshed!.later.success.expiresAt, DateTime.toEpochMillis),
    ).toEqual(Option.some(2 * hour))
    expect(Result.isFailure(expired!.later) && expired!.later.failure.kind).toBe("expired")
  })

  it("refreshes within the window the contract states, so the engine and every plugin keep one number", () => {
    const schema = JSON.parse(
      readFileSync(
        path.resolve(import.meta.dirname, "../../../../plugin/credential.schema.json"),
        "utf8",
      ),
    ) as { readonly $defs: { readonly envResult: { readonly description: string } } }
    expect(schema.$defs.envResult.description).toContain(
      `that expires within ${EXPIRY_WARNING_MILLIS / 60_000} minutes,`,
    )
  })

  // The contract (envResult in plugin/credential.schema.json): a credential
  // that expires within 5 minutes is refreshed before env answers, if it can be.
  it("renews a refreshable credential from 5 minutes before its expiry, and gives another as it is", async () => {
    const lasting: FakeScript = {
      ...FAKE_SCRIPT,
      logins: [{ ...FAKE_SCRIPT.logins[0]!, refreshable: false }],
    }
    const minute = 60_000
    const expiries = await Promise.all(
      [FAKE_SCRIPT, lasting].map((script) =>
        withFake(
          (provider) =>
            Effect.gen(function* () {
              yield* signIn(provider, "token", { token: TOKEN })
              yield* TestClock.adjust(55 * minute - 1)
              const before = yield* provider.env
              yield* TestClock.adjust(1)
              const within = yield* provider.env
              return [before, within].map((env) =>
                Option.map(env.expiresAt, DateTime.toEpochMillis),
              )
            }),
          { script },
        ),
      ),
    )
    expect(expiries).toEqual([
      [Option.some(60 * minute), Option.some(115 * minute)],
      [Option.some(60 * minute), Option.some(60 * minute)],
    ])
  })

  it("signs out: env answers notSignedIn, and its credentials file is gone", async () => {
    const result = await withFake((provider, fs) =>
      Effect.gen(function* () {
        yield* signIn(provider, "token", { token: TOKEN })
        yield* provider.env
        yield* provider.signOut
        return {
          env: yield* kindOf(provider.env),
          file: yield* fs.exists(`${STATE}/credentials.json`),
        }
      }),
    )
    expect(result).toEqual({ env: "notSignedIn", file: false })
  })

  it("answers any error a script names, one this app does not know included", async () => {
    const kinds = await withFake(
      (provider) => Effect.all([kindOf(provider.detect([], NONE)), kindOf(provider.env)]),
      {
        script: {
          ...FAKE_SCRIPT,
          refuse: {
            detect: { kind: "quotaExceeded", message: "Too many calls." },
            env: { kind: "network", message: "The network is down." },
          },
        },
      },
    )
    expect(kinds).toEqual(["unknown", "network"])
  })
})

describe("each of the fake's faults", () => {
  type Steps = (provider: CredentialProvider) => Effect.Effect<unknown, CredentialError>
  const signInThenEnv =
    (method = "token", fields: Record<string, string> = { token: TOKEN }): Steps =>
    (provider) =>
      Effect.andThen(signIn(provider, method, fields), provider.env)
  const cases: ReadonlyArray<readonly [FakeFault, Steps, string]> = [
    ["undeclaredName", signInThenEnv(), "a name it did not declare"],
    ["secretNotSensitive", signInThenEnv(), "without marking it sensitive"],
    [
      "secretInIdentity",
      (provider) => signIn(provider, "token", { token: TOKEN }),
      "put a secret in",
    ],
    [
      "secretInError",
      (provider) => signIn(provider, "token", { token: "fake-unknown-token-9999" }),
      "put a secret in an error",
    ],
    [
      "secretInPrompt",
      (provider) =>
        Effect.andThen(signInThenEnv("browser", {})(provider), signIn(provider, "browser", {})),
      "put a secret in a sign-in prompt",
    ],
    ["fileOutsideStateDir", signInThenEnv(), "outside its state folder"],
    ["fileReadableByOthers", signInThenEnv(), "mode 644"],
  ]

  it.each(cases)("%s is caught by the credential client", async (fault, steps, says) => {
    const error = await withFake((provider) => Effect.flip(steps(provider)), {
      script: { ...FAKE_SCRIPT, faults: [fault] },
    })
    expect([error.kind, error.message.includes(says) ? says : error.message]).toEqual([
      "providerFailed",
      says,
    ])
  })
})

describe("the engine, against the fake", () => {
  const script: FakeScript = {
    ...FAKE_SCRIPT,
    prefix: "CLOUD",
    levels: [{ name: "account", label: "Account", chosen: "afterSignIn" }],
    file: false,
  }
  /** A session of a runbook with a `cloud` block, signed out, and a run that reads it. */
  const withCloud = <A>(use: UseEnvSession<A>, options: { readonly testClock?: boolean } = {}) =>
    withEnvSession(
      {
        file: "/rb/runbook.mdx",
        workingFolders: "/work",
        processEnvironment: { PATH: "/usr/bin" },
        fileSystem: makeTestFileSystem({
          "/rb/runbook.mdx": [
            '<CloudLogin id="cloud" account="111111111111" detect={false} />',
            '<Run id="deploy" command="deploy" envFrom={["cloud"]} />',
          ].join("\n\n"),
        }),
        spawner: makeRecordingSpawner(() => ({ lines: [], exitCode: 0 })).layer,
        providers: fakeCredentialProviders({ cloud: script }),
        ...options,
      },
      use,
    )
  const signInCloud = (rb: EnvSession) =>
    Effect.gen(function* () {
      yield* rb.until("cloud", "SignedOut")
      yield* rb.act("cloud", {
        _tag: "SignIn",
        method: "token",
        fields: { token: Redacted.make(TOKEN) },
      })
      return yield* rb.until("cloud", "Ready")
    })

  it("signs a block in, and a run gets the values the block declares", async () => {
    const env = await withCloud((rb) =>
      Effect.gen(function* () {
        yield* signInCloud(rb)
        yield* rb.run("deploy")
        const given = rb.envOf("deploy")
        yield* rb.close
        return given
      }),
    )
    expect(env).toEqual({ PATH: "/usr/bin", CLOUD_TOKEN: TOKEN, CLOUD_ACCOUNT: "111111111111" })
  })

  // The token login lasts an hour and can be refreshed. The engine refreshes
  // it through env 5 minutes before it expires, which the contract asks env
  // to answer with a later expiry.
  it("keeps a refreshable login Ready through its last 5 minutes, its expiry moved later", async () => {
    const minute = 60_000
    const at = (minutes: number) => DateTime.makeUnsafe(minutes * minute)
    const seen = await withCloud(
      (rb) =>
        Effect.gen(function* () {
          const signedIn = yield* signInCloud(rb)
          yield* TestClock.adjust(55 * minute)
          const refreshed = yield* Effect.race(
            rb.until("cloud", "Ready"),
            rb.until("cloud", "Expired"),
          )
          yield* TestClock.adjust(6 * minute)
          const status = yield* rb.status("cloud")
          const run = yield* Effect.exit(rb.run("deploy"))
          yield* rb.close
          return { signedIn, refreshed, status, run }
        }),
      { testClock: true },
    )
    expect(seen.signedIn).toMatchObject({ _tag: "Ready", identity: { expiresAt: at(60) } })
    expect(seen.refreshed).toMatchObject({ _tag: "Ready", identity: { expiresAt: at(115) } })
    // Past the hour the first sign-in gave, the block is still done and a run gets it.
    expect(seen.status).toEqual(DONE)
    expect(Exit.isSuccess(seen.run) && seen.run.value).toEqual(DONE)
  })
})

/** The fake in memory, with a filesystem of its own for each case. */
const openFake = async () => {
  const fs = testFileSystem({}, [])
  return {
    layer: Layer.merge(
      fakeCredentialProviders({ fake: FAKE_SCRIPT }),
      Layer.succeed(FileSystem, fs),
    ).pipe(Layer.provide(Layer.succeed(FileSystem, fs))),
    provider: "fake",
    config: config(),
    release: async () => {},
  }
}

credentialProviderContract("the fake, in memory", { scenarios: FAKE_SCENARIOS, open: openFake })

// A provider whose logins no requirement can fail, as AWS's (it evaluates no
// requirement kind) and a Google service account's, gives no
// requirementNotMet scenario, and the rest of its account cases still run.
const fakeAccount = FAKE_SCENARIOS.account
if (fakeAccount === undefined) throw new Error("The fake's scenarios hold its account cases.")
credentialProviderContract("the fake, in memory, with no requirementNotMet scenario", {
  scenarios: {
    ...FAKE_SCENARIOS,
    account: {
      signIn: fakeAccount.signIn,
      pinMismatch: fakeAccount.pinMismatch,
      expired: fakeAccount.expired,
      secretNames: fakeAccount.secretNames,
    },
  },
  open: openFake,
})
