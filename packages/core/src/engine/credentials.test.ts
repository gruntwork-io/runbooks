/**
 * The credential lifecycle (work product 2.6), through the engine: a toy
 * credential block in a trusted session, its provider an in-memory script
 * that notes each call. Every test ends by checking each move the session
 * logged against `TRANSITIONS`. Tests ported from today's auth blocks keep
 * their names; the comment on each says where it came from.
 */
import path from "node:path"
import { describe, expect, it } from "bun:test"
import { Effect, Exit, Option, Redacted, Schema, Scope } from "effect"
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

/** Who a cloud login is, at `account` in `role`. */
const who = (account: string, role = "Admin"): Identity => ({
  principal: `arn:cloud::${account}:role/${role}`,
  kind: "role",
  method: "sso",
  targets: { account: { id: account, name: `acct-${account}` }, role: { id: role, name: role } },
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

/** A trusted session of `runbook` whose credential providers are `scripts`. */
const withCloud = <A>(
  runbook: string,
  scripts: Readonly<Record<string, (config: ProviderConfig) => ScriptedProvider>>,
  use: UseEnvSession<A>,
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

  // useGoogleAuth.test.ts
  it("pauses on a block source that has not executed, then resumes when it has", async () => {
    const keys =
      '<Script id="keys" label="keys" writesOutput={["accessKey=AKIAKEYS", "secretKey=keys-SECRET"]} declares={["accessKey", "secretKey"]} />'
    await withCloud(
      runbookOf(keys, '<CloudLogin id="cloud" keysFrom="keys" />'),
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
        values: { accessKey: expect.anything(), secretKey: expect.anything() },
      },
    ])
    const values = (sources as ReadonlyArray<{ values?: Record<string, unknown> }>)[1]?.values ?? {}
    expect(Object.values(values).every(Redacted.isRedacted)).toBe(true)
    expect(
      Object.values(values).map((value) => Redacted.value(value as Redacted.Redacted)),
    ).toEqual(["AKIAKEYS", "keys-SECRET"])
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

  it("waits to choose a target after sign-in that the block does not pin", async () => {
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
        }),
    )
    expect(argsOf("cloud", "targets")).toEqual([["role", Option.some("111")]])
    expect(callsOf("cloud")).not.toContain("env")
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
// Requirements and an unavailable provider
// ---------------------------------------------------------------------------

describe("a login that cannot be used", () => {
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
        }),
    )
    expect(argsOf("cloud", "detect")[0]?.[1]).toEqual({ pins: {}, requirements: unmet })
  })

  // AzureAuth.test.tsx
  it("says to install the Azure CLI when it's missing", async () => {
    const AZ = { name: "az", installUrl: "https://aka.ms/installazurecli" }
    await withCloud(
      '<CloudLogin id="cloud" />',
      {
        cloud: cloud({
          detect: () =>
            Effect.fail(credentialError("toolMissing", "Install the Azure CLI.", { tool: AZ })),
        }),
      },
      (rb) =>
        Effect.gen(function* () {
          expect(yield* rb.until("cloud", "Unavailable")).toMatchObject({
            error: { kind: "toolMissing", tool: AZ, message: "Install the Azure CLI." },
          })
          const status = yield* rb.status("cloud")
          expect(status?._tag === "Failed" && status.error).toMatchObject({ tool: AZ })
        }),
    )
    expect(callsOf("cloud")).toEqual(["open", "describe", "detect"])
  })

  it("is unavailable when the block's provider does not exist", async () => {
    await withCloud('<GitLogin id="git" />', {}, (rb) =>
      Effect.gen(function* () {
        expect(yield* rb.until("git", "Unavailable")).toMatchObject({
          error: { kind: "providerFailed", message: "There is no credential provider named git." },
        })
        expect((yield* rb.view("git")).credential?._tag).toBe("Unavailable")
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
// What a run gets
// ---------------------------------------------------------------------------

describe("a run that names the block in envFrom", () => {
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

  // aws-env.test.ts: there the provider's answer; here what the engine keeps of it.
  it("returns found/valid identity metadata and never the key material", async () => {
    const keys =
      '<Script id="keys" label="keys" writesOutput={["accessKey=AKIAKEYS", "secretKey=keys-SECRET"]} declares={["accessKey", "secretKey"]} />'
    await withCloud(
      runbookOf(keys, '<CloudLogin id="cloud" keysFrom="keys" />'),
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
