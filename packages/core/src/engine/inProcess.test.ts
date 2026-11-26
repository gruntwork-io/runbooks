import { describe, expect, it } from "bun:test"
import { inspect } from "node:util"
import {
  Cause,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Redacted,
  Schema,
  SchemaGetter,
  SchemaIssue,
  SchemaRepresentation,
  Scope,
  Stream,
} from "effect"
import { FetchHttpClient, HttpEffect } from "effect/http"
import { type Rpc, RpcClient, RpcSchema, RpcSerialization, RpcServer } from "effect/rpc"
import {
  BlockId,
  CredentialError,
  defineDisplay,
  defineForm,
  defineTask,
  type OutputDecls,
  PropError,
  type TaskError,
  type TaskEvent,
  TaskFailed,
} from "@runbooks/blocks-core/contract"
import type { ProviderConfig, ProviderInfo } from "../credential/provider.ts"
import { testCredentialProviders } from "../test-utils/TestCredentialProviders.ts"
import { makeTestFileSystem } from "../test-utils/TestFileSystem.ts"
import { testSessionStore } from "../test-utils/TestSessionStore.ts"
import { testSettingsStore } from "../test-utils/TestSettingsFile.ts"
import { TOY_REGISTRY } from "../test-utils/toyRegistry.ts"
import { Engine } from "./engine.ts"
import { EngineHandlers } from "./handlers.ts"
import { makeInProcessClient } from "./inProcess.ts"
import {
  ApprovalId,
  Caller,
  CallerMiddleware,
  DocumentView,
  type EngineClient,
  type EngineCommand,
  EngineProtocol,
  type EventEnvelope,
  SessionId,
} from "./protocol.ts"

const RUNBOOK = "/rb/runbook.mdx"
/** What a client buffers of a stream unless a call says otherwise: effect's default. */
const STREAM_BUFFER = 16
const blockId = Schema.decodeSync(BlockId)
const sessionId = Schema.decodeSync(SessionId)

type Script = () => Stream.Stream<TaskEvent<string>, TaskError>

/** The toy registry, with `<Run>` running the script its `command` names. An output whose key starts with `secret` is sensitive. */
const registryWith = (scripts: Readonly<Record<string, Script>>) => ({
  ...TOY_REGISTRY,
  Run: defineTask({
    ...TOY_REGISTRY.Run,
    outputs: (p) =>
      Object.fromEntries(
        (p.outputs ?? []).map((key) => [key, { sensitive: key.startsWith("secret") }]),
      ),
    run: (p) => scripts[p.command ?? ""]?.() ?? Stream.empty,
  }),
  /** A display block whose prop is a number written as text, as a client is sent it. */
  Gauge: defineDisplay({
    name: "Gauge",
    since: "0.1.0",
    class: "display",
    props: Schema.Struct({ count: Schema.NumberFromString }),
    children: { kind: "none" },
    references: {},
    runbookFiles: () => [],
    provides: [],
    effects: [],
  }),
  /** A task whose schema decodes its prop and cannot encode it again: a bug in a block. */
  OneWay: defineTask({
    name: "OneWay",
    since: "0.1.0",
    class: "task",
    props: Schema.Struct({
      value: Schema.String.pipe(
        Schema.decodeTo(Schema.String, {
          decode: SchemaGetter.passthrough(),
          encode: SchemaGetter.forbiddenEncoding,
        }),
      ),
    }),
    children: { kind: "none" },
    references: {},
    runbookFiles: () => [],
    provides: ["run"],
    effects: [],
    outputs: (): OutputDecls<string> => ({}),
    run: () => Stream.empty,
    instruction: () => [],
    plugins: [],
  }),
  /** A display block whose schema encodes its prop as a `Date`, which JSON cannot carry: a bug in a block. */
  Dated: defineDisplay({
    name: "Dated",
    since: "0.1.0",
    class: "display",
    props: Schema.Struct({
      at: Schema.Unknown.pipe(
        Schema.decodeTo(Schema.String, {
          decode: SchemaGetter.transform(String),
          encode: SchemaGetter.transform(() => new Date(0)),
        }),
      ),
    }),
    children: { kind: "none" },
    references: {},
    runbookFiles: () => [],
    provides: [],
    effects: [],
  }),
  /** A form whose fields cannot be read, as a template whose `boilerplate.yml` is missing. */
  BadForm: defineForm({
    name: "BadForm",
    since: "0.1.0",
    class: "form",
    props: Schema.Struct({}),
    children: { kind: "none" },
    references: {},
    runbookFiles: () => [],
    provides: ["values"],
    effects: [],
    outputs: () => ({}),
    fields: () =>
      Effect.fail(
        new PropError({ prop: "path", message: "There is no boilerplate.yml at ./gone." }),
      ),
    plugins: [],
  }),
})

const CLOUD_INFO: ProviderInfo = {
  methods: [
    {
      name: "keys",
      label: "Access keys",
      fields: [
        { name: "accessKey", label: "Access key", required: true, secret: false },
        { name: "secretKey", label: "Secret key", required: true, secret: true },
      ],
    },
  ],
  levels: [],
  sources: [],
  requirements: [],
  names: ["CLOUD_TOKEN", "CLOUD_ACCOUNT", "account", "token"],
}

/** A cloud provider that finds nothing, signs in with keys, and gives `tok-SECRET` as a hidden output. */
const cloud = (signedInWith: Array<Readonly<Record<string, Redacted.Redacted<string>>>>) => ({
  cloud: (_config: ProviderConfig) => ({
    info: CLOUD_INFO,
    signIn: (_method: string, fields: Readonly<Record<string, Redacted.Redacted<string>>>) => {
      signedInWith.push(fields)
      return Stream.make({
        _tag: "SignedIn" as const,
        identity: { principal: "ada", kind: "user" as const, method: "keys", targets: {} },
      })
    },
    env: Effect.succeed({
      values: [
        {
          name: "account",
          value: Redacted.make("111"),
          sensitive: false,
          to: ["output" as const],
          file: false,
        },
        {
          name: "token",
          value: Redacted.make("tok-SECRET"),
          sensitive: true,
          to: ["output" as const],
          file: false,
        },
      ],
      expiresAt: Option.none(),
    }),
  }),
})

interface Harness {
  readonly runbook: string
  readonly scripts?: Readonly<Record<string, Script>>
  readonly signedInWith?: Array<Readonly<Record<string, Redacted.Redacted<string>>>>
}

/** The engine, served by `EngineHandlers`, for a folder that holds `runbook` at `/rb/runbook.mdx`. */
const served = ({ runbook, scripts = {}, signedInWith = [] }: Harness) =>
  EngineHandlers.pipe(
    Layer.provideMerge(
      Engine.layer({
        registry: registryWith(scripts),
        appVersion: "0.31.0",
        workingFolders: "/work",
        stateFolders: "/state",
        processEnvironment: {},
      }),
    ),
    Layer.provideMerge(testSettingsStore()),
    Layer.provide(testCredentialProviders(cloud(signedInWith), [])),
    Layer.provide(testSessionStore()),
    Layer.provide(makeTestFileSystem({ [RUNBOOK]: runbook })),
  )

/** Runs `use` with a client for each origin it names, against one engine. */
const withClients = <A, E>(
  harness: Harness,
  use: (clients: {
    readonly person: EngineClient
    readonly agent: EngineClient
  }) => Effect.Effect<A, E, Scope.Scope>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const person = yield* makeInProcessClient("person")
      const agent = yield* makeInProcessClient("agent")
      return yield* use({ person, agent })
    }).pipe(Effect.scoped, Effect.provide(served(harness))),
  )

const opened = (client: EngineClient) =>
  Effect.gen(function* () {
    const result = yield* client.OpenSession({ path: RUNBOOK })
    if (result._tag !== "Opened") throw new Error(result.errors.map((e) => e.message).join("\n"))
    return result.session
  })

/**
 * Reads `stream` from its first item: returns once that has arrived, so
 * what the test does next is read too. The effect it returns gives every
 * item, once the stream ends.
 */
const subscribed = <A, E>(
  subscribe: Effect.Effect<Queue.Dequeue<A, E | Cause.Done>, never, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const queue = yield* subscribe
    const first = yield* Queue.take(queue)
    return Effect.map(Stream.runCollect(Stream.fromQueue(queue)), (rest) => [first, ...rest])
  })

/** Where `schema` holds a `Schema.Redacted`, as paths into its representation. */
const redactedIn = (schema: Schema.Top): ReadonlyArray<string> => {
  const found: Array<string> = []
  const seen = new Set<object>()
  const walk = (node: unknown, path: string): void => {
    if (typeof node !== "object" || node === null || seen.has(node)) return
    seen.add(node)
    if ("id" in node && node.id === "effect/schema/Redacted") found.push(path)
    for (const [key, inner] of Object.entries(node)) walk(inner, `${path}.${key}`)
  }
  walk(SchemaRepresentation.toRepresentation(schema.ast), "")
  return found
}

/** The defect a call died with, as a client sees it. */
const defectOf = <A, E>(exit: Exit.Exit<A, E>): unknown =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined

const FORM = [
  '<Form id="config">',
  "```yaml",
  "- name: region",
  "  type: string",
  "  default: us-east-1",
  "- name: password",
  "  type: string",
  "  sensitive: true",
  "```",
  "</Form>",
].join("\n")

const RUNBOOK_TEXT = [
  FORM,
  '<Run id="greet" command="greet" outputs={["greeting", "secret_token"]} />',
  '<Run id="hang" command="hang" />',
  '<CloudLogin id="cloud" detect={false} />',
].join("\n\n")

const greet: Script = () =>
  Stream.make(
    { _tag: "Log", stream: "stdout", line: "hello" },
    { _tag: "Log", stream: "stderr", line: "warn" },
    { _tag: "Output", key: "greeting", value: "hi" },
    { _tag: "Output", key: "secret_token", value: "s3cr3t-value" },
  )

const hang: Script = () => Stream.never

describe("the in-process transport", () => {
  it("opens, lists, shows and closes sessions, and answers a fault as a typed error", async () => {
    await withClients({ runbook: RUNBOOK_TEXT }, ({ person }) =>
      Effect.gen(function* () {
        const view = yield* opened(person)
        expect(view.trust.trusted).toBe(false)
        expect(view.blocks.map((b) => b.block)).toEqual(
          ["config", "greet", "hang", "cloud"].map((id) => blockId(id)),
        )
        expect(yield* person.ListSessions()).toEqual([
          { session: view.session, name: view.name, path: RUNBOOK, blocks: 4 },
        ])
        expect(yield* person.GetSession({ session: view.session })).toEqual(view)

        const missing = yield* Effect.flip(person.OpenSession({ path: "/rb/missing.mdx" }))
        expect(missing).toMatchObject({ _tag: "RunbookUnreadable", path: "/rb/missing.mdx" })

        yield* person.CloseSession({ session: view.session })
        expect(yield* person.ListSessions()).toEqual([])
        expect(yield* Effect.flip(person.GetSession({ session: view.session }))).toMatchObject({
          _tag: "UnknownSession",
          session: view.session,
        })
      }),
    )
  })

  it("answers a runbook it refuses with its errors, as a result", async () => {
    await withClients({ runbook: "<Nope />" }, ({ person }) =>
      Effect.gen(function* () {
        const result = yield* person.OpenSession({ path: RUNBOOK })
        expect(result._tag).toBe("Invalid")
      }),
    )
  })

  it("runs a block, streams its events, and pages its log", async () => {
    await withClients({ runbook: RUNBOOK_TEXT, scripts: { greet } }, ({ person }) =>
      Effect.gen(function* () {
        const view = yield* opened(person)
        const target = { session: view.session, block: blockId("greet") }
        const recording = yield* subscribed(
          person.Events({ session: view.session }, { asQueue: true }),
        )
        expect(yield* person.RunBlock(target)).toEqual({
          _tag: "Refused",
          reason: { _tag: "Blocked", by: [{ _tag: "Untrusted" }] },
        })
        expect(
          yield* person.TrustSession({ session: view.session, hash: view.trust.hash }),
        ).toEqual({ _tag: "Trusted" })
        expect((yield* person.RunBlock(target))._tag).toBe("Started")
        const done = yield* person.WaitForBlock({ ...target, timeoutMillis: 5000 })
        expect(done.timedOut).toBe(false)
        expect(done.block.status).toEqual({ _tag: "Done", outcome: "success" })

        const page = yield* person.GetBlock({ ...target, logOffset: 1, logLimit: 1 })
        expect(page.log).toEqual({
          offset: 1,
          total: 2,
          lines: [{ stream: "stderr", text: "warn" }],
        })
        const shown = {
          greeting: { _tag: "Shown", value: "hi" },
          secret_token: { _tag: "Hidden" },
        } as const
        expect(page.outputs).toEqual(shown)
        expect(yield* person.GetOutputs({ session: view.session })).toEqual({ greet: shown })

        yield* person.ResetBlock(target)
        expect((yield* person.GetBlock(target)).status).toEqual({ _tag: "Idle" })

        yield* person.CloseSession({ session: view.session })
        const events = yield* recording
        const tags = events.map(({ event }) => event._tag)
        expect(tags).toContain("TrustChanged")
        expect(tags).toContain("LogLines")
        expect(tags).toContain("OutputsPublished")
        expect(tags).toContain("OutputsWithdrawn")
        expect(tags.at(-1)).toBe("SessionClosed")
        expect(events.map(({ sequence }) => sequence)).toEqual(events.map((_, i) => i))
        expect(events.every((e) => e.session === view.session)).toBe(true)
      }),
    )
  })

  it("cancels a run, and names the block or class a command does not apply to", async () => {
    await withClients({ runbook: RUNBOOK_TEXT, scripts: { hang } }, ({ person }) =>
      Effect.gen(function* () {
        const view = yield* opened(person)
        const on = (block: string) => ({ session: view.session, block: blockId(block) })
        yield* person.TrustSession({ session: view.session, hash: view.trust.hash })
        expect((yield* person.RunBlock(on("hang")))._tag).toBe("Started")
        expect(yield* person.CancelBlock(on("hang"))).toBe("cancelled")
        expect(yield* person.CancelBlock(on("hang"))).toBe("notRunning")

        expect(yield* Effect.flip(person.GetBlock(on("nope")))).toMatchObject({
          _tag: "UnknownBlock",
          block: "nope",
        })
        expect(yield* Effect.flip(person.CancelBlock(on("config")))).toMatchObject({
          _tag: "WrongClass",
          class: "form",
          expected: ["task"],
        })
      }),
    )
  })

  it("carries a failed run's error and an unavailable credential's error as the values they are", async () => {
    const fail: Script = () => Stream.fail(new TaskFailed({ message: "exit 2", exitCode: 2 }))
    await withClients(
      { runbook: '<Run id="bad" command="fail" />\n\n<GitLogin id="git" />', scripts: { fail } },
      ({ person }) =>
        Effect.gen(function* () {
          const view = yield* opened(person)
          const on = (block: string) => ({ session: view.session, block: blockId(block) })
          yield* person.TrustSession({ session: view.session, hash: view.trust.hash })
          yield* person.RunBlock(on("bad"))
          const failed = (yield* person.WaitForBlock({ ...on("bad"), timeoutMillis: 5000 })).block
          expect(failed.status).toEqual({
            _tag: "Failed",
            error: new TaskFailed({ message: "exit 2", exitCode: 2 }),
          })
          const git = (yield* person.WaitForBlock({ ...on("git"), timeoutMillis: 5000 })).block
          expect(git.credential).toMatchObject({ _tag: "Unavailable" })
          expect(git.credential?._tag === "Unavailable" && git.credential.error).toBeInstanceOf(
            CredentialError,
          )
        }),
    )
  })

  it("enters and confirms values, counting an agent's as reviewed, and shows a sensitive one hidden", async () => {
    await withClients({ runbook: RUNBOOK_TEXT }, ({ agent }) =>
      Effect.gen(function* () {
        const view = yield* opened(agent)
        const config = { session: view.session, block: blockId("config") }
        const set = yield* agent.SetValues({
          ...config,
          values: { password: "hunter2", nope: "x" },
        })
        expect(set.rejected).toHaveProperty("nope")
        expect(set.unreviewed).toEqual(["region"])
        const fields = yield* agent.ConfirmValues(config)
        expect(fields.map((f) => [f.name, f.reviewed])).toEqual([
          ["region", true],
          ["password", true],
        ])
        expect(fields.find((f) => f.name === "password")?.value).toEqual({ _tag: "Hidden" })
        expect(JSON.stringify(yield* agent.GetBlock(config))).not.toContain("hunter2")
      }),
    )
  })

  it("signs in with a secret that crosses one way, in, and shows the credential's secret output hidden", async () => {
    const signedInWith: Array<Readonly<Record<string, Redacted.Redacted<string>>>> = []
    await withClients({ runbook: RUNBOOK_TEXT, signedInWith }, ({ person }) =>
      Effect.gen(function* () {
        const view = yield* opened(person)
        const cloudBlock = { session: view.session, block: blockId("cloud") }
        const recording = yield* subscribed(
          person.Events({ session: view.session }, { asQueue: true }),
        )
        yield* person.TrustSession({ session: view.session, hash: view.trust.hash })
        const signedOut = yield* person.WaitForBlock({ ...cloudBlock, timeoutMillis: 5000 })
        expect(signedOut.block.credential?._tag).toBe("SignedOut")

        const fields = { accessKey: Redacted.make("AKIA-ID"), secretKey: Redacted.make("hunter2") }
        expect(
          yield* person.ActOnCredential({
            ...cloudBlock,
            action: { _tag: "SignIn", method: "keys", fields },
          }),
        ).toEqual({ _tag: "Accepted" })
        const ready = yield* person.WaitForBlock({ ...cloudBlock, timeoutMillis: 5000 })
        expect(ready.block.credential?._tag).toBe("Ready")
        const outputs = yield* person.GetOutputs({ session: view.session })
        expect(outputs.cloud).toEqual({
          account: { _tag: "Shown", value: "111" },
          token: { _tag: "Hidden" },
        })

        yield* person.CloseSession({ session: view.session })
        const events = yield* recording
        const seen = JSON.stringify([events, ready, outputs])
        expect(seen).not.toContain("hunter2")
        expect(seen).not.toContain("tok-SECRET")
      }),
    )
    expect(signedInWith).toHaveLength(1)
    const [fields] = signedInWith
    expect(Redacted.isRedacted(fields?.secretKey)).toBe(true)
    expect(fields?.secretKey === undefined ? "" : Redacted.value(fields.secretKey)).toBe("hunter2")
  })

  it("holds a typed secret only in a command, as a Redacted crosses in clear", () => {
    // The JSON codecs every transport uses send a Redacted's value as it is.
    const secret = Redacted.make("hunter2")
    expect(Schema.encodeSync(Schema.toCodecJson(Schema.Redacted(Schema.String)))(secret)).toBe(
      "hunter2",
    )
    const rpcs = [...EngineProtocol.requests.values()]
    const answers = rpcs.flatMap((rpc) => {
      const { successSchema: success, errorSchema: error } = rpc
      const schemas = RpcSchema.isStreamSchema(success)
        ? [success.success, success.error, error]
        : [success, error]
      return schemas.flatMap((schema) => redactedIn(schema).map((at) => `${rpc._tag}${at}`))
    })
    expect(answers).toEqual([])
    const commands = rpcs.filter((rpc) => redactedIn(rpc.payloadSchema).length > 0)
    expect(commands.map((rpc) => rpc._tag)).toEqual(["ActOnCredential"])
  })

  it("lets a person answer an approval and refuses an agent", async () => {
    await withClients({ runbook: RUNBOOK_TEXT }, ({ person, agent }) =>
      Effect.gen(function* () {
        const view = yield* opened(person)
        const answer = {
          session: view.session,
          approval: Schema.decodeSync(ApprovalId)("a1"),
          approve: true,
        }
        expect(yield* Effect.flip(person.ResolveApproval(answer))).toMatchObject({
          _tag: "UnknownApproval",
        })
        expect(yield* Effect.flip(agent.ResolveApproval(answer))).toMatchObject({
          _tag: "Forbidden",
          command: "ResolveApproval",
          origin: "agent",
        })
      }),
    )
  })

  it("reads, changes and watches the settings, a person only changing them", async () => {
    await withClients({ runbook: RUNBOOK_TEXT }, ({ person, agent }) =>
      Effect.gen(function* () {
        expect((yield* person.GetSettings()).settings.theme).toBe("system")
        const watched = yield* person.WatchSettings(undefined, { asQueue: true })
        expect((yield* Queue.take(watched)).settings.theme).toBe("system")
        expect(
          yield* Effect.flip(agent.ChangeSettings({ changes: { theme: "dark" } })),
        ).toMatchObject({
          _tag: "Forbidden",
          command: "ChangeSettings",
          origin: "agent",
        })
        const changed = yield* person.ChangeSettings({ changes: { theme: "dark" } })
        expect(changed._tag).toBe("Changed")
        expect((yield* Queue.take(watched)).settings.theme).toBe("dark")
      }),
    )
  })
})

const DOCUMENT = [
  "---",
  "title: Deploy",
  "---",
  "# Deploy",
  "Some *markdown* first.",
  '<Note title="Heads up">\n\nRead **this** first.\n\n</Note>',
  '<Bash id="greet" title="Say hi" description="Greets the world" autoCollapse={true} command="echo hi" />',
  '<Run id="broken" args="not-a-list" />',
  '<BadForm id="gone" />',
  '<Gauge id="gauge" count="3" />',
  '<OneWay id="oneway" value="x" />',
  '<Run id="after" command="ok" dependsOn="greet" />',
  '<Dated at="noon" />',
].join("\n\n")

/** What a person or agent could read of `value`: as JSON, and as `console.log` prints it. */
const printed = (value: unknown): ReadonlyArray<string> => [
  JSON.stringify(value),
  inspect(value, { depth: null }),
]

const SECRET_DEFAULT = "fake-secret-default-5d1e"
const SECRET_VALUE = "fake-secret-value-8b2c"
const SECRET_SIGN_IN_DEFAULT = "fake-secret-sign-in-3a9f"

describe("the session's document", () => {
  it("gives the tree with each block in place, its encoded props or its errors, and no edges", async () => {
    await withClients({ runbook: DOCUMENT }, ({ person }) =>
      Effect.gen(function* () {
        const session = (yield* opened(person)).session
        const document = yield* person.GetDocument({ session })

        expect(document.title).toBe("Deploy")
        const top = document.tree.children ?? []
        expect(top[0]).toMatchObject({ type: "heading", depth: 1 })
        expect(top[1]).toMatchObject({ type: "paragraph" })
        expect(top.filter((node) => node.type === "block").map((node) => node.index)).toEqual([
          0, 1, 2, 3, 4, 5, 6, 7,
        ])
        expect(top[2]).toMatchObject({ type: "block", index: 0, children: [{ type: "paragraph" }] })

        const [note, bash, broken, gone, gauge, oneway, after, dated] = document.blocks
        expect(note).toMatchObject({
          _tag: "Configured",
          index: 0,
          tag: "Note",
          class: "display",
          title: "Heads up",
          props: { title: "Heads up" },
        })
        expect(note).not.toHaveProperty("id")
        // An alias's locks are in its props, as if the author had written them.
        expect(bash).toEqual({
          _tag: "Configured",
          index: 1,
          tag: "Bash",
          block: "Run",
          class: "task",
          id: blockId("greet"),
          span: expect.anything(),
          title: "Say hi",
          description: "Greets the world",
          autoCollapse: true,
          props: { command: "echo hi", shell: "bash" },
        })
        // The parser's error, on the node.
        expect(broken?._tag).toBe("Misconfigured")
        expect(broken).not.toHaveProperty("props")
        expect(
          broken?._tag === "Misconfigured" && broken.errors.map((e) => [e.code, e.location.prop]),
        ).toEqual([["badProp", "args"]])
        // The engine's error, found when the session opened.
        expect(
          gone?._tag === "Misconfigured" && gone.errors.map((e) => [e.code, e.message]),
        ).toEqual([["badProp", "There is no boilerplate.yml at ./gone."]])
        // Encoded with the block's own schema: the text the author wrote, not the number it decodes to.
        expect(gauge).toMatchObject({ _tag: "Configured", props: { count: "3" } })
        // Props the block's schema cannot encode: the block does not run, as the window could not show it.
        const unsent = oneway?._tag === "Misconfigured" ? oneway.errors : []
        expect(unsent.map((e) => [e.code, e.location.block?.id])).toEqual([["badProp", "oneway"]])
        // One line, as the CLI prints it, naming the block and where its schema failed.
        expect(unsent[0]?.message).toContain(
          '<OneWay>\'s props to the window (Encoding is not supported at ["value"])',
        )
        expect(yield* person.RunBlock({ session, block: blockId("oneway") })).toEqual({
          _tag: "Refused",
          reason: { _tag: "Misconfigured" },
        })
        expect(after).toMatchObject({ _tag: "Configured", props: { command: "ok" } })
        // Props that encode to more than JSON: that block's error, and the rest of the document is sent.
        expect(
          dated?._tag === "Misconfigured" && dated.errors.map((e) => e.message.includes("JSON")),
        ).toEqual([true])
        expect(document).not.toHaveProperty("edges")

        expect(
          yield* Effect.flip(person.GetDocument({ session: sessionId("gone") })),
        ).toMatchObject({ _tag: "UnknownSession", session: "gone" })
      }),
    )
  })

  it("carries no runbook text in a YAML error, to an agent or in a refusal", async () => {
    const secret = "fake-secret-yaml-9d2e"
    const fenced = [
      '<Form id="config">',
      "```yaml",
      "- name: token",
      "  sensitive: true",
      `  default: ${secret}`,
      "  default: again",
      "```",
      "</Form>",
    ].join("\n")
    await withClients({ runbook: fenced }, ({ person, agent }) =>
      Effect.gen(function* () {
        const { session } = yield* opened(person)
        const document = yield* agent.GetDocument({ session })
        expect(document.blocks[0]?._tag).toBe("Misconfigured")
        for (const text of printed(document)) expect(text).not.toContain(secret)
      }),
    )
    const front = [
      "---",
      "title: Deploy",
      `api_key: ${secret}`,
      "api_key: again",
      "---",
      "",
      "# Deploy",
    ]
    await withClients({ runbook: front.join("\n") }, ({ agent }) =>
      Effect.gen(function* () {
        const result = yield* agent.OpenSession({ path: RUNBOOK })
        expect(result._tag).toBe("Invalid")
        for (const text of printed(result)) expect(text).not.toContain(secret)
      }),
    )
  })

  it("crosses JSON as a transport carries it, and back", async () => {
    const document = await withClients({ runbook: DOCUMENT }, ({ person }) =>
      Effect.flatMap(opened(person), ({ session }) => person.GetDocument({ session })),
    )
    const json = Schema.toCodecJson(DocumentView)
    const wire = JSON.parse(JSON.stringify(Schema.encodeSync(json)(document)))
    expect(Schema.decodeUnknownSync(json)(wire)).toEqual(document)
  })

  it("holds no sensitive field's default or value, and no secret sign-in field's default", async () => {
    const runbook = [
      '<Form id="config">',
      "```yaml",
      "- name: token",
      "  type: string",
      "  sensitive: true",
      `  default: ${SECRET_DEFAULT}`,
      "- name: password",
      "  type: string",
      "  sensitive: true",
      "```",
      "</Form>",
      `<CloudLogin id="cloud" detect={false} defaults={{ keys: { accessKey: "AKIA-shown", secretKey: "${SECRET_SIGN_IN_DEFAULT}" } }} />`,
      '<Run id="greet" command="greet" outputs={["greeting", "secret_token"]} />',
    ].join("\n\n")
    await withClients({ runbook, scripts: { greet } }, ({ person }) =>
      Effect.gen(function* () {
        const view = yield* opened(person)
        const { session } = view
        yield* person.SetValues({
          session,
          block: blockId("config"),
          values: { password: SECRET_VALUE },
        })
        yield* person.TrustSession({ session, hash: view.trust.hash })
        yield* person.RunBlock({ session, block: blockId("greet") })
        yield* person.WaitForBlock({ session, block: blockId("greet"), timeoutMillis: 5000 })
        // The engine holds each secret, hidden from every view.
        expect((yield* person.GetOutputs({ session })).greet?.secret_token).toEqual({
          _tag: "Hidden",
        })
        const fields = (yield* person.GetBlock({ session, block: blockId("config") })).fields
        expect(fields?.map((f) => [f.name, f.value])).toEqual([
          ["token", { _tag: "Hidden" }],
          ["password", { _tag: "Hidden" }],
        ])
        const document = yield* person.GetDocument({ session })

        const [config, login, run] = document.blocks
        expect([config?._tag, login?._tag, run?._tag]).toEqual([
          "Configured",
          "Configured",
          "Configured",
        ])
        expect(config).not.toHaveProperty("props")
        expect(login).not.toHaveProperty("props")
        for (const text of printed(document))
          for (const secret of [
            SECRET_DEFAULT,
            SECRET_VALUE,
            SECRET_SIGN_IN_DEFAULT,
            "s3cr3t-value",
          ])
            expect(text).not.toContain(secret)
      }),
    )
  })
})

describe("the in-process transport's caller", () => {
  it("takes the origin from the client it made, never from what the client sends", async () => {
    await withClients({ runbook: RUNBOOK_TEXT }, ({ person, agent }) =>
      Effect.gen(function* () {
        const view = yield* opened(person)
        const claim = { session: view.session, hash: view.trust.hash, origin: "person" }
        const asPerson = { headers: { origin: "person", "x-origin": "person" } }
        expect(yield* Effect.flip(agent.TrustSession(claim, asPerson))).toMatchObject({
          _tag: "Forbidden",
          command: "TrustSession",
          origin: "agent",
        })
        expect((yield* person.GetSession({ session: view.session })).trust.trusted).toBe(false)
        const change = { changes: { agentAccess: true }, origin: "person" }
        expect(yield* Effect.flip(agent.ChangeSettings(change, asPerson))).toMatchObject({
          _tag: "Forbidden",
          command: "ChangeSettings",
          origin: "agent",
        })
        expect(yield* person.TrustSession(claim)).toEqual({ _tag: "Trusted" })
      }),
    )
  })
})

describe("the in-process transport's lifetime", () => {
  it("ends every session's events, and every settings watch, when the engine closes", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const engineScope = yield* Scope.make()
        const context = yield* Layer.buildWithScope(served({ runbook: RUNBOOK_TEXT }), engineScope)
        const client = yield* makeInProcessClient("person").pipe(Effect.provideContext(context))
        const view = yield* opened(client)
        const recording = yield* subscribed(
          client.Events({ session: view.session }, { asQueue: true }),
        )
        const watching = yield* subscribed(client.WatchSettings(undefined, { asQueue: true }))
        yield* Scope.close(engineScope, Exit.void)
        const events = yield* recording.pipe(Effect.timeout(Duration.seconds(2)))
        expect(events.at(-1)?.event._tag).toBe("SessionClosed")
        const views = yield* watching.pipe(Effect.timeout(Duration.seconds(2)))
        expect(views.map(({ settings }) => settings.theme)).toEqual(["system"])
      }).pipe(Effect.scoped),
    )
  })
})

// ---------------------------------------------------------------------------
// The transport alone, over stand-in handlers
// ---------------------------------------------------------------------------

const unused = () => Effect.die("not used in this test")

/** A stand-in for every handler. A test overrides the ones it sends; any other dies. */
const UNUSED = {
  OpenSession: unused,
  CloseSession: unused,
  ListSessions: unused,
  GetSession: unused,
  GetDocument: unused,
  TrustSession: unused,
  Events: () => Stream.die("not used in this test"),
  GetBlock: unused,
  SetValues: unused,
  ConfirmValues: unused,
  RunBlock: unused,
  CancelBlock: unused,
  ResetBlock: unused,
  WaitForBlock: unused,
  GetOutputs: unused,
  ActOnCredential: unused,
  ResolveApproval: unused,
  GetSettings: unused,
  ChangeSettings: unused,
  WatchSettings: () => Stream.die("not used in this test"),
}

const SESSION = sessionId("s1")

const envelope = (sequence: number): EventEnvelope => ({
  session: SESSION,
  sequence,
  at: DateTime.makeUnsafe("2026-11-25T12:00:00Z"),
  event: { _tag: "BlockStatusChanged", block: blockId("a"), status: { _tag: "Running" } },
})

/**
 * A client of `handlers` over effect's own HTTP transport, in memory: the
 * request and response bodies are JSON, as on any serialized path.
 */
const overHttp = (handlers: Layer.Layer<Rpc.ToHandler<EngineCommand>>) =>
  Effect.gen(function* () {
    const httpEffect = yield* RpcServer.toHttpEffect(EngineProtocol).pipe(
      Effect.provide(handlers),
      Effect.provideService(CallerMiddleware, (effect) =>
        Effect.provideService(effect, Caller, { origin: "person" }),
      ),
      Effect.provide(RpcSerialization.layerJson),
    )
    const serve = HttpEffect.toWebHandler(httpEffect)
    const fetch = Object.assign(
      (input: string | URL | Request, init?: RequestInit) =>
        serve(
          input instanceof Request ? new Request(input, init) : new Request(input.toString(), init),
        ),
      { preconnect: globalThis.fetch.preconnect },
    )
    return yield* RpcClient.make(EngineProtocol).pipe(
      Effect.provide(RpcClient.layerProtocolHttp({ url: "http://engine.test/rpc" })),
      Effect.provide(RpcSerialization.layerJson),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    )
  })

describe("the in-process transport's encoding", () => {
  it("refuses an answer its schema cannot encode, as a serialized path does", async () => {
    // `blocks` is an Int: an engine bug that counted half a block.
    const handlers = EngineProtocol.toLayer({
      ...UNUSED,
      ListSessions: () =>
        Effect.succeed([{ session: SESSION, name: "rb", path: RUNBOOK, blocks: 1.5 }]),
    })
    const [inProcess, http] = await Effect.runPromise(
      Effect.gen(function* () {
        const local = yield* makeInProcessClient("person").pipe(Effect.provide(handlers))
        const remote = yield* overHttp(handlers)
        return [
          defectOf(yield* Effect.exit(local.ListSessions())),
          defectOf(yield* Effect.exit(remote.ListSessions())),
        ] as const
      }).pipe(Effect.scoped),
    )
    expect(String(inProcess)).toContain('Failed to encode response for RPC "ListSessions"')
    expect(String(inProcess)).toContain('[0]["blocks"]')
    expect(inProcess).toEqual(http)
  })

  it("refuses a command its schema cannot encode before it leaves the client, naming the field", async () => {
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* makeInProcessClient("person").pipe(
          Effect.provide(EngineProtocol.toLayer(UNUSED)),
        )
        return yield* Effect.exit(
          client.GetBlock({ session: SESSION, block: blockId("a"), logLimit: 6000 }),
        )
      }).pipe(Effect.scoped),
    )
    // effect's client makes the payload with its schema before it encodes it.
    const defect = defectOf(exit)
    const issue = defect instanceof Error ? defect.cause : undefined
    expect(SchemaIssue.isIssue(issue) && SchemaIssue.makeFormatterDefault()(issue)).toContain(
      'at ["logLimit"]',
    )
  })
})

describe("the in-process transport's streams", () => {
  it("reads no further ahead of a stalled reader than its buffer", async () => {
    let produced = 0
    const handlers = EngineProtocol.toLayer({
      ...UNUSED,
      Events: () =>
        Stream.range(0, 9_999).pipe(
          Stream.rechunk(1),
          Stream.map((sequence) => {
            produced++
            return envelope(sequence)
          }),
        ),
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* makeInProcessClient("person").pipe(Effect.provide(handlers))
        const events = yield* client.Events({ session: SESSION }, { asQueue: true })
        expect((yield* Queue.take(events)).sequence).toBe(0)
        yield* Effect.sleep(Duration.millis(50))
      }).pipe(Effect.scoped),
    )
    // The client's buffer (16 by default), the one taken, and the chunk the server holds.
    expect(produced).toBeLessThanOrEqual(STREAM_BUFFER + 2)
  })

  it("stops the server's stream when the client's scope closes", async () => {
    const started = Deferred.makeUnsafe<void>()
    const stopped = Deferred.makeUnsafe<void>()
    const handlers = EngineProtocol.toLayer({
      ...UNUSED,
      Events: () =>
        Stream.fromEffectDrain(Deferred.succeed(started, undefined)).pipe(
          Stream.concat(Stream.never),
          Stream.ensuring(Deferred.succeed(stopped, undefined)),
        ),
    })
    const ended = await Effect.runPromise(
      Effect.gen(function* () {
        const clientScope = yield* Scope.make()
        const client = yield* makeInProcessClient("person").pipe(
          Effect.provide(handlers),
          Scope.provide(clientScope),
        )
        // Read outside the client's scope: only the transport can stop the server's side.
        const reading = yield* Effect.forkChild(
          Stream.runDrain(client.Events({ session: SESSION })),
        )
        yield* Deferred.await(started)
        yield* Scope.close(clientScope, Exit.void)
        yield* Deferred.await(stopped).pipe(Effect.timeout(Duration.seconds(1)))
        return yield* Fiber.await(reading)
      }),
    )
    expect(Exit.isFailure(ended) && Cause.hasInterruptsOnly(ended.cause)).toBe(true)
  })
})
