/**
 * The credential lifecycle (work product 2.6), through the engine: a toy
 * credential block in a trusted session, its provider an in-memory script
 * that notes each call. Every test ends by checking each move the session
 * logged against `TRANSITIONS`. Tests ported from today's auth blocks keep
 * their names; the comment on each says where it came from.
 */
import path from "node:path"
import { describe, expect, it } from "bun:test"
import { DateTime, Effect, Exit, Option, Redacted, Schema, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { BlockId, CredentialError } from "@runbooks/blocks-core/contract"
import type { AnyBlock } from "@runbooks/blocks-core/registry"
import type { BlockStatus } from "@runbooks/blocks-core/status"
import { type CredentialStateTag, TRANSITIONS } from "../credential/lifecycle.ts"
import {
  type CredentialEnv,
  CredentialProviders,
  type Identity,
  type ProviderConfig,
  type ProviderInfo,
  type SignInEvent,
} from "../credential/provider.ts"
import { type UseEnvSession, withEnvSession } from "../test-utils/envSessions.ts"
import {
  type ProviderCall,
  type ScriptedProvider,
  testCredentialProviders,
} from "../test-utils/TestCredentialProviders.ts"
import { makeTestFileSystem } from "../test-utils/TestFileSystem.ts"
import { makeRecordingSpawner, type RecordedSpawn } from "../test-utils/TestSpawner.ts"
import { TOY_REGISTRY } from "../test-utils/toyRegistry.ts"
import { makeCredentialStore } from "./credentialStore.ts"
import { makeCredentials } from "./credentials.ts"
import { Engine } from "./engine.ts"
import { EventEnvelope, type EventEnvelope as Envelope } from "./protocol.ts"

const RUNBOOK = "/rb/runbook.mdx"
const blockId = Schema.decodeSync(BlockId)
const done: BlockStatus = { _tag: "Done", outcome: "success" }

// ---------------------------------------------------------------------------
// The toy provider
// ---------------------------------------------------------------------------

const CLOUD_INFO: ProviderInfo = {
  methods: [
    {
      name: "sso",
      label: "SSO",
      fields: [{ name: "startUrl", label: "Start URL", required: true, secret: false }],
    },
    {
      name: "keys",
      label: "Access keys",
      fields: [
        { name: "accessKey", label: "Access key", required: true, secret: false },
        { name: "secretKey", label: "Secret key", required: true, secret: true },
      ],
    },
  ],
  levels: [
    { name: "account", label: "Account", chosen: "afterSignIn" },
    { name: "role", label: "Role", chosen: "afterSignIn" },
  ],
  sources: [],
  requirements: ["scopes"],
  names: ["CLOUD_TOKEN", "CLOUD_ACCOUNT", "account", "token"],
}

/** A git provider: one token sign-in, and the host chosen before it. */
const GIT_INFO: ProviderInfo = {
  methods: [
    {
      name: "token",
      label: "Token",
      fields: [{ name: "token", label: "Token", required: true, secret: true }],
    },
  ],
  levels: [{ name: "host", label: "Host", chosen: "beforeSignIn" }],
  sources: [],
  requirements: [],
  names: ["GITHUB_TOKEN", "GITLAB_TOKEN"],
}

/** Who a cloud login is, at `account` in `role`, or with no role (null). */
const who = (account: string, role: string | null = "Admin"): Identity => ({
  principal: `arn:cloud::${account}:role/${role ?? "none"}`,
  kind: "role",
  method: "sso",
  targets: {
    account: { id: account, name: `acct-${account}` },
    role: role === null ? null : { id: role, name: role },
  },
})

/** What a cloud provider's `env` gives: the token to the run and as a hidden output, the account to both. */
const cloudEnv = (token: string, account = "111"): CredentialEnv => ({
  values: [
    { name: "CLOUD_TOKEN", value: Redacted.make(token), sensitive: true, to: ["env"] },
    { name: "CLOUD_ACCOUNT", value: Redacted.make(account), sensitive: false, to: ["env"] },
    { name: "account", value: Redacted.make(account), sensitive: false, to: ["output"] },
    { name: "token", value: Redacted.make(token), sensitive: true, to: ["output"] },
  ],
  expiresAt: Option.none(),
})

const found = (identity: Identity, source = "env") =>
  Effect.succeed(Option.some({ identity, source }))

/** A cloud provider for one block that finds nothing and gives `tok-SECRET` once signed in. */
const cloud =
  (script: Partial<ScriptedProvider> = {}) =>
  (_config: ProviderConfig): ScriptedProvider => ({
    info: CLOUD_INFO,
    env: Effect.succeed(cloudEnv("tok-SECRET")),
    ...script,
  })

const signedIn = (identity: Identity): SignInEvent => ({ _tag: "SignedIn", identity })
const WAITING: SignInEvent = { _tag: "Waiting" }

const credentialError = (kind: CredentialError["kind"], message: string, more = {}) =>
  new CredentialError({ kind, message, ...more })

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

/** Every provider call the latest session's blocks made. */
let calls: ProviderCall[] = []
/** Every process the latest session's `Shell` blocks spawned. */
let spawns: RecordedSpawn[] = []
/** The latest session's whole event log. */
let log: ReadonlyArray<Envelope> = []

/** The methods `block`'s provider was called with, in order. */
const callsOf = (block: string) =>
  calls.filter((call) => call.block === block).map((call) => call.method)

const argsOf = (block: string, method: ProviderCall["method"]) =>
  calls.filter((call) => call.block === block && call.method === method).map((call) => call.args)

/** Each block's moves, checked against `TRANSITIONS`; the first must be to Detecting. */
function expectEveryMoveAllowed(events: ReadonlyArray<Envelope>) {
  const last = new Map<string, CredentialStateTag>()
  for (const { event } of events) {
    if (event._tag !== "CredentialChanged") continue
    const from = last.get(event.block)
    const to = event.state._tag
    const allowed = from === undefined ? to === "Detecting" : TRANSITIONS[from].includes(to)
    expect({ block: event.block, from, to, allowed }).toEqual({
      block: event.block,
      from,
      to,
      allowed: true,
    })
    last.set(event.block, to)
  }
}

/** The tags `block` moved through. */
const movesOf = (block: string) =>
  log.flatMap(({ event }) =>
    event._tag === "CredentialChanged" && event.block === block ? [event.state._tag] : [],
  )

/**
 * A trusted session of `runbook` whose credential providers are `scripts`.
 * With `testClock`, the session's time starts at the epoch and moves only
 * when the test adjusts it, and `wallClockAhead` jumps the wall clock alone.
 */
const withCloud = <A>(
  runbook: string,
  scripts: Readonly<Record<string, (config: ProviderConfig) => ScriptedProvider>>,
  use: UseEnvSession<A>,
  options: { readonly testClock?: boolean; readonly wallClockAhead?: () => number } = {},
): Promise<A> => {
  calls = []
  log = []
  const spawner = makeRecordingSpawner(() => ({ lines: [], exitCode: 0 }))
  spawns = spawner.calls
  return withEnvSession(
    {
      file: RUNBOOK,
      workingFolders: "/work",
      processEnvironment: {},
      fileSystem: makeTestFileSystem({ [RUNBOOK]: runbook }),
      spawner: spawner.layer,
      providers: testCredentialProviders(scripts, calls),
      ...options,
    },
    (rb) =>
      Effect.gen(function* () {
        const result = yield* use(rb)
        log = yield* rb.close
        expectEveryMoveAllowed(log)
        return result
      }),
  )
}

const DEPLOY = '<Run id="deploy" command="deploy" envFrom={["cloud"]} />'
const WAITING_FOR_CLOUD: BlockStatus = {
  _tag: "Blocked",
  by: [{ _tag: "WaitingFor", block: blockId("cloud"), capability: "env" }],
}

const runbookOf = (...blocks: ReadonlyArray<string>) => blocks.join("\n\n")

/** A block whose outputs hold access keys, for a `keysFrom` detection source. */
const KEYS =
  '<Script id="keys" label="keys" writesOutput={["accessKey=AKIAKEYS", "secretKey=keys-SECRET"]} declares={["accessKey", "secretKey"]} />'

/** A block that pins its targets, and a provider that detects the login it pins. */
const pinned = '<CloudLogin id="cloud" account="111" role="Admin" />'
const ready = cloud({ detect: () => found(who("111")) })

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

describe("detecting a credential", () => {
  it("opens the block's provider once trusted, with its own state folder and settings", async () => {
    await withCloud('<CloudLogin id="cloud" region="eu-west-1" />', { cloud: cloud() }, (rb) =>
      rb.until("cloud", "SignedOut"),
    )
    const [name, config] = argsOf("cloud", "open")[0] ?? []
    expect(name).toBe("cloud")
    expect(config).toMatchObject({
      caBundleFile: Option.none(),
      proxy: Option.none(),
      settings: { defaultRegion: "eu-west-1" },
    })
    const { stateDir } = config as ProviderConfig
    expect(path.basename(stateDir)).toBe("cloud")
    expect(path.dirname(path.dirname(stateDir))).toBe("/state")
    expect(callsOf("cloud")).toEqual(["open", "describe", "detect"])
  })

  // useAwsAuth.env.test.ts
  it("prompts with the detected account for a found and valid reply (default source)", async () => {
    await withCloud(
      runbookOf('<CloudLogin id="cloud" />', DEPLOY),
      { cloud: cloud({ detect: () => found(who("111")) }) },
      (rb) =>
        Effect.gen(function* () {
          expect(yield* rb.until("cloud", "Found")).toEqual({
            _tag: "Found",
            identity: who("111"),
            source: "env",
          })
          expect(yield* rb.status("cloud")).toEqual({ _tag: "Idle" })
          expect(yield* rb.status("deploy")).toEqual(WAITING_FOR_CLOUD)
        }),
    )
    expect(argsOf("cloud", "detect")).toEqual([
      [[{ kind: "env", prefix: Option.none() }], { pins: {}, requirements: [] }],
    ])
    expect(callsOf("cloud")).not.toContain("env")
  })

  it("shows a found login's warnings, and keeps them once it is used", async () => {
    const warnings = [{ message: "Region eu-south-2 is not enabled." }]
    await withCloud(
      '<CloudLogin id="cloud" />',
      { cloud: cloud({ detect: () => found({ ...who("111"), warnings }) }) },
      (rb) =>
        Effect.gen(function* () {
          expect(yield* rb.until("cloud", "Found")).toMatchObject({ identity: { warnings } })
          yield* rb.act("cloud", { _tag: "Confirm" })
          expect(yield* rb.until("cloud", "Ready")).toMatchObject({ identity: { warnings } })
        }),
    )
  })

  // useAwsAuth.env.test.ts
  it("falls through to manual auth when nothing is found", async () => {
    await withCloud('<CloudLogin id="cloud" method="sso" />', { cloud: cloud() }, (rb) =>
      Effect.gen(function* () {
        const state = yield* rb.until("cloud", "SignedOut")
        expect(state).toMatchObject({ _tag: "SignedOut", defaultMethod: "sso" })
        expect(state).not.toHaveProperty("lastError")
        expect(state._tag === "SignedOut" && state.methods.map((m) => m.name)).toEqual([
          "sso",
          "keys",
        ])
      }),
    )
  })

  // useGoogleAuth.test.ts "detectCredentials={false} starts done and never
  // probes for credentials". Its detection phase ended at once; here the
  // block starts signed out, so the name says that.
  it("detect={false} starts signed out and never probes for credentials", async () => {
    await withCloud('<CloudLogin id="cloud" detect={false} />', { cloud: cloud() }, (rb) =>
      rb.until("cloud", "SignedOut"),
    )
    expect(callsOf("cloud")).toEqual(["open", "describe"])
  })

  // useGitAuth.test.ts
  it("ends detection without trying anything", async () => {
    await withCloud('<GitLogin id="git" />', { git: () => ({ info: GIT_INFO }) }, (rb) =>
      Effect.gen(function* () {
        expect(yield* rb.until("git", "SignedOut")).toMatchObject({ _tag: "SignedOut" })
        expect(yield* rb.status("git")).toEqual({ _tag: "Idle" })
      }),
    )
    expect(callsOf("git")).toEqual(["open", "describe"])
  })

  // useAwsAuth.env.test.ts: the hint is the way to detect again.
  it("has no hint with detection off", async () => {
    await withCloud('<CloudLogin id="cloud" detect={false} />', { cloud: cloud() }, (rb) =>
      Effect.gen(function* () {
        yield* rb.until("cloud", "SignedOut")
        expect(yield* rb.act("cloud", { _tag: "CheckAgain" })).toEqual({
          _tag: "NotAllowed",
          state: "SignedOut",
        })
      }),
    )
    expect(callsOf("cloud")).toEqual(["open", "describe"])
  })

  // useAwsAuth.env.test.ts
  it("'Check again' re-runs detection", async () => {
    let looks = 0
    const detect = () =>
      Effect.suspend(() => (++looks === 1 ? found(who("111")) : found(who("222"))))
    await withCloud('<CloudLogin id="cloud" />', { cloud: cloud({ detect }) }, (rb) =>
      Effect.gen(function* () {
        yield* rb.until("cloud", "Found")
        yield* rb.act("cloud", { _tag: "Decline" })
        yield* rb.until("cloud", "SignedOut")
        expect(yield* rb.act("cloud", { _tag: "CheckAgain" })).toEqual({ _tag: "Accepted" })
        yield* rb.until("cloud", "Detecting")
        expect(yield* rb.until("cloud", "Found")).toMatchObject({ identity: who("222") })
      }),
    )
    expect(callsOf("cloud")).toEqual(["open", "describe", "detect", "detect"])
  })

  // useGoogleAuth.test.ts
  it("rejecting the prompt falls through to the manual tabs", async () => {
    await withCloud(
      runbookOf('<CloudLogin id="cloud" />', DEPLOY),
      { cloud: cloud({ detect: () => found(who("111")) }) },
      (rb) =>
        Effect.gen(function* () {
          yield* rb.until("cloud", "Found")
          expect(yield* rb.act("cloud", { _tag: "Decline" })).toEqual({ _tag: "Accepted" })
          const state = yield* rb.until("cloud", "SignedOut")
          expect(state._tag === "SignedOut" && state.methods.length).toBe(2)
          expect(yield* rb.status("deploy")).toEqual(WAITING_FOR_CLOUD)
        }),
    )
    expect(callsOf("cloud")).not.toContain("env")
  })

  // useGoogleAuth.test.ts
  it("pauses on a block source that has not executed, then resumes when it has", async () => {
    await withCloud(
      runbookOf(KEYS, '<CloudLogin id="cloud" keysFrom="keys" />'),
      { cloud: cloud({ detect: () => found(who("111"), "keys") }) },
      (rb) =>
        Effect.gen(function* () {
          expect(yield* rb.status("cloud")).toEqual({
            _tag: "Blocked",
            by: [{ _tag: "WaitingFor", block: blockId("keys"), capability: "run" }],
          })
          expect(calls).toEqual([])
          expect(yield* rb.run("keys")).toEqual(done)
          yield* rb.until("cloud", "Found")
        }),
    )
    const [sources] = argsOf("cloud", "detect")[0] ?? []
    expect(sources).toEqual([
      { kind: "env", prefix: Option.none() },
      {
        kind: "values",
        from: "keys",
        values: { accessKey: expect.anything(), secretKey: expect.anything() },
      },
    ])
    const values = (sources as ReadonlyArray<{ values?: Record<string, unknown> }>)[1]?.values ?? {}
    expect(Object.values(values).every(Redacted.isRedacted)).toBe(true)
    expect(
      Object.values(values).map((value) => Redacted.value(value as Redacted.Redacted)),
    ).toEqual(["AKIAKEYS", "keys-SECRET"])
  })

  it("names the block a login was found through", async () => {
    await withCloud(
      runbookOf(KEYS, '<CloudLogin id="cloud" keysFrom="keys" />'),
      {
        cloud: cloud({
          // As a provider answers: a login found in a values source has its block as the source.
          detect: (sources) =>
            Effect.suspend(() => {
              const read = sources.find((source) => source.kind === "values")
              return read?.kind === "values"
                ? found(who("111"), read.from)
                : Effect.succeed(Option.none())
            }),
        }),
      },
      (rb) =>
        Effect.gen(function* () {
          yield* rb.run("keys")
          expect(yield* rb.until("cloud", "Found")).toMatchObject({ source: "keys" })
        }),
    )
  })
})

// ---------------------------------------------------------------------------
// Decision 7: no click when the pins match
// ---------------------------------------------------------------------------

describe("a detected login the block pins (open decision 7)", () => {
  // useAwsAuth.sso.test.ts
  it("signs straight in when the block pins the account and role", async () => {
    await withCloud(
      runbookOf('<CloudLogin id="cloud" account="111" role="Admin" />', DEPLOY),
      { cloud: cloud({ detect: () => found(who("111", "Admin")) }) },
      (rb) =>
        Effect.gen(function* () {
          expect(yield* rb.until("cloud", "Ready")).toEqual({
            _tag: "Ready",
            identity: who("111", "Admin"),
            source: "env",
          })
          expect(yield* rb.status("cloud")).toEqual(done)
        }),
    )
    expect(movesOf("cloud")).toEqual(["Detecting", "Ready"])
    expect(callsOf("cloud")).toEqual(["open", "describe", "detect", "env"])
    expect(argsOf("cloud", "detect")[0]?.[1]).toEqual({
      pins: { account: "111", role: "Admin" },
      requirements: [],
    })
  })

  it("selects a pinned target the detected login does not name, then checks it", async () => {
    const accountOnly: Identity = {
      ...who("111"),
      targets: { account: who("111").targets.account! },
    }
    await withCloud(
      '<CloudLogin id="cloud" account="111" role="Admin" />',
      {
        cloud: cloud({
          detect: () => found(accountOnly),
          select: (targets) => Effect.succeed(who(targets.account ?? "", targets.role)),
        }),
      },
      (rb) => rb.until("cloud", "Ready"),
    )
    expect(argsOf("cloud", "select")).toEqual([[{ account: "111", role: "Admin" }]])
  })

  it("waits to choose a target after sign-in that the block does not pin, then takes the one chosen", async () => {
    const accountOnly: Identity = {
      ...who("111"),
      targets: { account: who("111").targets.account! },
    }
    const roles = [
      { id: "Admin", name: "Admin" },
      { id: "ReadOnly", name: "ReadOnly" },
    ]
    await withCloud(
      '<CloudLogin id="cloud" account="111" />',
      {
        cloud: cloud({
          detect: () => found(accountOnly),
          targets: () => Effect.succeed(roles),
          select: (targets) => Effect.succeed(who(targets.account ?? "", targets.role)),
        }),
      },
      (rb) =>
        Effect.gen(function* () {
          expect(yield* rb.until("cloud", "ChoosingTarget")).toMatchObject({
            level: { name: "role" },
            options: roles,
            chosen: { account: { id: "111" } },
            identity: accountOnly,
          })
          expect(yield* rb.status("cloud")).toEqual({ _tag: "Idle" })
          expect(
            yield* rb.act("cloud", { _tag: "ChooseTarget", level: "role", id: "ReadOnly" }),
          ).toEqual({ _tag: "Accepted" })
          expect(yield* rb.until("cloud", "Ready")).toMatchObject({
            identity: who("111", "ReadOnly"),
          })
        }),
    )
    expect(argsOf("cloud", "targets")).toEqual([["role", Option.some("111")]])
    expect(argsOf("cloud", "select")).toEqual([[{ account: "111", role: "ReadOnly" }]])
  })

  // azure-signin.test.ts
  it("refuses an environment service principal from another tenant than the block's pin", async () => {
    await withCloud(
      runbookOf('<CloudLogin id="cloud" account="111" />', DEPLOY),
      { cloud: cloud({ detect: () => found(who("222")) }) },
      (rb) =>
        Effect.gen(function* () {
          const state = yield* rb.until("cloud", "SignedOut")
          expect(state).toMatchObject({ lastError: { kind: "pinMismatch" } })
          expect(state._tag === "SignedOut" && state.lastError?.message).toBe(
            "The block pins account 111; arn:cloud::222:role/Admin is at 222.",
          )
          expect(yield* rb.status("deploy")).toEqual(WAITING_FOR_CLOUD)
          expect((yield* rb.outputs).cloud).toBeUndefined()
        }),
    )
    expect(callsOf("cloud")).toEqual(["open", "describe", "detect"])
  })

  it("checks a pin the provider's select did not honour", async () => {
    await withCloud(
      '<CloudLogin id="cloud" account="111" role="Admin" />',
      {
        cloud: cloud({
          detect: () => found({ ...who("111"), targets: {} }),
          select: () => Effect.succeed(who("111", "ReadOnly")),
        }),
      },
      (rb) => rb.until("cloud", "SignedOut"),
    )
    expect(callsOf("cloud")).not.toContain("env")
  })
})

// ---------------------------------------------------------------------------
// Signing in
// ---------------------------------------------------------------------------

const HOSTS = [
  { id: "github.com", name: "GitHub" },
  { id: "gitlab.com", name: "GitLab" },
]

describe("signing in", () => {
  it("keeps a sign-in's URL and code while it waits, then is ready", async () => {
    let release = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const prompts: ReadonlyArray<SignInEvent> = [
      { _tag: "OpenUrl", url: "https://device.example/", code: Option.some("ABCD-1234") },
      { _tag: "Waiting" },
    ]
    await withCloud(
      runbookOf(
        '<CloudLogin id="cloud" detect={false} defaults={{ sso: { startUrl: "https://start.example/" } }} />',
        DEPLOY,
      ),
      {
        cloud: cloud({
          signIn: () =>
            Stream.concat(
              Stream.fromIterable(prompts),
              Stream.fromEffect(
                Effect.as(
                  Effect.promise(() => released),
                  signedIn(who("111")),
                ),
              ),
            ),
        }),
      },
      (rb) =>
        Effect.gen(function* () {
          yield* rb.until("cloud", "SignedOut")
          expect(yield* rb.act("cloud", { _tag: "SignIn", method: "sso", fields: {} })).toEqual({
            _tag: "Accepted",
          })
          expect(yield* rb.until("cloud", "SigningIn")).toEqual({
            _tag: "SigningIn",
            method: "sso",
            waiting: false,
          })
          expect(yield* rb.until("cloud", "SigningIn")).toEqual({
            _tag: "SigningIn",
            method: "sso",
            url: "https://device.example/",
            code: "ABCD-1234",
            waiting: false,
          })
          expect(yield* rb.until("cloud", "SigningIn")).toEqual({
            _tag: "SigningIn",
            method: "sso",
            url: "https://device.example/",
            code: "ABCD-1234",
            waiting: true,
          })
          expect(yield* rb.status("cloud")).toEqual({ _tag: "Running" })
          expect(yield* rb.status("deploy")).toEqual(WAITING_FOR_CLOUD)
          release()
          expect(yield* rb.until("cloud", "Ready")).toMatchObject({ source: "sso" })
          expect(yield* rb.run("deploy")).toEqual(done)
        }),
    )
    const [method, fields, constraints] = argsOf("cloud", "signIn")[0] ?? []
    expect(method).toBe("sso")
    expect(
      Object.fromEntries(
        Object.entries(fields as Record<string, Redacted.Redacted<string>>).map(([name, value]) => [
          name,
          Redacted.value(value),
        ]),
      ),
    ).toEqual({ startUrl: "https://start.example/" })
    expect(constraints).toEqual({ pins: {}, requirements: [] })
  })

  it("chooses the levels before sign-in first, then signs in to the one chosen", async () => {
    await withCloud(
      '<GitLogin id="git" />',
      {
        git: () => ({
          info: GIT_INFO,
          targets: () => Effect.succeed(HOSTS),
          signIn: (_method, _fields, { pins }) =>
            Stream.make(
              signedIn({
                principal: "octocat",
                kind: "user",
                method: "token",
                targets: { host: { id: pins.host ?? "", name: pins.host ?? "" } },
              }),
            ),
          env: Effect.succeed({
            values: [
              {
                name: "GITLAB_TOKEN",
                value: Redacted.make("glpat-SECRET"),
                sensitive: true,
                to: ["env"],
              },
            ],
            expiresAt: Option.none(),
          }),
        }),
      },
      (rb) =>
        Effect.gen(function* () {
          yield* rb.until("git", "SignedOut")
          const fields = { token: Redacted.make("glpat-SECRET") }
          yield* rb.act("git", { _tag: "SignIn", method: "token", fields })
          yield* rb.until("git", "SigningIn")
          const choosing = yield* rb.until("git", "ChoosingTarget")
          expect(choosing).toEqual({
            _tag: "ChoosingTarget",
            level: GIT_INFO.levels[0]!,
            options: HOSTS,
            chosen: {},
          })
          expect(
            yield* rb.act("git", { _tag: "ChooseTarget", level: "host", id: "gitlab.com" }),
          ).toEqual({ _tag: "Accepted" })
          yield* rb.until("git", "SigningIn")
          expect(yield* rb.until("git", "Ready")).toMatchObject({
            identity: { targets: { host: { id: "gitlab.com" } } },
          })
        }),
    )
    expect(argsOf("git", "targets")).toEqual([["host", Option.none()]])
    const [method, fields, constraints] = argsOf("git", "signIn")[0] ?? []
    expect(method).toBe("token")
    expect(Redacted.value((fields as Record<string, Redacted.Redacted<string>>).token!)).toBe(
      "glpat-SECRET",
    )
    expect(constraints).toEqual({ pins: { host: "gitlab.com" }, requirements: [] })
    expect(movesOf("git")).toEqual([
      "Detecting",
      "SignedOut",
      "SigningIn",
      "ChoosingTarget",
      "SigningIn",
      "Ready",
    ])
  })

  // useAwsAuth.sso.test.ts
  it("stops a sign-in that is still polling", async () => {
    let stopped = false
    await withCloud(
      '<CloudLogin id="cloud" detect={false} />',
      {
        cloud: cloud({
          signIn: () =>
            Stream.concat(Stream.make(WAITING), Stream.never).pipe(
              Stream.ensuring(Effect.sync(() => (stopped = true))),
            ),
        }),
      },
      (rb) =>
        Effect.gen(function* () {
          yield* rb.until("cloud", "SignedOut")
          yield* rb.act("cloud", { _tag: "SignIn", method: "sso", fields: {} })
          yield* rb.until("cloud", "SigningIn")
          yield* rb.until("cloud", "SigningIn")
          expect(yield* rb.act("cloud", { _tag: "Cancel" })).toEqual({ _tag: "Accepted" })
          expect(stopped).toBe(true)
          expect(yield* rb.until("cloud", "SignedOut")).toMatchObject({
            lastError: { kind: "cancelled" },
          })
        }),
    )
    expect(callsOf("cloud")).toEqual(["open", "describe", "signIn", "signOut"])
  })

  it("stops a sign-in in progress when the session closes", async () => {
    let stopped = false
    await withCloud(
      '<CloudLogin id="cloud" detect={false} />',
      {
        cloud: cloud({
          signIn: () => Stream.never.pipe(Stream.ensuring(Effect.sync(() => (stopped = true)))),
        }),
      },
      (rb) =>
        Effect.gen(function* () {
          yield* rb.until("cloud", "SignedOut")
          yield* rb.act("cloud", { _tag: "SignIn", method: "sso", fields: {} })
          yield* rb.until("cloud", "SigningIn")
        }),
    )
    expect(stopped).toBe(true)
  })

  it("says what it offers when an action names a method or target it does not", async () => {
    await withCloud(
      '<GitLogin id="git" />',
      { git: () => ({ info: GIT_INFO, targets: () => Effect.succeed(HOSTS) }) },
      (rb) =>
        Effect.gen(function* () {
          yield* rb.until("git", "SignedOut")
          expect(yield* rb.act("git", { _tag: "SignIn", method: "oauth", fields: {} })).toEqual({
            _tag: "NotOffered",
            field: "method",
            value: "oauth",
            offered: ["token"],
          })
          yield* rb.act("git", { _tag: "SignIn", method: "token", fields: {} })
          yield* rb.until("git", "ChoosingTarget")
          expect(
            yield* rb.act("git", { _tag: "ChooseTarget", level: "host", id: "bitbucket.org" }),
          ).toEqual({
            _tag: "NotOffered",
            field: "id",
            value: "bitbucket.org",
            offered: ["github.com", "gitlab.com"],
          })
          expect(yield* rb.act("git", { _tag: "ChooseTarget", level: "org", id: "acme" })).toEqual({
            _tag: "NotOffered",
            field: "level",
            value: "org",
            offered: ["host"],
          })
          expect((yield* rb.view("git")).credential?._tag).toBe("ChoosingTarget")
        }),
    )
    expect(callsOf("git")).toEqual(["open", "describe", "targets"])
  })

  it("refuses an action the block's state does not take, and changes nothing", async () => {
    await withCloud('<CloudLogin id="cloud" detect={false} />', { cloud: cloud() }, (rb) =>
      Effect.gen(function* () {
        yield* rb.until("cloud", "SignedOut")
        // Every action but SignIn: CheckAgain too, with detection off.
        for (const action of [
          { _tag: "Confirm" },
          { _tag: "Decline" },
          { _tag: "Cancel" },
          { _tag: "ChooseTarget", level: "account", id: "111" },
          { _tag: "CheckAgain" },
          { _tag: "SignOut" },
        ] as const)
          expect(yield* rb.act("cloud", action)).toEqual({ _tag: "NotAllowed", state: "SignedOut" })
        expect((yield* rb.view("cloud")).actions).toEqual(["credential"])
      }),
    )
    expect(movesOf("cloud")).toEqual(["Detecting", "SignedOut"])
  })

  it("takes only Cancel while signing in, and the sign-in goes on", async () => {
    let stopped = false
    await withCloud(
      '<CloudLogin id="cloud" detect={false} />',
      {
        cloud: cloud({
          signIn: () =>
            Stream.concat(Stream.make(WAITING), Stream.never).pipe(
              Stream.ensuring(Effect.sync(() => (stopped = true))),
            ),
        }),
      },
      (rb) =>
        Effect.gen(function* () {
          yield* rb.until("cloud", "SignedOut")
          yield* rb.act("cloud", { _tag: "SignIn", method: "sso", fields: {} })
          yield* rb.until("cloud", "SigningIn")
          yield* rb.until("cloud", "SigningIn")
          for (const action of [
            { _tag: "Confirm" },
            { _tag: "Decline" },
            { _tag: "SignIn", method: "sso", fields: {} },
            { _tag: "ChooseTarget", level: "account", id: "111" },
            { _tag: "CheckAgain" },
            { _tag: "SignOut" },
          ] as const)
            expect(yield* rb.act("cloud", action)).toEqual({
              _tag: "NotAllowed",
              state: "SigningIn",
            })
          expect(stopped).toBe(false)
        }),
    )
    expect(movesOf("cloud")).toEqual(["Detecting", "SignedOut", "SigningIn", "SigningIn"])
    expect(callsOf("cloud")).toEqual(["open", "describe", "signIn"])
  })

  it("changes the target of a ready block at a level it does not pin", async () => {
    const roles = [
      { id: "Admin", name: "Admin" },
      { id: "ReadOnly", name: "ReadOnly" },
    ]
    await withCloud(
      '<CloudLogin id="cloud" account="111" />',
      {
        cloud: cloud({
          detect: () => found(who("111")),
          targets: () => Effect.succeed(roles),
          select: (targets) => Effect.succeed(who(targets.account ?? "", targets.role)),
        }),
      },
      (rb) =>
        Effect.gen(function* () {
          yield* rb.until("cloud", "Ready")
          expect(
            yield* rb.act("cloud", { _tag: "ChooseTarget", level: "account", id: "222" }),
          ).toEqual({ _tag: "NotOffered", field: "level", value: "account", offered: ["role"] })
          yield* rb.act("cloud", { _tag: "ChooseTarget", level: "role", id: "ReadOnly" })
          expect(yield* rb.until("cloud", "Ready")).toMatchObject({
            identity: who("111", "ReadOnly"),
          })
          yield* rb.act("cloud", { _tag: "ChooseTarget", level: "role", id: "Gone" })
          expect(yield* rb.until("cloud", "ChoosingTarget")).toMatchObject({
            level: { name: "role" },
            options: roles,
            chosen: { account: { id: "111" } },
          })
          expect((yield* rb.outputs).cloud).toBeUndefined()
        }),
    )
    expect(argsOf("cloud", "select")).toEqual([[{ account: "111", role: "ReadOnly" }]])
  })
})

// ---------------------------------------------------------------------------
// A level with no target
// ---------------------------------------------------------------------------

/** CLOUD_INFO with `role` optional: a login may have none, as an Azure tenant may have no subscription. */
const OPTIONAL_ROLE: ProviderInfo = {
  ...CLOUD_INFO,
  levels: [
    { name: "account", label: "Account", chosen: "afterSignIn" },
    { name: "role", label: "Role", chosen: "afterSignIn", optional: true },
  ],
}

const ROLES = [
  { id: "Admin", name: "Admin" },
  { id: "ReadOnly", name: "ReadOnly" },
]

/** A login at account 111 that names no role yet. */
const roleNotChosen: Identity = { ...who("111"), targets: { account: who("111").targets.account! } }

/** A provider described by `info` that detects `detected`, lists ROLES and selects what it is given. */
const selecting = (info: ProviderInfo, detected: Identity) =>
  cloud({
    info,
    detect: () => found(detected),
    targets: () => Effect.succeed(ROLES),
    select: (targets) => Effect.succeed(who(targets.account ?? "", targets.role)),
  })

describe("a level with no target", () => {
  it("chooses no target at an optional level, and is Ready with none", async () => {
    await withCloud(
      '<CloudLogin id="cloud" account="111" />',
      { cloud: selecting(OPTIONAL_ROLE, roleNotChosen) },
      (rb) =>
        Effect.gen(function* () {
          expect(yield* rb.until("cloud", "ChoosingTarget")).toMatchObject({
            level: { name: "role", optional: true },
          })
          expect(yield* rb.act("cloud", { _tag: "ChooseTarget", level: "role", id: null })).toEqual(
            { _tag: "Accepted" },
          )
          const state = yield* rb.until("cloud", "Ready")
          expect(state._tag === "Ready" && state.identity.targets.role).toBeNull()
        }),
    )
    expect(argsOf("cloud", "select")).toEqual([[{ account: "111", role: null }]])
  })

  it("refuses no target at a level that is not optional", async () => {
    await withCloud(
      '<CloudLogin id="cloud" account="111" />',
      { cloud: selecting(CLOUD_INFO, roleNotChosen) },
      (rb) =>
        Effect.gen(function* () {
          yield* rb.until("cloud", "ChoosingTarget")
          expect(yield* rb.act("cloud", { _tag: "ChooseTarget", level: "role", id: null })).toEqual(
            { _tag: "NotOffered", field: "id", value: null, offered: ["Admin", "ReadOnly"] },
          )
          expect((yield* rb.view("cloud")).credential?._tag).toBe("ChoosingTarget")
          yield* rb.act("cloud", { _tag: "ChooseTarget", level: "role", id: "ReadOnly" })
          yield* rb.until("cloud", "Ready")
          expect(yield* rb.act("cloud", { _tag: "ChooseTarget", level: "role", id: null })).toEqual(
            { _tag: "NotOffered", field: "id", value: null, offered: [] },
          )
          expect((yield* rb.view("cloud")).credential).toMatchObject({
            _tag: "Ready",
            identity: who("111", "ReadOnly"),
          })
        }),
    )
    expect(argsOf("cloud", "select")).toEqual([[{ account: "111", role: "ReadOnly" }]])
  })

  it("takes a detected login with no target at an optional level: Ready if pinned, else Found", async () => {
    await withCloud(
      '<CloudLogin id="cloud" account="111" />',
      { cloud: selecting(OPTIONAL_ROLE, who("111", null)) },
      (rb) =>
        Effect.gen(function* () {
          const state = yield* rb.until("cloud", "Ready")
          expect(state._tag === "Ready" && state.identity.targets.role).toBeNull()
        }),
    )
    expect(movesOf("cloud")).toEqual(["Detecting", "Ready"])
    expect(callsOf("cloud")).toEqual(["open", "describe", "detect", "env"])

    await withCloud(
      '<CloudLogin id="cloud" />',
      { cloud: selecting(OPTIONAL_ROLE, who("111", null)) },
      (rb) =>
        Effect.gen(function* () {
          expect(yield* rb.until("cloud", "Found")).toMatchObject({ identity: who("111", null) })
          yield* rb.act("cloud", { _tag: "Confirm" })
          expect(yield* rb.until("cloud", "Ready")).toMatchObject({ identity: who("111", null) })
        }),
    )
    expect(movesOf("cloud")).toEqual(["Detecting", "Found", "Ready"])
    expect(callsOf("cloud")).toEqual(["open", "describe", "detect", "env"])
  })

  it("changes a Ready block's optional level to no target and back", async () => {
    await withCloud(
      '<CloudLogin id="cloud" account="111" />',
      { cloud: selecting(OPTIONAL_ROLE, who("111")) },
      (rb) =>
        Effect.gen(function* () {
          yield* rb.until("cloud", "Ready")
          expect(yield* rb.act("cloud", { _tag: "ChooseTarget", level: "role", id: null })).toEqual(
            { _tag: "Accepted" },
          )
          expect(yield* rb.until("cloud", "Ready")).toMatchObject({ identity: who("111", null) })
          yield* rb.act("cloud", { _tag: "ChooseTarget", level: "role", id: "ReadOnly" })
          expect(yield* rb.until("cloud", "Ready")).toMatchObject({
            identity: who("111", "ReadOnly"),
          })
        }),
    )
    expect(argsOf("cloud", "select")).toEqual([
      [{ account: "111", role: null }],
      [{ account: "111", role: "ReadOnly" }],
    ])
    expect(argsOf("cloud", "targets")).toEqual([["role", Option.some("111")]])
  })

  it("asks for a level that is not optional when the provider answers no target for it", async () => {
    await withCloud(
      '<CloudLogin id="cloud" account="111" />',
      { cloud: selecting(CLOUD_INFO, who("111", null)) },
      (rb) =>
        Effect.gen(function* () {
          const choosing = yield* rb.until("cloud", "ChoosingTarget")
          expect(choosing._tag === "ChoosingTarget" && choosing.chosen).toEqual({
            account: { id: "111", name: "acct-111" },
          })
        }),
    )
  })
})

// ---------------------------------------------------------------------------
// Requirements and an unavailable provider
// ---------------------------------------------------------------------------

describe("a login that cannot be used", () => {
  // AzureAuth.test.tsx
  it("shows the missing roles as the error, and stays signed out", async () => {
    const unmet = [{ kind: "roles" as const, roles: [{ role: "Contributor" }] }]
    await withCloud(
      runbookOf('<CloudLogin id="cloud" detect={false} />', DEPLOY),
      {
        cloud: cloud({
          signIn: () =>
            Stream.fail(credentialError("requirementNotMet", "Missing Contributor.", { unmet })),
        }),
      },
      (rb) =>
        Effect.gen(function* () {
          yield* rb.until("cloud", "SignedOut")
          yield* rb.act("cloud", { _tag: "SignIn", method: "sso", fields: {} })
          expect(yield* rb.until("cloud", "RequirementNotMet")).toEqual({
            _tag: "RequirementNotMet",
            unmet,
          })
          const status = yield* rb.status("cloud")
          expect(status?._tag === "Failed" && status.error).toMatchObject({
            kind: "requirementNotMet",
          })
          expect(yield* rb.status("deploy")).toEqual(WAITING_FOR_CLOUD)
          expect((yield* rb.outputs).cloud).toBeUndefined()
        }),
    )
    expect(callsOf("cloud")).not.toContain("env")
  })

  it("is RequirementNotMet when a detected login lacks what the block requires", async () => {
    const unmet = [{ kind: "scopes" as const, scopes: ["repo"] }]
    await withCloud(
      '<CloudLogin id="cloud" scopes={["repo"]} />',
      {
        cloud: cloud({
          detect: () =>
            Effect.fail(credentialError("requirementNotMet", "No repo scope.", { unmet })),
        }),
      },
      (rb) =>
        Effect.gen(function* () {
          expect(yield* rb.until("cloud", "RequirementNotMet")).toEqual({
            _tag: "RequirementNotMet",
            unmet,
          })
          const status = yield* rb.status("cloud")
          expect(status?._tag === "Failed" && status.error).toMatchObject({
            kind: "requirementNotMet",
          })
          yield* rb.act("cloud", { _tag: "SignOut" })
          yield* rb.until("cloud", "SignedOut")
        }),
    )
    expect(argsOf("cloud", "detect")[0]?.[1]).toEqual({ pins: {}, requirements: unmet })
  })

  // AzureAuth.test.tsx
  it("says to install the Azure CLI when it's missing", async () => {
    const AZ = { name: "az", installUrl: "https://aka.ms/installazurecli" }
    let opened = 0
    await withCloud(
      '<CloudLogin id="cloud" />',
      {
        cloud: (config) =>
          ++opened === 1
            ? cloud({
                detect: () =>
                  Effect.fail(
                    credentialError("toolMissing", "Install the Azure CLI.", { tool: AZ }),
                  ),
              })(config)
            : cloud()(config),
      },
      (rb) =>
        Effect.gen(function* () {
          expect(yield* rb.until("cloud", "Unavailable")).toMatchObject({
            error: { kind: "toolMissing", tool: AZ, message: "Install the Azure CLI." },
          })
          const status = yield* rb.status("cloud")
          expect(status?._tag === "Failed" && status.error).toMatchObject({ tool: AZ })
          expect(yield* rb.act("cloud", { _tag: "SignIn", method: "sso", fields: {} })).toEqual({
            _tag: "NotAllowed",
            state: "Unavailable",
          })
          yield* rb.act("cloud", { _tag: "CheckAgain" })
          yield* rb.until("cloud", "SignedOut")
        }),
    )
    expect(callsOf("cloud")).toEqual(["open", "describe", "detect", "open", "describe", "detect"])
  })

  /** A cloud provider whose `keys` method needs a tool that is not installed. */
  const keysUnavailable = cloud({
    info: {
      ...CLOUD_INFO,
      methods: CLOUD_INFO.methods.map((method) =>
        method.name === "keys"
          ? { ...method, unavailable: credentialError("toolMissing", "Install the keys tool.") }
          : method,
      ),
    },
  })

  it("lists an unavailable method with its reason, and refuses a sign-in with it", async () => {
    await withCloud('<CloudLogin id="cloud" detect={false} />', { cloud: keysUnavailable }, (rb) =>
      Effect.gen(function* () {
        const state = yield* rb.until("cloud", "SignedOut")
        expect(
          state._tag === "SignedOut" &&
            state.methods.map((method) => [method.name, method.unavailable?.kind]),
        ).toEqual([
          ["sso", undefined],
          ["keys", "toolMissing"],
        ])
        expect(yield* rb.act("cloud", { _tag: "SignIn", method: "keys", fields: {} })).toEqual({
          _tag: "NotOffered",
          field: "method",
          value: "keys",
          offered: ["sso"],
        })
      }),
    )
    expect(movesOf("cloud")).toEqual(["Detecting", "SignedOut"])
    expect(callsOf("cloud")).toEqual(["open", "describe"])
  })

  it("does not default to an unavailable method", async () => {
    await withCloud(
      '<CloudLogin id="cloud" detect={false} method="keys" />',
      { cloud: keysUnavailable },
      (rb) =>
        Effect.gen(function* () {
          expect(yield* rb.until("cloud", "SignedOut")).not.toHaveProperty("defaultMethod")
        }),
    )
  })

  it("is unavailable when the block's provider does not exist", async () => {
    await withCloud('<GitLogin id="git" />', {}, (rb) =>
      Effect.gen(function* () {
        expect(yield* rb.until("git", "Unavailable")).toMatchObject({
          error: { kind: "providerFailed", message: "There is no credential provider named git." },
        })
        expect((yield* rb.view("git")).credential?._tag).toBe("Unavailable")
        expect((yield* rb.view("git")).actions).toEqual(["credential"])
      }),
    )
  })

  it("takes a provider's defect as the provider failing", async () => {
    await withCloud(
      '<CloudLogin id="cloud" />',
      { cloud: cloud({ detect: () => Effect.die(new Error("segfault")) }) },
      (rb) =>
        Effect.gen(function* () {
          expect(yield* rb.until("cloud", "Unavailable")).toMatchObject({
            error: { kind: "providerFailed" },
          })
        }),
    )
  })
})

// ---------------------------------------------------------------------------
// Signing out
// ---------------------------------------------------------------------------

describe("signing out", () => {
  // useAwsAuth.sso.test.ts
  it("withdraws the block's published credentials", async () => {
    await withCloud(pinned, { cloud: ready }, (rb) =>
      Effect.gen(function* () {
        yield* rb.until("cloud", "Ready")
        expect(Object.keys((yield* rb.outputs).cloud ?? {})).toEqual(["account", "token"])
        expect(yield* rb.act("cloud", { _tag: "SignOut" })).toEqual({ _tag: "Accepted" })
        const state = yield* rb.until("cloud", "SignedOut")
        expect(state).not.toHaveProperty("lastError")
        expect((yield* rb.outputs).cloud).toBeUndefined()
        expect(yield* rb.status("cloud")).toEqual({ _tag: "Idle" })
      }),
    )
    expect(callsOf("cloud")).toEqual(["open", "describe", "detect", "env", "signOut"])
    const events = log.map(({ event }) => event._tag)
    expect(events.indexOf("OutputsWithdrawn")).toBeGreaterThan(events.indexOf("OutputsPublished"))
  })

  // AzureAuth.test.tsx
  it("withdraws the outputs so azureAuthId steps wait again", async () => {
    await withCloud(runbookOf(pinned, DEPLOY), { cloud: ready }, (rb) =>
      Effect.gen(function* () {
        yield* rb.until("cloud", "Ready")
        expect(yield* rb.status("deploy")).toEqual({ _tag: "Idle" })
        yield* rb.act("cloud", { _tag: "SignOut" })
        yield* rb.until("cloud", "SignedOut")
        expect(yield* rb.status("deploy")).toEqual(WAITING_FOR_CLOUD)
      }),
    )
  })

  it("signs out even when the provider cannot, and says why", async () => {
    await withCloud(
      pinned,
      {
        cloud: cloud({
          detect: () => found(who("111")),
          signOut: Effect.fail(credentialError("network", "Offline.")),
        }),
      },
      (rb) =>
        Effect.gen(function* () {
          yield* rb.until("cloud", "Ready")
          yield* rb.act("cloud", { _tag: "SignOut" })
          expect(yield* rb.until("cloud", "SignedOut")).toMatchObject({
            lastError: { kind: "network", message: "Offline." },
          })
        }),
    )
  })
})

// ---------------------------------------------------------------------------
// What a run gets
// ---------------------------------------------------------------------------

describe("a run that names the block in envFrom", () => {
  it("confirms a detected login and then gives a run in envFrom the provider's variables", async () => {
    await withCloud(
      runbookOf('<CloudLogin id="cloud" />', DEPLOY),
      { cloud: cloud({ detect: () => found(who("111")) }) },
      (rb) =>
        Effect.gen(function* () {
          yield* rb.until("cloud", "Found")
          expect(yield* rb.act("cloud", { _tag: "Confirm" })).toEqual({ _tag: "Accepted" })
          yield* rb.until("cloud", "Ready")
          expect((yield* rb.outputs).cloud).toEqual({
            account: { _tag: "Shown", value: "111" },
            token: { _tag: "Hidden" },
          })
          expect(yield* rb.run("deploy")).toEqual(done)
          expect(rb.envOf("deploy")).toMatchObject({
            CLOUD_TOKEN: "tok-SECRET",
            CLOUD_ACCOUNT: "111",
          })
        }),
    )
    // Once to become Ready, once more as the run starts.
    expect(callsOf("cloud").filter((method) => method === "env")).toHaveLength(2)
  })

  // src/domain/exec/executor.test.ts, as env.test.ts ports it, here with a
  // provider in a session.
  it("refuses names no auth block passes, before creating or spawning anything", async () => {
    const evil = (name: string, value: string) => ({
      name,
      value: Redacted.make(value),
      sensitive: false,
      to: ["env" as const],
    })
    await withCloud(
      runbookOf(pinned, '<Shell id="sh" label="sh" script="true" envFrom={["cloud"]} />'),
      {
        cloud: cloud({
          detect: () => found(who("111")),
          env: Effect.succeed({
            values: [
              ...cloudEnv("tok-SECRET").values,
              evil("PATH", "/tmp/evil-bin"),
              evil("BASH_ENV", "/tmp/evil.sh"),
              evil("LD_PRELOAD", "/tmp/evil.so"),
            ],
            expiresAt: Option.none(),
          }),
        }),
      },
      (rb) =>
        Effect.gen(function* () {
          yield* rb.until("cloud", "Ready")
          yield* rb.start("sh")
          const status = yield* rb.wait("sh")
          const message = status?._tag === "Failed" ? status.error.message : ""
          expect(message).toBe(
            "cloud gave BASH_ENV, LD_PRELOAD, PATH, which it does not declare, so the run did not start.",
          )
          expect(rb.inputOf("sh")).toBeUndefined()
        }),
    )
    expect(spawns).toEqual([])
  })

  it("fails a run whose credential was signed out while its provider answered", async () => {
    let answer = () => {}
    const answered = new Promise<void>((resolve) => {
      answer = resolve
    })
    let envCalls = 0
    await withCloud(
      runbookOf(pinned, DEPLOY),
      {
        cloud: cloud({
          detect: () => found(who("111")),
          env: Effect.suspend(() =>
            ++envCalls === 1
              ? Effect.succeed(cloudEnv("tok-SECRET"))
              : Effect.as(
                  Effect.promise(() => answered),
                  cloudEnv("tok-SECRET"),
                ),
          ),
        }),
      },
      (rb) =>
        Effect.gen(function* () {
          yield* rb.until("cloud", "Ready")
          yield* rb.start("deploy")
          yield* rb.act("cloud", { _tag: "SignOut" })
          answer()
          const status = yield* rb.wait("deploy")
          expect(status).toMatchObject({
            _tag: "Failed",
            error: {
              message:
                "cloud could not give the run its credentials: cloud is no longer signed in.",
            },
          })
          expect(rb.inputOf("deploy")).toBeUndefined()
        }),
    )
  })
})

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

const MINUTE = 60_000
/** On the test clock, which starts at the epoch: `minutes` after it. */
const at = (minutes: number) => DateTime.makeUnsafe(minutes * MINUTE)
/** What `env` gives, each call the next entry, the last one from then on. */
const expiring = (...minutes: ReadonlyArray<number>) => {
  let given = 0
  return Effect.sync((): CredentialEnv => ({
    ...cloudEnv("tok-SECRET"),
    expiresAt: Option.some(at(minutes[Math.min(given++, minutes.length - 1)] ?? 0)),
  }))
}
const envCalls = () => callsOf("cloud").filter((method) => method === "env").length

describe("a credential that expires", () => {
  // useCredentialExpiry.test.ts "is valid, then expiring for the last 5
  // minutes, then expired". Expiring and expired are now one state, which
  // withdraws the values; `identity.expiresAt` tells the two apart.
  it("is Ready, then Expired for its last five minutes, which withdraws its values", async () => {
    await withCloud(
      runbookOf(pinned, DEPLOY),
      { cloud: cloud({ detect: () => found(who("111")), env: expiring(60) }) },
      (rb) =>
        Effect.gen(function* () {
          expect(yield* rb.until("cloud", "Ready")).toMatchObject({
            identity: { expiresAt: at(60) },
          })
          yield* TestClock.adjust(54 * MINUTE + 59_999)
          expect(yield* rb.status("cloud")).toEqual(done)
          expect(yield* rb.status("deploy")).toEqual({ _tag: "Idle" })
          yield* TestClock.adjust(1)
          expect(yield* rb.until("cloud", "Expired")).toEqual({
            _tag: "Expired",
            identity: { ...who("111"), expiresAt: at(60) },
          })
          const status = yield* rb.status("cloud")
          expect(status?._tag === "Failed" && status.error).toMatchObject({ kind: "expired" })
          expect((yield* rb.outputs).cloud).toBeUndefined()
          expect(yield* rb.status("deploy")).toEqual(WAITING_FOR_CLOUD)
        }),
      { testClock: true },
    )
    // Once to become Ready, once to try to refresh.
    expect(envCalls()).toBe(2)
  })

  it("refreshes through env in the warning window, and stays Ready while the expiry moves", async () => {
    await withCloud(
      runbookOf(pinned, DEPLOY),
      { cloud: cloud({ detect: () => found(who("111")), env: expiring(60, 120) }) },
      (rb) =>
        Effect.gen(function* () {
          yield* rb.until("cloud", "Ready")
          yield* TestClock.adjust(55 * MINUTE)
          expect(yield* rb.until("cloud", "Ready")).toMatchObject({
            identity: { expiresAt: at(120) },
          })
          expect(yield* rb.status("cloud")).toEqual(done)
          expect(yield* rb.run("deploy")).toEqual(done)
          yield* TestClock.adjust(60 * MINUTE)
          yield* rb.until("cloud", "Expired")
        }),
      { testClock: true },
    )
    // Ready, the refresh at 55, the run, and the refresh at 115 that gave the same expiry.
    expect(envCalls()).toBe(4)
    expect(movesOf("cloud")).toEqual(["Detecting", "Ready", "Ready", "Expired"])
  })

  // useCredentialExpiry.test.ts "starts expiring or expired for a credential
  // already that close". A credential that close is never Ready now.
  it("refuses a credential already within five minutes of its expiry", async () => {
    await withCloud(
      runbookOf(pinned, DEPLOY),
      { cloud: cloud({ detect: () => found(who("111")), env: expiring(4) }) },
      (rb) =>
        Effect.gen(function* () {
          expect(yield* rb.until("cloud", "SignedOut")).toMatchObject({
            lastError: { kind: "expired" },
          })
          expect(yield* rb.status("deploy")).toEqual(WAITING_FOR_CLOUD)
        }),
      { testClock: true },
    )
    expect(movesOf("cloud")).toEqual(["Detecting", "SignedOut"])
  })

  it("fails a run that would get a credential in its warning window, and is Expired", async () => {
    await withCloud(
      runbookOf(pinned, DEPLOY),
      { cloud: cloud({ detect: () => found(who("111")), env: expiring(60, 3) }) },
      (rb) =>
        Effect.gen(function* () {
          yield* rb.until("cloud", "Ready")
          yield* rb.start("deploy")
          const status = yield* rb.wait("deploy")
          expect(status).toMatchObject({
            _tag: "Failed",
            error: {
              message:
                "cloud could not give the run its credentials: cloud's credential expires within 5 minutes, so it was not used.",
            },
          })
          expect(rb.inputOf("deploy")).toBeUndefined()
          expect(yield* rb.until("cloud", "Expired")).toMatchObject({
            identity: { expiresAt: at(3) },
          })
          expect(spawns).toEqual([])
        }),
      { testClock: true },
    )
  })

  it("waits for the later expiry a run's refresh gave before it refreshes again", async () => {
    await withCloud(
      runbookOf(pinned, DEPLOY),
      { cloud: cloud({ detect: () => found(who("111")), env: expiring(60, 120) }) },
      (rb) =>
        Effect.gen(function* () {
          yield* rb.until("cloud", "Ready")
          expect(yield* rb.run("deploy")).toEqual(done)
          expect(yield* rb.until("cloud", "Ready")).toMatchObject({
            identity: { expiresAt: at(120) },
          })
          yield* TestClock.adjust(60 * MINUTE)
          expect(envCalls()).toBe(2)
          expect(yield* rb.status("cloud")).toEqual(done)
          yield* TestClock.adjust(55 * MINUTE)
          yield* rb.until("cloud", "Expired")
        }),
      { testClock: true },
    )
    expect(envCalls()).toBe(3)
  })

  it("wakes for an earlier expiry a run's refresh gave", async () => {
    await withCloud(
      runbookOf(pinned, DEPLOY),
      { cloud: cloud({ detect: () => found(who("111")), env: expiring(120, 15.75) }) },
      (rb) =>
        Effect.gen(function* () {
          yield* rb.until("cloud", "Ready")
          // Halfway through one of the watch's waits, which ends at 11 minutes.
          yield* TestClock.adjust(10.5 * MINUTE)
          expect(yield* rb.run("deploy")).toEqual(done)
          expect(yield* rb.until("cloud", "Ready")).toMatchObject({
            identity: { expiresAt: at(15.75) },
          })
          // The new window opens at 10.75 minutes, before that wait ends.
          yield* TestClock.adjust(MINUTE / 4)
          expect(yield* rb.until("cloud", "Expired")).toMatchObject({
            identity: { expiresAt: at(15.75) },
          })
        }),
      { testClock: true },
    )
    expect(envCalls()).toBe(3)
  })

  it("shows Expired within a minute of the machine waking past the window", async () => {
    let ahead = 0
    await withCloud(
      runbookOf(pinned, DEPLOY),
      { cloud: cloud({ detect: () => found(who("111")), env: expiring(60) }) },
      (rb) =>
        Effect.gen(function* () {
          yield* rb.until("cloud", "Ready")
          // The machine sleeps an hour and a half: the wall clock jumps, and no timer fires.
          ahead = 90 * MINUTE
          expect(yield* rb.status("cloud")).toEqual(done)
          yield* TestClock.adjust(MINUTE)
          expect(yield* rb.until("cloud", "Expired")).toMatchObject({
            identity: { expiresAt: at(60) },
          })
        }),
      { testClock: true, wallClockAhead: () => ahead },
    )
    // Once to become Ready, once to try to refresh on waking.
    expect(envCalls()).toBe(2)
  })

  it("signs in again from Expired", async () => {
    await withCloud(
      '<CloudLogin id="cloud" detect={false} />',
      {
        cloud: cloud({
          signIn: () => Stream.make(signedIn(who("111"))),
          env: expiring(10, 10, 80),
        }),
      },
      (rb) =>
        Effect.gen(function* () {
          yield* rb.until("cloud", "SignedOut")
          yield* rb.act("cloud", { _tag: "SignIn", method: "sso", fields: {} })
          yield* rb.until("cloud", "Ready")
          yield* TestClock.adjust(5 * MINUTE)
          yield* rb.until("cloud", "Expired")
          expect(yield* rb.act("cloud", { _tag: "SignIn", method: "sso", fields: {} })).toEqual({
            _tag: "Accepted",
          })
          expect(yield* rb.until("cloud", "Ready")).toMatchObject({
            identity: { expiresAt: at(80) },
          })
        }),
      { testClock: true },
    )
  })
})

describe("a provider that does not answer", () => {
  it("is given up on after a minute", async () => {
    await withCloud(
      '<CloudLogin id="cloud" />',
      { cloud: cloud({ detect: () => Effect.never }) },
      (rb) =>
        Effect.gen(function* () {
          yield* rb.until("cloud", "Detecting")
          yield* TestClock.adjust(MINUTE)
          expect(yield* rb.until("cloud", "SignedOut")).toMatchObject({
            lastError: { kind: "timedOut", message: "The credential provider did not answer." },
          })
        }),
      { testClock: true },
    )
  })

  it("gives a sign-in fifteen minutes", async () => {
    await withCloud(
      '<CloudLogin id="cloud" detect={false} />',
      { cloud: cloud({ signIn: () => Stream.concat(Stream.make(WAITING), Stream.never) }) },
      (rb) =>
        Effect.gen(function* () {
          yield* rb.until("cloud", "SignedOut")
          yield* rb.act("cloud", { _tag: "SignIn", method: "sso", fields: {} })
          yield* rb.until("cloud", "SigningIn")
          yield* rb.until("cloud", "SigningIn")
          yield* TestClock.adjust(15 * MINUTE - 1)
          expect(yield* rb.status("cloud")).toEqual({ _tag: "Running" })
          yield* TestClock.adjust(1)
          expect(yield* rb.until("cloud", "SignedOut")).toMatchObject({
            lastError: { kind: "timedOut" },
          })
        }),
      { testClock: true },
    )
  })
})

// ---------------------------------------------------------------------------
// Isolation and secrets
// ---------------------------------------------------------------------------

describe("each block's own credential", () => {
  const twoBlocks = runbookOf(
    '<CloudLogin id="a" account="111" />',
    '<CloudLogin id="b" account="222" />',
    '<Run id="ra" command="ra" envFrom={["a"]} />',
    '<Run id="rb" command="rb" envFrom={["b"]} />',
  )
  /** Each block's provider gives its own token; it finds the block's login if the block is in `finding`. */
  const perBlock =
    (...finding: ReadonlyArray<string>) =>
    (config: ProviderConfig): ScriptedProvider => {
      const block = path.basename(config.stateDir)
      const account = block === "a" ? "111" : "222"
      return cloud({
        detect: () =>
          finding.includes(block) ? found(who(account)) : Effect.succeed(Option.none()),
        env: Effect.succeed(cloudEnv(`tok-${block}`, account)),
      })(config)
    }

  // google-credential-registry.test.ts
  it("gives each block its own credential", async () => {
    await withCloud(twoBlocks, { cloud: perBlock("a", "b") }, (rb) =>
      Effect.gen(function* () {
        yield* rb.until("a", "Ready")
        yield* rb.until("b", "Ready")
        yield* rb.run("ra")
        yield* rb.run("rb")
        expect(rb.envOf("ra")).toMatchObject({ CLOUD_TOKEN: "tok-a", CLOUD_ACCOUNT: "111" })
        expect(rb.envOf("rb")).toMatchObject({ CLOUD_TOKEN: "tok-b", CLOUD_ACCOUNT: "222" })
      }),
    )
    const dirs = calls
      .filter((call) => call.method === "open")
      .map((call) => (call.args[1] as ProviderConfig).stateDir)
    expect(new Set(dirs).size).toBe(2)
  })

  // google-credential-registry.test.ts
  it("never lets a block that has not authenticated borrow a neighbour's", async () => {
    await withCloud(twoBlocks, { cloud: perBlock("a") }, (rb) =>
      Effect.gen(function* () {
        yield* rb.until("a", "Ready")
        yield* rb.until("b", "SignedOut")
        expect(yield* rb.status("rb")).toEqual({
          _tag: "Blocked",
          by: [{ _tag: "WaitingFor", block: blockId("b"), capability: "env" }],
        })
        expect((yield* rb.outputs).b).toBeUndefined()
        expect(yield* rb.run("ra")).toEqual(done)
      }),
    )
    expect(callsOf("b")).not.toContain("env")
  })

  it("keeps one session's credentials from another session's", async () => {
    let opened = 0
    await withCloud(
      runbookOf('<CloudLogin id="cloud" account="111" />', DEPLOY),
      {
        cloud: (config) =>
          cloud({
            detect: () => (++opened === 1 ? found(who("111")) : Effect.succeed(Option.none())),
          })(config),
      },
      (rb) =>
        Effect.gen(function* () {
          yield* rb.until("cloud", "Ready")
          const engine = yield* Engine
          const other = yield* engine.openSession({ path: RUNBOOK })
          if (other._tag !== "Opened") throw new Error("the second session did not open")
          const { session, trust } = other.session
          yield* engine.trustSession({ session, hash: trust.hash })
          const block = (id: string) => ({ session, block: blockId(id) })
          const settled = yield* engine.waitForBlock({ ...block("cloud"), timeoutMillis: 5000 })
          expect(settled.block.credential?._tag).toBe("SignedOut")
          expect((yield* engine.getBlock(block("deploy"))).status).toEqual(WAITING_FOR_CLOUD)
          expect((yield* engine.getOutputs({ session })).cloud).toBeUndefined()
          expect(yield* rb.run("deploy")).toEqual(done)
          yield* engine.closeSession({ session })
        }),
    )
    const dirs = calls
      .filter((call) => call.method === "open")
      .map((call) => (call.args[1] as ProviderConfig).stateDir)
    expect(dirs).toHaveLength(2)
    expect(path.basename(dirs[0]!)).toBe(path.basename(dirs[1]!))
    expect(dirs[0]).not.toBe(dirs[1])
  })

  it("shows no secret in a view, an event, an output or an error", async () => {
    const other =
      '<CloudLogin id="other" detect={false} defaults={{ keys: { accessKey: "AKIAVISIBLE", secretKey: "default-SECRET" } }} />'
    await withCloud(runbookOf(pinned, other, DEPLOY), { cloud: ready }, (rb) =>
      Effect.gen(function* () {
        const signedOut = yield* rb.until("other", "SignedOut")
        expect(signedOut._tag === "SignedOut" && signedOut.methods[1]?.defaults).toEqual({
          accessKey: "AKIAVISIBLE",
        })
        yield* rb.until("cloud", "Ready")
        yield* rb.run("deploy")
        expect(rb.envOf("deploy")).toMatchObject({ CLOUD_TOKEN: "tok-SECRET" })
        const shown = [
          JSON.stringify(yield* rb.view("cloud")),
          JSON.stringify(yield* rb.view("other")),
          JSON.stringify(yield* rb.outputs),
          JSON.stringify(yield* rb.view("deploy")),
        ]
        for (const text of shown) expect(text).not.toContain("SECRET")
      }),
    )
    const wire = JSON.stringify(
      Schema.encodeSync(Schema.toCodecJson(Schema.Array(EventEnvelope)))(log),
    )
    expect(wire).toContain("AKIAVISIBLE")
    expect(wire).not.toContain("SECRET")
    expect(JSON.stringify(log)).not.toContain("SECRET")
  })

  it("never shows a sign-in's secret fields, and gives them to its provider", async () => {
    await withCloud(
      '<CloudLogin id="cloud" detect={false} defaults={{ keys: { accessKey: "AKIAVISIBLE", secretKey: "default-SECRET" } }} />',
      { cloud: cloud({ signIn: () => Stream.make(signedIn(who("111"))) }) },
      (rb) =>
        Effect.gen(function* () {
          yield* rb.until("cloud", "SignedOut")
          const fields = { secretKey: Redacted.make("typed-SECRET") }
          yield* rb.act("cloud", { _tag: "SignIn", method: "keys", fields })
          yield* rb.until("cloud", "Ready")
          expect(JSON.stringify(yield* rb.view("cloud"))).not.toContain("SECRET")
        }),
    )
    const wire = JSON.stringify(
      Schema.encodeSync(Schema.toCodecJson(Schema.Array(EventEnvelope)))(log),
    )
    expect(wire).not.toContain("SECRET")
    const [, fields] = argsOf("cloud", "signIn")[0] ?? []
    const given = fields as Record<string, Redacted.Redacted<string>>
    expect(Object.keys(given).sort()).toEqual(["accessKey", "secretKey"])
    expect(Redacted.value(given.accessKey!)).toBe("AKIAVISIBLE")
    expect(Redacted.value(given.secretKey!)).toBe("typed-SECRET")
  })

  // aws-env.test.ts: there the provider's answer; here what the engine keeps of it.
  it("returns found/valid identity metadata and never the key material", async () => {
    await withCloud(
      runbookOf(KEYS, '<CloudLogin id="cloud" keysFrom="keys" />'),
      { cloud: cloud({ detect: () => found(who("111"), "keys") }) },
      (rb) =>
        Effect.gen(function* () {
          yield* rb.run("keys")
          yield* rb.until("cloud", "Found")
          expect(JSON.stringify(yield* rb.view("cloud"))).not.toContain("SECRET")
        }),
    )
    expect(
      JSON.stringify(Schema.encodeSync(Schema.toCodecJson(Schema.Array(EventEnvelope)))(log)),
    ).not.toContain("keys-SECRET")
  })
})

// ---------------------------------------------------------------------------
// The credential store
// ---------------------------------------------------------------------------

describe("the credential store", () => {
  it("holds a block's values exactly while the block is Ready", async () => {
    const id = blockId("cloud")
    const block: AnyBlock = TOY_REGISTRY.CloudLogin
    if (block.class !== "credential") throw new Error("CloudLogin is a credential block")
    const slot = {
      index: 0,
      id,
      block,
      request: block.request({ account: "111", role: "Admin" }),
      outputs: block.outputs({}),
    }
    const store = makeCredentialStore([id])
    /** After each step: the state, and whether the store holds the block's values. */
    const steps: Array<readonly [string | undefined, boolean]> = []
    let becameReady = () => {}
    const isReady = new Promise<void>((resolve) => {
      becameReady = resolve
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const providers = yield* CredentialProviders
        const credentials = makeCredentials([slot], {
          update: (change) =>
            Effect.sync(() => {
              const result = change(() => {})
              const state = credentials.stateOf(0)
              steps.push([state?._tag, store.get(id) !== undefined])
              if (state?._tag === "Ready") becameReady()
              return result
            }),
          outputsOf: () => undefined,
          scope,
          stateFolder: "/state/s1",
          store,
        })
        const started = credentials.enter(
          () => true,
          () => {},
        )
        steps.push([credentials.stateOf(0)?._tag, store.get(id) !== undefined])
        yield* credentials.begin(started, providers.open)
        yield* Effect.promise(() => isReady)
        expect(store.entries().map(([held]) => held)).toEqual([id])
        expect(credentials.outputs(0)?.get("token")).toMatchObject({ sensitive: true })
        yield* credentials.act(0, { _tag: "SignOut" }, providers.open)
        expect(store.entries()).toEqual([])
        expect(credentials.outputs(0)).toBeUndefined()
        yield* Scope.close(scope, Exit.void)
      }).pipe(
        Effect.provide(
          testCredentialProviders({ cloud: cloud({ detect: () => found(who("111")) }) }, []),
        ),
      ),
    )
    expect(steps).toEqual([
      ["Detecting", false],
      ["Ready", true],
      ["SignedOut", false],
    ])
  })

  it("takes no block the session did not make it for", () => {
    const store = makeCredentialStore([blockId("a")])
    expect(() => store.set(blockId("b"), cloudEnv("t"))).toThrow(
      "b is not one of the session's credential blocks.",
    )
    store.set(blockId("a"), cloudEnv("one"))
    store.set(blockId("a"), cloudEnv("two"))
    expect(store.entries()).toHaveLength(1)
  })

  // A run reads its variables from the provider, so the store is what a
  // saved session would take: two sessions' stores share nothing, even for
  // blocks of the same id.
  it("keeps each session's store apart", () => {
    const mine = makeCredentialStore([blockId("cloud")])
    const theirs = makeCredentialStore([blockId("cloud")])
    mine.set(blockId("cloud"), cloudEnv("mine"))
    expect(theirs.get(blockId("cloud"))).toBeUndefined()
    expect(theirs.entries()).toEqual([])
    theirs.set(blockId("cloud"), cloudEnv("theirs"))
    theirs.delete(blockId("cloud"))
    expect(mine.get(blockId("cloud"))).toEqual(cloudEnv("mine"))
  })
})
