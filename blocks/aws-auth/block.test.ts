import { describe, expect, it } from "bun:test"
import { inspect } from "node:util"
import { Effect, Layer, Option, Redacted, Schema, Stream } from "effect"
import { BlockId } from "@runbooks/blocks-core/contract"
import { fakeCredentialProviders } from "@runbooks/core/credential/fake"
import { serveEngine } from "@runbooks/core/handlers"
import { makeInProcessClient } from "@runbooks/core/inProcess"
import type { BlockView, EngineClient, SessionId } from "@runbooks/core/protocol"
import { FileSystem } from "@runbooks/core/services/FileSystem"
import { testFileSystem } from "@runbooks/core/test-utils/TestFileSystem"
import { testSessionStore } from "@runbooks/core/test-utils/TestSessionStore"
import { testSettingsStore } from "@runbooks/core/test-utils/TestSettingsFile"
import { makeTestSpawner } from "@runbooks/core/test-utils/TestSpawner"
import { TOY_REGISTRY } from "@runbooks/core/test-utils/toyRegistry"
import { type AwsAuthProps, awsAuth, instruction, request } from "./block.ts"
import { AWS_FAKE } from "./fake.ts"

// AwsAuth's request and instruction from its props, then the block through
// the engine against the fake AWS provider, as a window drives it: the
// real parser and session, over an in-memory file system.

const RUNBOOK = "/rb/runbook.mdx"
const SECRET = "fake-aws-secret-0001"
const blockId = Schema.decodeSync(BlockId)
const props = Schema.decodeUnknownSync(awsAuth.props)

describe("AwsAuth's request", () => {
  it("looks in the environment, opens Static Credentials, and fills in us-east-1, with no props", () => {
    expect(request(props({}))).toEqual({
      detect: [{ kind: "env", prefix: Option.none() }],
      pins: {},
      requirements: [],
      settings: {},
      defaultMethod: Option.some("credentials"),
      methodDefaults: {
        credentials: { defaultRegion: "us-east-1" },
        sso: { ssoRegion: "us-east-1", defaultRegion: "us-east-1" },
        profile: { defaultRegion: "us-east-1" },
      },
    })
  })

  it("maps each prop: sources in order, pins, the region setting, the tab and the SSO fields", () => {
    const asked = request(
      props({
        detectCredentials: ["env", { env: { prefix: "PROD_" } }, { env: {} }, { block: "keys" }],
        ssoAccountId: "111111111111",
        ssoRoleName: "Admin",
        ssoStartUrl: "https://example.awsapps.com/start",
        ssoRegion: "eu-west-1",
        defaultRegion: "us-gov-west-1",
        defaultTab: "sso",
      }),
    )
    expect(asked.detect).toEqual([
      { kind: "env", prefix: Option.none() },
      { kind: "env", prefix: Option.some("PROD_") },
      { kind: "env", prefix: Option.none() },
      { kind: "outputs", from: blockId("keys") },
    ])
    expect(asked.pins).toEqual({ account: "111111111111", role: "Admin" })
    expect(asked.settings).toEqual({ defaultRegion: "us-gov-west-1" })
    expect(asked.defaultMethod).toEqual(Option.some("sso"))
    expect(asked.methodDefaults["sso"]).toEqual({
      ssoStartUrl: "https://example.awsapps.com/start",
      ssoRegion: "eu-west-1",
      defaultRegion: "us-gov-west-1",
    })
  })

  it("turns detection off with false, pins nothing for an account alone, and opens Static Credentials for an unknown tab", () => {
    const asked = request(
      props({ detectCredentials: false, ssoAccountId: "111111111111", defaultTab: "keys" }),
    )
    expect(asked.detect).toEqual([])
    expect(asked.pins).toEqual({})
    expect(asked.defaultMethod).toEqual(Option.some("credentials"))
  })

  it("declares every AWS name for a run, and publishes the region and expiry, no key", () => {
    expect(awsAuth.envNames).toEqual([
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_REGION",
      "AWS_CREDENTIAL_EXPIRATION",
    ])
    expect(Object.keys(awsAuth.outputs(props({})))).toEqual([
      "AWS_REGION",
      "AWS_CREDENTIAL_EXPIRATION",
    ])
  })

  it("refuses two block sources, and takes any prefix, as today's block does", () => {
    const refused = (p: unknown) => Schema.decodeUnknownResult(awsAuth.props)(p)._tag
    expect(refused({ detectCredentials: [{ block: "a" }, { block: "b" }] })).toBe("Failure")
    expect(refused({ detectCredentials: [{ block: "a" }, "env"] })).toBe("Success")
    for (const prefix of ["prod_", "PROD", "my-app."])
      expect(request(props({ detectCredentials: [{ env: { prefix } }] })).detect).toEqual([
        { kind: "env", prefix: Option.some(prefix) },
      ])
  })
})

describe("AwsAuth's instruction", () => {
  const text = (p: AwsAuthProps) =>
    instruction(p).map((step) => (step.kind === "text" ? step.markdown : ""))

  it("says to log into AWS, in the account it names, with the SSO details to sign in by hand", () => {
    expect(text({})).toEqual(["Log into AWS."])
    expect(
      text({
        ssoAccountId: "111111111111",
        ssoStartUrl: "https://example.awsapps.com/start",
        ssoRegion: "eu-west-1",
        ssoRoleName: "Admin",
      }),
    ).toEqual([
      "Log into AWS in the `111111111111` account.",
      "- SSO start URL: `https://example.awsapps.com/start`\n- SSO region: `eu-west-1`\n- Role: `Admin`",
    ])
  })

  it("keeps a backtick in a prop inside its code", () => {
    expect(text({ ssoRoleName: "a`b" })[1]).toBe("- Role: ``a`b``")
    expect(text({ ssoRoleName: "`x" })[1]).toBe("- Role: `` `x ``")
  })
})

interface Opened {
  readonly client: EngineClient
  readonly session: SessionId
  readonly view: (block: string) => Effect.Effect<BlockView, unknown>
  /** Every event the session has sent since it was trusted, as it would cross to a window. */
  readonly sent: () => Effect.Effect<ReadonlyArray<unknown>>
}

/** A trusted session of `runbook` against the fake AWS provider, with `environment` as the process's. */
const trusted = <A>(
  runbook: string,
  use: (s: Opened) => Effect.Effect<A, unknown>,
  environment: Record<string, string> = {},
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* makeInProcessClient("person")
        const open = yield* client.OpenSession({ path: RUNBOOK })
        if (open._tag !== "Opened") throw new Error(open.errors.map((e) => e.message).join())
        const { session } = open.session
        yield* client.TrustSession({ session, hash: open.session.trust.hash })
        const { sequence } = yield* client.GetSession({ session })
        const view = (block: string) => client.GetBlock({ session, block: blockId(block) })
        return yield* use({
          client,
          session,
          view,
          // Each event since the trust, replayed from the session's log.
          sent: () =>
            Stream.runCollect(
              client
                .Events({ session, ...(sequence === undefined ? {} : { after: sequence }) })
                .pipe(Stream.interruptWhen(Effect.sleep("200 millis"))),
            ).pipe(Effect.orDie),
        })
      }).pipe(
        Effect.provide(
          serveEngine({
            registry: { ...TOY_REGISTRY, AwsAuth: awsAuth },
            appVersion: "0.31.0",
            workingFolders: "/work",
            stateFolders: "/state",
            processEnvironment: { PATH: "/usr/bin:/bin", HOME: "/home/someone", ...environment },
          }),
        ),
        Effect.provide(fakeCredentialProviders({ aws: AWS_FAKE })),
        Effect.provide(testSettingsStore()),
        Effect.provide(testSessionStore()),
        Effect.provide(makeTestSpawner()),
        Effect.provide(
          Layer.succeed(FileSystem, testFileSystem({ [RUNBOOK]: runbook }, ["/rb", "/state"])),
        ),
      ),
    ),
  )

/** The block's view once its credential is in state `tag`. */
const once = (s: Opened, block: string, tag: string) =>
  Effect.gen(function* () {
    for (;;) {
      const view = yield* s.view(block)
      if (view.credential?._tag === tag) return view
      yield* s.client.WaitForBlock({ session: s.session, block: blockId(block), timeoutMillis: 50 })
    }
  })

describe("AwsAuth against the fake", () => {
  it("signs in with a typed secret key, and no event, view or output holds the key", async () => {
    const { ready, sent } = await trusted('<AwsAuth id="aws" detectCredentials={false} />', (s) =>
      Effect.gen(function* () {
        const signedOut = yield* once(s, "aws", "SignedOut")
        yield* s.client.ActOnCredential({
          session: s.session,
          block: blockId("aws"),
          action: {
            _tag: "SignIn",
            method: "credentials",
            fields: {
              accessKeyId: Redacted.make("AKIAFAKE0001"),
              secretAccessKey: Redacted.make(SECRET),
            },
          },
        })
        const signedIn = yield* once(s, "aws", "Ready")
        return { ready: signedIn, sent: [signedOut, signedIn, ...(yield* s.sent())] }
      }),
    )
    expect(ready.credential).toMatchObject({
      _tag: "Ready",
      identity: {
        principal: "arn:aws:iam::111111111111:user/fake-dev",
        targets: {
          account: { id: "111111111111", name: "fake-production" },
          role: { id: "Admin", name: "Admin" },
        },
      },
    })
    expect(ready.status).toEqual({ _tag: "Done", outcome: "success" })
    expect(ready.outputs).toEqual({})
    // The session's events reached the test, the sign-in's among them.
    expect(
      sent.filter((item) => JSON.stringify(item).includes('"CredentialChanged"')).length,
    ).toBeGreaterThan(1)
    for (const item of sent) {
      expect(JSON.stringify(item)).not.toContain(SECRET)
      expect(inspect(item, { depth: null })).not.toContain(SECRET)
    }
  })

  it("asks to confirm a login it finds in the environment, and needs none when it pins what the login reaches", async () => {
    const states = await trusted(
      [
        '<AwsAuth id="aws" />',
        '<AwsAuth id="prod" detectCredentials={[{ env: { prefix: "PROD_" } }]} ssoAccountId="111111111111" ssoRoleName="Admin" />',
        '<AwsAuth id="other" detectCredentials={[{ env: { prefix: "PROD_" } }]} ssoAccountId="222222222222" ssoRoleName="Admin" />',
      ].join("\n\n"),
      (s) =>
        Effect.gen(function* () {
          const found = yield* once(s, "aws", "Found")
          const prod = yield* once(s, "prod", "Ready")
          const other = yield* s.view("other")
          return { found, prod, other }
        }),
      { AWS_SECRET_ACCESS_KEY: SECRET, PROD_AWS_SECRET_ACCESS_KEY: SECRET },
    )
    expect(states.found.credential).toMatchObject({ _tag: "Found", source: "env" })
    expect(states.prod.credential?._tag).toBe("Ready")
    // The login comes with account 111111111111, so a pin on another is refused.
    expect(states.other.credential?._tag).not.toBe("Ready")
  })

  it("waits for the block a source names, then reads its outputs once that block is done, with no Check again", async () => {
    const states = await trusted(
      [
        [
          '<Publisher id="keys" outputs={{ AWS_SECRET_ACCESS_KEY: "secret" }}>',
          "```yaml",
          "- name: secret",
          "  type: string",
          `  default: ${SECRET}`,
          "```",
          "</Publisher>",
        ].join("\n"),
        '<AwsAuth id="aws" detectCredentials={[{ block: "keys" }]} />',
      ].join("\n\n"),
      (s) =>
        Effect.gen(function* () {
          const { block: before } = yield* s.client.WaitForBlock({
            session: s.session,
            block: blockId("aws"),
            timeoutMillis: 5_000,
          })
          // A form's submit makes its outputs.
          yield* s.client.RunBlock({ session: s.session, block: blockId("keys") })
          const after = yield* once(s, "aws", "Found")
          return { before, after }
        }),
    )
    expect(states.before.status).toEqual({
      _tag: "Blocked",
      by: [{ _tag: "WaitingFor", block: blockId("keys"), capability: "run" }],
    })
    expect(states.before.credential).toBeUndefined()
    expect(states.after.credential).toMatchObject({
      _tag: "Found",
      source: "keys",
      identity: { principal: "arn:aws:iam::111111111111:user/fake-dev" },
    })
  })

  it("selects the account and role it pins after an SSO sign-in, without asking", async () => {
    const ready = await trusted(
      '<AwsAuth id="aws" detectCredentials={false} ssoAccountId="222222222222" ssoRoleName="Admin" />',
      (s) =>
        Effect.gen(function* () {
          yield* once(s, "aws", "SignedOut")
          yield* s.client.ActOnCredential({
            session: s.session,
            block: blockId("aws"),
            action: {
              _tag: "SignIn",
              method: "sso",
              fields: { ssoStartUrl: Redacted.make("https://example.awsapps.com/start") },
            },
          })
          return yield* once(s, "aws", "Ready")
        }),
    )
    expect(ready.credential).toMatchObject({
      identity: {
        principal: "fake-sso@example.com",
        targets: {
          account: { id: "222222222222", name: "fake-staging" },
          role: { id: "Admin", name: "Admin" },
        },
      },
    })
  })

  it("lets the person choose an account, then a role, after an SSO sign-in", async () => {
    const chosen = await trusted(
      '<AwsAuth id="aws" detectCredentials={false} ssoStartUrl="https://example.awsapps.com/start" />',
      (s) =>
        Effect.gen(function* () {
          const act = (action: Parameters<EngineClient["ActOnCredential"]>[0]["action"]) =>
            s.client.ActOnCredential({ session: s.session, block: blockId("aws"), action })
          const signedOut = yield* once(s, "aws", "SignedOut")
          yield* act({
            _tag: "SignIn",
            method: "sso",
            fields: { ssoStartUrl: Redacted.make("https://example.awsapps.com/start") },
          })
          const account = yield* once(s, "aws", "ChoosingTarget")
          yield* act({ _tag: "ChooseTarget", level: "account", id: "222222222222" })
          const role = yield* once(s, "aws", "ChoosingTarget")
          return { signedOut, account, role }
        }),
    )
    expect(chosen.signedOut.credential).toMatchObject({
      _tag: "SignedOut",
      defaultMethod: "credentials",
      methods: [
        { name: "credentials", defaults: { defaultRegion: "us-east-1" } },
        {
          name: "sso",
          defaults: {
            ssoStartUrl: "https://example.awsapps.com/start",
            ssoRegion: "us-east-1",
            defaultRegion: "us-east-1",
          },
        },
        { name: "profile" },
      ],
    })
    expect(chosen.account.credential).toMatchObject({
      level: { name: "account" },
      options: [
        { id: "111111111111", name: "fake-production" },
        { id: "222222222222", name: "fake-staging" },
      ],
    })
    expect(chosen.role.credential).toMatchObject({
      level: { name: "role" },
      options: [{ id: "Admin", name: "Admin" }],
    })
  })
})
