/**
 * A session taking its runbook as it is on disk now (`DocumentChanged`),
 * through the engine: the reload a session's watcher makes when the person
 * chose a watch mode that reloads (`Engine.reloadRunbook`). The runbook is
 * rewritten in the test file system, as an editor saving it would.
 */
import { describe, expect, it } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Option, Redacted, Schema, Stream } from "effect"
import {
  BlockId,
  defineTask,
  type TaskError,
  type TaskEvent,
  type TaskInput,
} from "@runbooks/blocks-core/contract"
import {
  type CredentialEnv,
  CredentialProviders,
  type Identity,
  type ProviderConfig,
  type ProviderInfo,
} from "../credential/provider.ts"
import { FileSystem } from "../services/FileSystem.ts"
import {
  blockOfStateDir,
  type ProviderCall,
  type ScriptedProvider,
  testCredentialProviders,
} from "../test-utils/TestCredentialProviders.ts"
import { testFileSystem } from "../test-utils/TestFileSystem.ts"
import {
  type MemorySessionDatabase,
  memorySessionDatabase,
} from "../test-utils/TestSessionDatabase.ts"
import { testSessionStore } from "../test-utils/TestSessionStore.ts"
import { testSettingsStore } from "../test-utils/TestSettingsFile.ts"
import { TOY_REGISTRY } from "../test-utils/toyRegistry.ts"
import { Engine } from "./engine.ts"
import { Caller, type EventEnvelope, type SessionView } from "./protocol.ts"

const RUNBOOK = "/rb/runbook.mdx"
const blockId = Schema.decodeSync(BlockId)

type Script = (input: TaskInput) => Stream.Stream<TaskEvent<string>, TaskError>

/** Logs `line` and outputs `out` as `value`. */
const says =
  (line: string, value: string): Script =>
  () =>
    Stream.make({ _tag: "Log", stream: "stdout", line }, { _tag: "Output", key: "out", value })

/** Holds a run open: `taken` completes once the run has started; the run ends when `open` does. */
interface Gate {
  readonly taken: Deferred.Deferred<void>
  readonly open: Deferred.Deferred<void>
}
const makeGate = (): Gate => ({ taken: Deferred.makeUnsafe(), open: Deferred.makeUnsafe() })
const gated =
  (gate: Gate): Script =>
  () =>
    Stream.fromEffectDrain(
      Effect.andThen(Deferred.succeed(gate.taken, undefined), Deferred.await(gate.open)),
    )

/** The toy registry, with `<Run>` running the script its `command` names (nothing, for none). */
const registryWith = (scripts: Readonly<Record<string, Script>>) => ({
  ...TOY_REGISTRY,
  Run: defineTask({
    ...TOY_REGISTRY.Run,
    run: (p, input) => scripts[p.command ?? ""]?.(input) ?? Stream.empty,
  }),
})

/** A cloud provider that finds a login at once, and the values its `env` gives. */
const CLOUD_INFO: ProviderInfo = {
  methods: [],
  levels: [],
  sources: [],
  requirements: [],
  names: ["CLOUD_TOKEN", "CLOUD_ACCOUNT", "account", "token"],
}
const WHO: Identity = {
  principal: "arn:cloud::111:role/Admin",
  kind: "role",
  method: "sso",
  targets: { account: { id: "111", name: "acct-111" } },
}
const cloudEnv = (token: string): CredentialEnv => ({
  values: [
    { name: "CLOUD_TOKEN", value: Redacted.make(token), sensitive: true, to: ["env"], file: false },
    { name: "account", value: Redacted.make("111"), sensitive: false, to: ["output"], file: false },
  ],
  expiresAt: Option.none(),
})
const finds = (_config: ProviderConfig): ScriptedProvider => ({
  info: CLOUD_INFO,
  detect: () => Effect.succeed(Option.some({ identity: WHO, source: "env" })),
  env: Effect.succeed(cloudEnv("tok-SECRET")),
})

/** Every provider call, and each provider opened and closed, in order, by the block that opened it. */
interface Providers {
  readonly calls: ProviderCall[]
  readonly opens: string[]
  readonly layer: Layer.Layer<CredentialProviders>
}
const providersOf = (
  scripts: Readonly<Record<string, (config: ProviderConfig) => ScriptedProvider>>,
): Providers => {
  const calls: ProviderCall[] = []
  const opens: string[] = []
  const layer = Layer.effect(
    CredentialProviders,
    Effect.gen(function* () {
      const inner = yield* CredentialProviders
      return {
        open: (name: string, config: ProviderConfig) =>
          Effect.tap(inner.open(name, config), () => {
            const block = blockOfStateDir(config.stateDir)
            opens.push(`open ${block}`)
            return Effect.addFinalizer(() => Effect.sync(() => opens.push(`close ${block}`)))
          }),
      }
    }),
  ).pipe(Layer.provide(testCredentialProviders(scripts, calls)))
  return { calls, opens, layer }
}

/** Runs `program` against an engine for a folder that holds `runbook` at `/rb/runbook.mdx`. */
const withEngine = <A, E>(
  runbook: string,
  program: Effect.Effect<A, E, Engine | Caller | FileSystem>,
  {
    scripts = {},
    providers = providersOf({}),
    database = memorySessionDatabase(),
    files = {},
  }: {
    readonly scripts?: Readonly<Record<string, Script>>
    readonly providers?: Providers
    readonly database?: MemorySessionDatabase
    /** More files in the runbook's folder, by absolute path. */
    readonly files?: Readonly<Record<string, string>>
  } = {},
): Promise<A> =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(
        Engine.layer({
          registry: registryWith(scripts),
          appVersion: "0.31.0",
          workingFolders: "/work",
          stateFolders: "/state",
          processEnvironment: {},
        }),
      ),
      Effect.provide(providers.layer),
      Effect.provide(testSettingsStore()),
      Effect.provide(testSessionStore({ database })),
      Effect.provide(
        Layer.succeed(FileSystem, testFileSystem({ [RUNBOOK]: runbook, ...files }, ["/rb"])),
      ),
      Effect.provideService(Caller, { origin: "person" }),
    ),
  )

/** The commands a test sends to the runbook's session, opened now. */
const opened = Effect.gen(function* () {
  const engine = yield* Engine
  const files = yield* FileSystem
  const result = yield* engine.openSession({ path: RUNBOOK })
  if (result._tag !== "Opened") throw new Error(result.errors.map((e) => e.message).join("\n"))
  const { session } = result.session
  const target = (block: string) => ({ session, block: blockId(block) })
  return {
    view: result.session,
    trust: Effect.flatMap(engine.getSession({ session }), (view) =>
      engine.trustSession({ session, hash: view.trust.hash }),
    ),
    trustFor: (hash: SessionView["trust"]["hash"]) => engine.trustSession({ session, hash }),
    run: (block: string) =>
      Effect.andThen(
        engine.runBlock(target(block)),
        engine.waitForBlock({ ...target(block), timeoutMillis: 5000 }),
      ),
    start: (block: string) => engine.runBlock(target(block)),
    wait: (block: string) => engine.waitForBlock({ ...target(block), timeoutMillis: 5000 }),
    block: (block: string) => engine.getBlock(target(block)),
    set: (block: string, values: Readonly<Record<string, string>>) =>
      engine.setValues({ ...target(block), values }),
    session: engine.getSession({ session }),
    document: engine.getDocument({ session }),
    /** Saves `text` at `file`, as an editor would. */
    write: (file: string, text: string) => files.writeFile(file, text),
    /** Saves `text` as the runbook, then reloads the session as its watcher would. */
    save: (text: string) =>
      Effect.andThen(files.writeFile(RUNBOOK, text), engine.reloadRunbook(session)),
    reload: engine.reloadRunbook(session),
    /** Collects the whole event log; join it after `close`. */
    record: Effect.forkChild(Stream.runCollect(engine.events({ session }))),
    close: engine.closeSession({ session }),
  }
})

/** The events after `sequence`, as tags with the block each names, if any. */
const after = (events: ReadonlyArray<EventEnvelope>, sequence: number | undefined) =>
  events
    .filter((envelope) => envelope.sequence > (sequence ?? -1))
    .map(({ event }) => ("block" in event ? `${event._tag} ${event.block}` : event._tag))

/** A toy `<Form>` with its fields as YAML children, each a string. */
const formOf = (id: string, fields: ReadonlyArray<string>) =>
  [
    `<Form id="${id}">`,
    "```yaml",
    ...fields.flatMap((name) => [`- name: ${name}`, "  type: string"]),
    "```",
    "</Form>",
  ].join("\n")

const runbookOf = (...blocks: ReadonlyArray<string>) => blocks.join("\n\n")

const BEFORE = runbookOf(
  formOf("form", ["region", "size"]),
  '<Run id="kept" command="kept" outputs={["out"]} />',
  '<Run id="changed" command="changed" outputs={["out"]} />',
  '<Run id="removed" command="removed" outputs={["out"]} />',
  '<Run id="dependent" command="dependent" dependsOn="changed" />',
)

/** `BEFORE` saved again: a block added first, so every block moves; the form and `changed` changed; `removed` gone. */
const AFTER = runbookOf(
  '<Run id="added" command="kept" outputs={["out"]} />',
  formOf("form", ["region", "zone"]),
  '<Run id="kept" command="kept" outputs={["out"]} />',
  '<Run id="changed" command="changed" args={["--now"]} outputs={["out"]} />',
  '<Run id="dependent" command="dependent" dependsOn="changed" />',
)

const SCRIPTS = {
  kept: says("kept ran", "k"),
  changed: says("changed ran", "c"),
  removed: says("removed ran", "r"),
  dependent: says("dependent ran", "d"),
}

const DONE = { _tag: "Done", outcome: "success" } as const

describe("reloading a session's runbook", () => {
  it("keeps each block that is as it was, starts over each that changed, drops each that went, and adds each new one", () =>
    withEngine(
      BEFORE,
      Effect.gen(function* () {
        const rb = yield* opened
        const recording = yield* rb.record
        yield* rb.trust
        yield* rb.set("form", { region: "eu-west-1", size: "xl" })
        yield* rb.run("form")
        for (const block of ["kept", "changed", "removed", "dependent"]) yield* rb.run(block)
        const kept = yield* rb.block("kept")
        const { sequence } = yield* rb.session

        expect(yield* rb.save(AFTER)).toEqual({ _tag: "Reloaded" })

        const view = yield* rb.session
        const document = yield* rb.document
        expect(document.hash).not.toBe(rb.view.trust.hash)
        expect(view.trust).toEqual({ trusted: true, hash: document.hash })
        expect(view.blocks.map(({ block }) => String(block))).toEqual([
          "added",
          "form",
          "kept",
          "changed",
          "dependent",
        ])
        // As it was: its run, log and outputs, under the same run id.
        expect(yield* rb.block("kept")).toEqual(kept)
        const changed = yield* rb.block("changed")
        expect([changed.status, changed.log, changed.outputs]).toEqual([
          { _tag: "Idle" },
          undefined,
          {},
        ])
        // It keeps its own run, but waits for `changed` again before it runs.
        const dependent = yield* rb.block("dependent")
        expect([dependent.status, dependent.actions]).toEqual([DONE, ["reset"]])
        expect((yield* rb.block("added")).status).toEqual({ _tag: "Idle" })
        expect(yield* Effect.flip(rb.block("removed"))).toMatchObject({ _tag: "UnknownBlock" })
        // The form changed: its submit is undone, and it keeps the value of the field it still has.
        const form = yield* rb.block("form")
        expect(form.status).toEqual({ _tag: "Idle" })
        expect(form.fields?.map(({ name, value }) => [name, value])).toEqual([
          ["region", { _tag: "Shown", value: "eu-west-1" }],
          ["zone", undefined],
        ])

        yield* rb.close
        const events = yield* Fiber.join(recording)
        expect(after(events, sequence)).toEqual([
          "OutputsWithdrawn changed",
          "OutputsWithdrawn removed",
          "DocumentChanged",
          "TrustChanged",
          "FieldsChanged form",
          "OutputsWithdrawn form",
          "BlockStatusChanged added",
          "BlockStatusChanged form",
          "BlockStatusChanged changed",
          "SessionClosed",
        ])
        const changes = events.flatMap(({ event }) =>
          event._tag === "DocumentChanged" || event._tag === "TrustChanged" ? [event] : [],
        )
        expect(changes.slice(-2)).toEqual([
          { _tag: "DocumentChanged", hash: document.hash },
          { _tag: "TrustChanged", trust: { trusted: true, hash: document.hash } },
        ])
        // The log goes on from the sequence the session had reached.
        const sequences = events.map((envelope) => envelope.sequence)
        expect(sequences).toEqual(sequences.map((_, i) => i))
      }),
      { scripts: SCRIPTS },
    ))

  it("starts a block over when a shared prop its run is given changes, and keeps it when only its title does", () =>
    withEngine(
      runbookOf(
        '<Run id="titled" command="kept" title="Deploy" outputs={["out"]} />',
        '<Run id="staged" command="kept" env={{ STAGE: "dev" }} outputs={["out"]} />',
      ),
      Effect.gen(function* () {
        const rb = yield* opened
        yield* rb.trust
        yield* rb.run("titled")
        yield* rb.run("staged")
        const titled = yield* rb.block("titled")
        expect(
          yield* rb.save(
            runbookOf(
              '<Run id="titled" command="kept" title="Deploy the VPC" outputs={["out"]} />',
              '<Run id="staged" command="kept" env={{ STAGE: "prod" }} outputs={["out"]} />',
            ),
          ),
        ).toEqual({ _tag: "Reloaded" })
        expect(yield* rb.block("titled")).toEqual({ ...titled, title: "Deploy the VPC" })
        expect((yield* rb.block("staged")).status).toEqual({ _tag: "Idle" })
      }),
      { scripts: SCRIPTS },
    ))

  it("keeps a trusted session trusted for the new hash, with the runner it had", () =>
    withEngine(
      BEFORE,
      Effect.gen(function* () {
        const rb = yield* opened
        yield* rb.trust
        yield* rb.save(AFTER)
        const ran = yield* rb.run("added")
        expect(ran.block.status).toEqual(DONE)
        expect(ran.block.log?.lines.map(({ text }) => text)).toEqual(["kept ran"])
      }),
      { scripts: SCRIPTS },
    ))

  it("keeps an untrusted session untrusted, to be trusted for the new hash only", () =>
    withEngine(
      BEFORE,
      Effect.gen(function* () {
        const rb = yield* opened
        const recording = yield* rb.record
        expect(yield* rb.save(AFTER)).toEqual({ _tag: "Reloaded" })
        const { hash } = yield* rb.document
        expect((yield* rb.session).trust).toEqual({ trusted: false, hash })
        expect((yield* rb.block("added")).status).toEqual({
          _tag: "Blocked",
          by: [{ _tag: "Untrusted" }],
        })
        expect(yield* rb.trustFor(rb.view.trust.hash)).toEqual({
          _tag: "HashChanged",
          current: hash,
        })
        yield* rb.close
        const events = yield* Fiber.join(recording)
        expect(
          events.flatMap(({ event }) => (event._tag === "TrustChanged" ? [event] : [])),
        ).toEqual([{ _tag: "TrustChanged", trust: { trusted: false, hash } }])
      }),
    ))

  it("reloads nothing while a block runs, and names the blocks running", () => {
    const gate = makeGate()
    return withEngine(
      BEFORE,
      Effect.gen(function* () {
        const rb = yield* opened
        yield* rb.trust
        yield* rb.start("kept")
        yield* Deferred.await(gate.taken)
        expect(yield* rb.save(AFTER)).toEqual({ _tag: "Running", blocks: [blockId("kept")] })
        expect((yield* rb.document).hash).toBe(rb.view.trust.hash)
        expect((yield* rb.session).blocks.map(({ block }) => block)).not.toContain("added")
        yield* Deferred.succeed(gate.open, undefined)
        yield* rb.wait("kept")
        expect(yield* rb.reload).toEqual({ _tag: "Reloaded" })
      }),
      { scripts: { ...SCRIPTS, kept: gated(gate) } },
    )
  })

  it("changes nothing when the runbook on disk is the one the session holds", () =>
    withEngine(
      BEFORE,
      Effect.gen(function* () {
        const rb = yield* opened
        const recording = yield* rb.record
        yield* rb.trust
        const { sequence } = yield* rb.session
        expect(yield* rb.save(BEFORE)).toEqual({ _tag: "Unchanged" })
        yield* rb.close
        expect(after(yield* Fiber.join(recording), sequence)).toEqual(["SessionClosed"])
      }),
    ))

  it("keeps a credential block that is as it was signed in on the provider it opened, starts a changed one over from its login, and starts a new one", () => {
    const providers = providersOf({ cloud: finds })
    return withEngine(
      runbookOf(
        '<CloudLogin id="cloud" account="111" />',
        '<CloudLogin id="regional" account="111" region="eu-west-1" />',
        '<CloudLogin id="dropped" account="111" />',
      ),
      Effect.gen(function* () {
        const rb = yield* opened
        yield* rb.trust
        for (const block of ["cloud", "regional", "dropped"])
          expect((yield* rb.wait(block)).block.status).toEqual(DONE)
        const before = providers.calls.length
        const opensBefore = providers.opens.length

        yield* rb.save(
          runbookOf(
            '<Run id="first" command="kept" />',
            '<CloudLogin id="cloud" account="111" />',
            '<CloudLogin id="regional" account="111" region="us-east-1" />',
            '<CloudLogin id="joined" account="111" />',
          ),
        )
        expect((yield* rb.wait("regional")).block.status).toEqual(DONE)
        expect((yield* rb.wait("joined")).block.status).toEqual(DONE)

        const cloud = yield* rb.block("cloud")
        expect([cloud.status, cloud.outputs]).toEqual([
          DONE,
          { account: { _tag: "Shown", value: "111" } },
        ])
        const since = providers.calls.slice(before)
        expect(since.filter(({ block }) => block === "cloud")).toEqual([])
        // Each provider the reload stops is closed before any block's opens, so no two share a state folder.
        expect(providers.opens.slice(opensBefore)).toEqual([
          "close regional",
          "close dropped",
          "open regional",
          "open joined",
        ])
        // The changed block's provider opens again with its new props, and finds its login in the values it had.
        expect(
          since.filter(({ block }) => block === "regional").map(({ method }) => method),
        ).toEqual(["open", "describe", "detect", "env"])
        const [open, , detect] = since.filter(({ block }) => block === "regional")
        expect(open?.args[1]).toMatchObject({ settings: { defaultRegion: "us-east-1" } })
        expect(detect?.args[0]).toMatchObject([{ kind: "values", from: "regional" }])
      }),
      { providers, scripts: SCRIPTS },
    )
  })

  it("starts a block over when a file it names changed, and keeps one whose files are as they were", () =>
    withEngine(
      runbookOf(
        '<Run id="deploy" command="kept" path="deploy.sh" outputs={["out"]} />',
        '<Run id="check" command="kept" path="check.sh" outputs={["out"]} />',
      ),
      Effect.gen(function* () {
        const rb = yield* opened
        yield* rb.trust
        yield* rb.run("deploy")
        yield* rb.run("check")
        yield* rb.write("/rb/deploy.sh", "echo deploying again\n")
        expect(yield* rb.reload).toEqual({ _tag: "Reloaded" })
        expect((yield* rb.block("deploy")).status).toEqual({ _tag: "Idle" })
        expect((yield* rb.block("check")).status).toEqual(DONE)
      }),
      {
        scripts: SCRIPTS,
        files: { "/rb/deploy.sh": "echo deploying\n", "/rb/check.sh": "echo checking\n" },
      },
    ))

  it("saves what its blocks hold against the new runbook, and not trust: opening the runbook again resumes the runs, and asks for trust", async () => {
    const database = memorySessionDatabase()
    // `kept` stays first, so the session's place for it is the same in both.
    const opening = runbookOf(
      '<Run id="kept" command="kept" outputs={["out"]} />',
      '<Run id="removed" command="removed" outputs={["out"]} />',
    )
    const saved = runbookOf(
      '<Run id="kept" command="kept" outputs={["out"]} />',
      '<Run id="added" command="kept" outputs={["out"]} />',
    )
    await withEngine(
      opening,
      Effect.gen(function* () {
        const rb = yield* opened
        yield* rb.trust
        yield* rb.run("kept")
        yield* rb.run("removed")
        yield* rb.save(saved)
        // Trusted while the session is open.
        expect((yield* rb.session).trust.trusted).toBe(true)
        yield* rb.close
      }),
      { scripts: SCRIPTS, database },
    )
    // What was saved of a block the runbook no longer has goes with it.
    expect(database.events().filter(({ block }) => block === "removed")).toEqual([])
    await withEngine(
      saved,
      Effect.gen(function* () {
        const rb = yield* opened
        expect(rb.view.trust.trusted).toBe(false)
        // The trust prompt says why it asks again; the run kept is not a block that changed.
        expect(rb.view.resumed?.problems).toEqual([{ _tag: "RunbookChanged", blocks: [] }])
        expect((yield* rb.block("kept")).status).toEqual(DONE)
      }),
      { scripts: SCRIPTS, database },
    )
  })

  it("saves the reloaded runbook's hash as trusted once a person trusts it", async () => {
    const database = memorySessionDatabase()
    const saved = `${BEFORE}\n\nSaved.`
    await withEngine(
      BEFORE,
      Effect.gen(function* () {
        const rb = yield* opened
        yield* rb.save(saved)
        yield* rb.trust
        yield* rb.close
      }),
      { scripts: SCRIPTS, database },
    )
    await withEngine(
      saved,
      Effect.gen(function* () {
        const rb = yield* opened
        expect(rb.view.trust.trusted).toBe(true)
        expect(rb.view.resumed?.problems).toEqual([])
      }),
      { scripts: SCRIPTS, database },
    )
  })
})
