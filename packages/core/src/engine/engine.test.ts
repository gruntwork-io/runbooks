import { describe, expect, it } from "bun:test"
import { Deferred, Effect, Fiber, Schema, Stream } from "effect"
import {
  BlockId,
  defineForm,
  defineTask,
  type OutputDecls,
  PropError,
  type TaskError,
  type TaskEvent,
  TaskFailed,
  type TaskInput,
} from "@runbooks/blocks-core/contract"
import type { FieldValue, FormValues } from "@runbooks/blocks-core/form"
import type { BlockStatus } from "@runbooks/blocks-core/status"
import { ContentHash } from "../document/document.ts"
import { testCredentialProviders } from "../test-utils/TestCredentialProviders.ts"
import { testSettingsStore } from "../test-utils/TestSettingsFile.ts"
import { testSessionStore } from "../test-utils/TestSessionStore.ts"
import { makeTestFileSystem } from "../test-utils/TestFileSystem.ts"
import { TOY_REGISTRY, ToyField, toyFormSpec } from "../test-utils/toyRegistry.ts"
import { Engine } from "./engine.ts"
import {
  Caller,
  type EventEnvelope,
  type Origin,
  type OutputView,
  SessionId,
  type SessionView,
} from "./protocol.ts"

const RUNBOOK = "/rb/runbook.mdx"
const blockId = Schema.decodeSync(BlockId)

type Script = (input: TaskInput) => Stream.Stream<TaskEvent<string>, TaskError>

/**
 * The toy registry, with `<Run>` and `<Ask>` running the script their
 * `command` names (nothing, for a command with no script). An output whose
 * key starts with `secret` is sensitive.
 */
const registryWith = (scripts: Readonly<Record<string, Script>>) => ({
  ...TOY_REGISTRY,
  Run: defineTask({
    ...TOY_REGISTRY.Run,
    outputs: (p) =>
      Object.fromEntries(
        (p.outputs ?? []).map((key) => [key, { sensitive: key.startsWith("secret") }]),
      ),
    run: (p, input) => scripts[p.command ?? ""]?.(input) ?? Stream.empty,
  }),
  /** A task with a form of its own, from its YAML children. */
  Ask: defineTask({
    name: "Ask",
    since: "0.1.0",
    class: "task",
    props: Schema.Struct({ command: Schema.String, variables: Schema.Array(ToyField) }),
    children: { kind: "yaml", prop: "variables" },
    references: {},
    runbookFiles: () => [],
    provides: ["run"],
    effects: [],
    outputs: (): OutputDecls<string> => ({}),
    fields: (p) => Effect.succeed(toyFormSpec(p.variables)),
    run: (p, input) => scripts[p.command]?.(input) ?? Stream.empty,
    instruction: () => [],
    plugins: [],
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

/** Runs `program` against an engine for a folder that holds `runbook` at `/rb/runbook.mdx`. */
const withEngine = <A, E>(
  runbook: string,
  scripts: Readonly<Record<string, Script>>,
  program: Effect.Effect<A, E, Engine | Caller>,
  origin: Origin = "person",
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
      Effect.provide(testCredentialProviders({}, [])),
      Effect.provide(testSettingsStore()),
      Effect.provide(testSessionStore()),
      Effect.provide(makeTestFileSystem({ [RUNBOOK]: runbook })),
      Effect.provideService(Caller, { origin }),
    ),
  )

const open = Effect.gen(function* () {
  const engine = yield* Engine
  const result = yield* engine.openSession({ path: RUNBOOK })
  if (result._tag !== "Opened") throw new Error(result.errors.map((e) => e.message).join("\n"))
  return result.session
})

/** The commands a test sends to one session, with block ids as plain strings. */
const commandsFor = (view: SessionView) =>
  Effect.gen(function* () {
    const engine = yield* Engine
    const { session } = view
    const target = (block: string) => ({ session, block: blockId(block) })
    return {
      trust: engine.trustSession({ session, hash: view.trust.hash }),
      run: (block: string) => engine.runBlock(target(block)),
      cancel: (block: string) => engine.cancelBlock(target(block)),
      reset: (block: string) => engine.resetBlock(target(block)),
      block: (block: string, page: { logOffset?: number; logLimit?: number } = {}) =>
        engine.getBlock({ ...target(block), ...page }),
      status: (block: string) => Effect.map(engine.getBlock(target(block)), (b) => b.status),
      fields: (block: string) => Effect.map(engine.getBlock(target(block)), (b) => b.fields),
      set: (block: string, values: Readonly<Record<string, FieldValue>>) =>
        engine.setValues({ ...target(block), values }),
      confirm: (block: string) => engine.confirmValues(target(block)),
      /** The block once its run ends, or as it is after `timeoutMillis`. */
      wait: (block: string, timeoutMillis = 5000) =>
        engine.waitForBlock({ ...target(block), timeoutMillis }),
      outputs: engine.getOutputs({ session }),
      view: engine.getSession({ session }),
      /** Collects the whole event log; join it after `close`. */
      record: Effect.forkChild(Stream.runCollect(engine.events({ session }))),
      close: engine.closeSession({ session }),
    }
  })

/** The statuses a block's `BlockStatusChanged` events gave it, in order. */
const statusesOf = (events: ReadonlyArray<EventEnvelope>, block: string) =>
  events.flatMap(({ event }) =>
    event._tag === "BlockStatusChanged" && event.block === blockId(block) ? [event.status] : [],
  )

const tagsOf = (events: ReadonlyArray<EventEnvelope>) => events.map(({ event }) => event._tag)

const failedWith = (status: BlockStatus | undefined) =>
  status?._tag === "Failed" ? status.error._tag : undefined

const untrusted = { _tag: "Untrusted" } as const
const waitingFor = (block: string) =>
  ({ _tag: "WaitingFor", block: blockId(block), capability: "run" }) as const

const ok: Script = () => Stream.empty

/** Holds a run open: `taken` completes once the run has sent its events; the run ends when `open` does. */
interface Gate {
  readonly taken: Deferred.Deferred<void>
  readonly open: Deferred.Deferred<void>
}
const makeGate = (): Gate => ({ taken: Deferred.makeUnsafe(), open: Deferred.makeUnsafe() })

const gated =
  (gate: Gate, events: ReadonlyArray<TaskEvent<string>> = []): Script =>
  () =>
    Stream.fromIterable(events).pipe(
      Stream.concat(Stream.fromEffectDrain(Deferred.succeed(gate.taken, undefined))),
      Stream.concat(Stream.fromEffectDrain(Deferred.await(gate.open))),
    )

/** Sends `command` as an agent, whoever the test runs as. */
const asAgent = <A, E, R>(command: Effect.Effect<A, E, R>) =>
  Effect.provideService(command, Caller, { origin: "agent" })

/** The fields each of a block's `FieldsChanged` events gave it, in order. */
const fieldsChangedOf = (events: ReadonlyArray<EventEnvelope>, block: string) =>
  events.flatMap(({ event }) =>
    event._tag === "FieldsChanged" && event.block === blockId(block) ? [event.fields] : [],
  )

/** A toy `<Form>`, or another block, with its fields as YAML children. */
const withFields = (openTag: string, lines: ReadonlyArray<string>, closeTag = "</Form>") =>
  [openTag, "```yaml", ...lines, "```", closeTag].join("\n")

/** Region, with a default, and a count, with a default. */
const CONFIG = withFields('<Form id="config">', [
  "- name: region",
  "  type: string",
  "  default: us-east-1",
  "- name: count",
  "  type: int",
  "  default: 3",
])

/** A script that notes the values each run gets, and outputs the region it got. */
const recorder = () => {
  const seen: FormValues[] = []
  const script: Script = (input) =>
    Stream.suspend(() => {
      seen.push(input.values)
      const region = input.values.region
      return Stream.make({
        _tag: "Output",
        key: "region",
        value: typeof region === "string" ? region : "",
      })
    })
  return { script, seen }
}

/** A run that never ends by itself, and notes when it is interrupted. */
const hanging = () => {
  const started = Deferred.makeUnsafe<void>()
  const state = { interrupted: false }
  const script: Script = () =>
    Stream.fromEffectDrain(
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Effect.sync(() => (state.interrupted = true))),
      ),
    )
  return { script, started: Deferred.await(started), state }
}

describe("Engine", () => {
  it("blocks every block of an untrusted session and refuses to run one", async () => {
    let calls = 0
    const counted: Script = () => Stream.fromEffectDrain(Effect.sync(() => calls++))
    await withEngine(
      '<Run id="a" command="count" />',
      { count: counted },
      Effect.gen(function* () {
        const session = yield* open
        const rb = yield* commandsFor(session)
        expect(session.trust.trusted).toBe(false)
        expect(session.blocks[0]?.status).toEqual({ _tag: "Blocked", by: [untrusted] })
        expect(session.blocks[0]?.actions).toEqual([])
        expect(yield* rb.run("a")).toEqual({
          _tag: "Refused",
          reason: { _tag: "Blocked", by: [untrusted] },
        })
      }),
    )
    expect(calls).toBe(0)
  })

  it("trusts a session only for the hash the person was shown, once", async () => {
    const stale = Schema.decodeSync(ContentHash)(`sha256:${"0".repeat(64)}`)
    await withEngine(
      '<Run id="a" command="ok" />',
      { ok },
      Effect.gen(function* () {
        const engine = yield* Engine
        const session = yield* open
        const rb = yield* commandsFor(session)
        const recording = yield* rb.record

        expect(yield* engine.trustSession({ session: session.session, hash: stale })).toEqual({
          _tag: "HashChanged",
          current: session.trust.hash,
        })
        expect((yield* rb.view).trust.trusted).toBe(false)
        expect(yield* rb.trust).toEqual({ _tag: "Trusted" })
        expect(yield* rb.trust).toEqual({ _tag: "Trusted" })
        expect(yield* rb.status("a")).toEqual({ _tag: "Idle" })

        yield* rb.close
        const changes = (yield* Fiber.join(recording)).flatMap(({ event }) =>
          event._tag === "TrustChanged" ? [event] : [],
        )
        expect(changes).toEqual([
          { _tag: "TrustChanged", trust: { trusted: true, hash: session.trust.hash } },
        ])
      }),
    )
  })

  it("forbids an agent to trust a session", async () => {
    await withEngine(
      '<Run id="a" command="ok" />',
      { ok },
      Effect.gen(function* () {
        const rb = yield* commandsFor(yield* open)
        expect((yield* Effect.flip(rb.trust))._tag).toBe("Forbidden")
        expect((yield* rb.view).trust.trusted).toBe(false)
      }),
      "agent",
    )
  })

  it("unblocks a task's dependents when it is done and blocks them again when it is reset", async () => {
    const runbook = [
      '<Run id="a" command="ok" outputs={["region"]} />',
      '<Run id="b" command="ok" dependsOn={["a"]} />',
      '<Run id="c" command="echo {{ .outputs.a.region }}" />',
    ].join("\n\n")
    await withEngine(
      runbook,
      { ok },
      Effect.gen(function* () {
        const rb = yield* commandsFor(yield* open)
        const recording = yield* rb.record
        const blocked = { _tag: "Blocked", by: [waitingFor("a")] } as const
        yield* rb.trust
        expect(yield* rb.run("b")).toEqual({ _tag: "Refused", reason: blocked })

        yield* rb.run("a")
        yield* rb.wait("a")
        expect([yield* rb.status("b"), yield* rb.status("c")]).toEqual([
          { _tag: "Idle" },
          { _tag: "Idle" },
        ])
        yield* rb.reset("a")
        expect([yield* rb.status("b"), yield* rb.status("c")]).toEqual([blocked, blocked])

        yield* rb.close
        const events = yield* Fiber.join(recording)
        expect(statusesOf(events, "b")).toEqual([
          { _tag: "Blocked", by: [untrusted, waitingFor("a")] },
          blocked,
          { _tag: "Idle" },
          blocked,
        ])
        expect(statusesOf(events, "a")).toEqual([
          { _tag: "Blocked", by: [untrusted] },
          { _tag: "Idle" },
          { _tag: "Running" },
          { _tag: "Done", outcome: "success" },
          { _tag: "Idle" },
        ])
      }),
    )
  })

  it("publishes outputs only when a run ends well, and hides sensitive ones", async () => {
    const gate = makeGate()
    const emits = gated(gate, [
      { _tag: "Output", key: "region", value: "us-east-1" },
      { _tag: "Output", key: "secret_token", value: "s3cr3t-value" },
    ])
    const shown = {
      region: { _tag: "Shown", value: "us-east-1" },
      secret_token: { _tag: "Hidden" },
    } as const
    await withEngine(
      '<Run id="a" command="emit" outputs={["region", "secret_token"]} />',
      { emit: emits },
      Effect.gen(function* () {
        const rb = yield* commandsFor(yield* open)
        const recording = yield* rb.record
        yield* rb.trust
        yield* rb.run("a")
        yield* Deferred.await(gate.taken)
        expect(yield* rb.outputs).toEqual({})
        expect((yield* rb.block("a")).outputs).toEqual({})

        yield* Deferred.succeed(gate.open, undefined)
        yield* rb.wait("a")
        const outputs = yield* rb.outputs
        const view = yield* rb.block("a")
        expect(outputs).toEqual({ a: shown })
        expect(view.outputs).toEqual(shown)

        yield* rb.close
        const events = yield* Fiber.join(recording)
        const published = events.flatMap(({ event }) =>
          event._tag === "OutputsPublished" ? [event.outputs] : [],
        )
        expect(published).toEqual([shown])
        expect(JSON.stringify([events, outputs, view])).not.toContain("s3cr3t-value")
      }),
    )
  })

  it("withdraws outputs when a done block runs again and fails, and when it is reset", async () => {
    let attempt = 0
    const flaky: Script = () =>
      Stream.suspend(() =>
        ++attempt === 2
          ? Stream.fail(new TaskFailed({ message: "exit 1", exitCode: 1 }))
          : Stream.make({ _tag: "Output", key: "region", value: "us-east-1" } as const),
      )
    await withEngine(
      '<Run id="a" command="flaky" outputs={["region"]} />',
      { flaky },
      Effect.gen(function* () {
        const rb = yield* commandsFor(yield* open)
        const recording = yield* rb.record
        yield* rb.trust
        yield* rb.run("a")
        yield* rb.wait("a")
        expect(yield* rb.outputs).toEqual({ a: { region: { _tag: "Shown", value: "us-east-1" } } })

        yield* rb.run("a")
        expect(failedWith((yield* rb.wait("a")).block.status)).toBe("TaskFailed")
        expect(yield* rb.outputs).toEqual({})

        yield* rb.run("a")
        yield* rb.wait("a")
        yield* rb.reset("a")
        expect(yield* rb.outputs).toEqual({})

        yield* rb.close
        const outputEvents = tagsOf(yield* Fiber.join(recording)).filter(
          (tag) => tag === "OutputsPublished" || tag === "OutputsWithdrawn",
        )
        expect(outputEvents).toEqual([
          "OutputsPublished",
          "OutputsWithdrawn",
          "OutputsPublished",
          "OutputsWithdrawn",
        ])
      }),
    )
  })

  it("cancels a run by interrupting it", async () => {
    const hang = hanging()
    await withEngine(
      '<Run id="a" command="hang" />',
      { hang: hang.script },
      Effect.gen(function* () {
        const rb = yield* commandsFor(yield* open)
        yield* rb.trust
        expect((yield* rb.run("a"))._tag).toBe("Started")
        yield* hang.started
        expect(yield* rb.cancel("a")).toBe("cancelled")
        expect(hang.state.interrupted).toBe(true)
        expect(failedWith(yield* rb.status("a"))).toBe("TaskCancelled")
        expect(yield* rb.cancel("a")).toBe("notRunning")
      }),
    )
  })

  it("cancels a run it has only just started", async () => {
    await withEngine(
      '<Run id="a" command="hang" />',
      { hang: hanging().script },
      Effect.gen(function* () {
        const rb = yield* commandsFor(yield* open)
        yield* rb.trust
        yield* rb.run("a")
        expect(yield* rb.cancel("a")).toBe("cancelled")
        const settled = yield* rb.wait("a", 1000)
        expect(settled.timedOut).toBe(false)
        expect(failedWith(settled.block.status)).toBe("TaskCancelled")
      }),
    )
  })

  it("interrupts a session's runs when it closes, ends its event stream and forgets it", async () => {
    const hang = hanging()
    await withEngine(
      '<Run id="a" command="hang" />',
      { hang: hang.script },
      Effect.gen(function* () {
        const engine = yield* Engine
        const rb = yield* commandsFor(yield* open)
        const recording = yield* rb.record
        yield* rb.trust
        yield* rb.run("a")
        yield* hang.started
        yield* rb.close

        const events = yield* Fiber.join(recording)
        expect(hang.state.interrupted).toBe(true)
        expect(events.at(-1)?.event).toEqual({ _tag: "SessionClosed" })
        expect(failedWith(statusesOf(events, "a").at(-1))).toBe("TaskCancelled")
        expect((yield* Effect.flip(rb.view))._tag).toBe("UnknownSession")
        expect(yield* engine.listSessions).toEqual([])
      }),
    )
  })

  it("keeps two sessions of one runbook apart", async () => {
    await withEngine(
      '<Run id="a" command="emit" outputs={["region"]} />',
      { emit: () => Stream.make({ _tag: "Output", key: "region", value: "eu-west-1" } as const) },
      Effect.gen(function* () {
        const engine = yield* Engine
        const one = yield* commandsFor(yield* open)
        const two = yield* commandsFor(yield* open)
        const recording = yield* two.record
        yield* one.trust
        yield* one.run("a")
        yield* one.wait("a")

        expect(yield* one.outputs).toEqual({ a: { region: { _tag: "Shown", value: "eu-west-1" } } })
        expect(yield* two.outputs).toEqual({})
        const second = yield* two.view
        expect(second.trust.trusted).toBe(false)
        expect(second.blocks[0]?.status).toEqual({ _tag: "Blocked", by: [untrusted] })
        const listed = (yield* engine.listSessions).map((s) => s.session)
        expect(new Set(listed).size).toBe(2)

        yield* two.close
        const events = yield* Fiber.join(recording)
        expect(events.every((e) => e.session === second.session)).toBe(true)
        expect(tagsOf(events)).not.toContain("TrustChanged")
      }),
    )
  })

  it("never runs a misconfigured block, and still runs the others", async () => {
    const ran: string[] = []
    const record: Script = (input) => Stream.fromEffectDrain(Effect.sync(() => ran.push(input.cwd)))
    const runbook = [
      '<Run id="bad" command="record" dependsOn={["missing"]} />',
      '<Run id="good" command="record" />',
    ].join("\n\n")
    const id = await withEngine(
      runbook,
      { record },
      Effect.gen(function* () {
        const session = yield* open
        const rb = yield* commandsFor(session)
        expect(session.blocks.map((b) => b.status?._tag)).toEqual(["Misconfigured", "Blocked"])
        yield* rb.trust
        expect(yield* rb.run("bad")).toEqual({
          _tag: "Refused",
          reason: { _tag: "Misconfigured" },
        })
        yield* rb.run("good")
        expect((yield* rb.wait("good")).block.status).toEqual({ _tag: "Done", outcome: "success" })
        expect(yield* rb.status("bad")).toEqual({ _tag: "Misconfigured" })
        return session.session
      }),
    )
    // Only the good block ran, in the session's working folder.
    expect(ran).toEqual([`/work/${id}`])
  })

  it("logs a run's lines in order, with outputs it dropped and the warning it ended with", async () => {
    const noisy: Script = () =>
      Stream.make(
        { _tag: "Log", stream: "stdout", line: "one" },
        { _tag: "Log", stream: "stderr", line: "two" },
        { _tag: "Output", key: "undeclared", value: "x" },
        { _tag: "Output", key: "toString", value: "y" },
        { _tag: "Warning", message: "careful" },
      )
    await withEngine(
      '<Run id="a" command="noisy" />',
      { noisy },
      Effect.gen(function* () {
        const rb = yield* commandsFor(yield* open)
        const recording = yield* rb.record
        yield* rb.trust
        yield* rb.run("a")
        expect((yield* rb.wait("a")).block.status).toEqual({ _tag: "Done", outcome: "warning" })

        const view = yield* rb.block("a")
        const lines = view.log?.lines ?? []
        expect(view.outputs).toEqual({})
        expect(lines.map((l) => l.text).slice(0, 2)).toEqual(["one", "two"])
        expect(lines[2]?.text).toContain('"undeclared"')
        expect(lines[3]?.text).toContain('"toString"')
        expect(lines[4]).toEqual({ stream: "stderr", text: "careful" })
        expect((yield* rb.block("a", { logOffset: 1, logLimit: 1 })).log).toEqual({
          offset: 1,
          total: 5,
          lines: [{ stream: "stderr", text: "two" }],
        })

        yield* rb.close
        const logged = (yield* Fiber.join(recording)).flatMap(({ event }) =>
          event._tag === "LogLines" ? [event] : [],
        )
        expect(logged.flatMap((e) => e.lines)).toEqual([...lines])
        expect(logged[0]?.offset).toBe(0)
      }),
    )
  })

  it("replays a session's events after a sequence, then streams new ones", async () => {
    await withEngine(
      '<Run id="a" command="ok" />',
      { ok },
      Effect.gen(function* () {
        const engine = yield* Engine
        const session = yield* open
        const rb = yield* commandsFor(session)
        yield* rb.trust
        const tail = yield* Effect.forkChild(
          Stream.runCollect(engine.events({ session: session.session, after: 1 })),
        )
        const recording = yield* rb.record
        yield* rb.run("a")
        yield* rb.wait("a")
        yield* rb.close

        const all = yield* Fiber.join(recording)
        expect(all.map((e) => e.sequence)).toEqual(all.map((_, i) => i))
        expect(yield* Fiber.join(tail)).toEqual(all.slice(2))
        expect(all.at(-1)?.event._tag).toBe("SessionClosed")
      }),
    )
  })

  it("waits for a run to end, or says it timed out", async () => {
    const gate = makeGate()
    await withEngine(
      '<Run id="a" command="gated" />',
      { gated: gated(gate) },
      Effect.gen(function* () {
        const rb = yield* commandsFor(yield* open)
        yield* rb.trust
        yield* rb.run("a")
        const early = yield* rb.wait("a", 20)
        expect(early.timedOut).toBe(true)
        expect(early.block.status).toEqual({ _tag: "Running" })
        expect(early.block.actions).toEqual(["cancel", "reset"])

        yield* Deferred.succeed(gate.open, undefined)
        const late = yield* rb.wait("a")
        expect(late.timedOut).toBe(false)
        expect(late.block.status).toEqual({ _tag: "Done", outcome: "success" })
        expect(late.block.actions).toEqual(["run", "reset"])
      }),
    )
  })

  it("names what a command could not find or do", async () => {
    const form = '<Form id="config">\n```yaml\n- name: region\n  type: string\n```\n</Form>'
    await withEngine(
      `${form}\n\n<Run id="a" command="ok" />\n\n<GitLogin id="git" />`,
      { ok },
      Effect.gen(function* () {
        const engine = yield* Engine
        const rb = yield* commandsFor(yield* open)
        const nowhere = Schema.decodeSync(SessionId)("no-such-session")
        expect((yield* Effect.flip(engine.getSession({ session: nowhere })))._tag).toBe(
          "UnknownSession",
        )
        expect((yield* Effect.flip(rb.block("b")))._tag).toBe("UnknownBlock")
        expect((yield* Effect.flip(rb.set("b", {})))._tag).toBe("UnknownBlock")
        expect(yield* Effect.flip(rb.run("git"))).toMatchObject({
          _tag: "WrongClass",
          class: "credential",
          expected: ["form", "task"],
        })
        expect(yield* Effect.flip(rb.cancel("config"))).toMatchObject({
          _tag: "WrongClass",
          class: "form",
          expected: ["task"],
        })
        expect(yield* Effect.flip(rb.set("git", { user: "ada" }))).toMatchObject({
          _tag: "WrongClass",
          class: "credential",
          expected: ["form", "task"],
        })
        expect(yield* Effect.flip(rb.confirm("git"))).toMatchObject({
          _tag: "WrongClass",
          class: "credential",
          expected: ["form", "task"],
        })
        expect((yield* Effect.flip(engine.openSession({ path: "/rb/missing.mdx" })))._tag).toBe(
          "RunbookUnreadable",
        )
      }),
    )
  })

  it("does not open a runbook the parser refuses", async () => {
    await withEngine(
      "<NoSuchBlock />",
      {},
      Effect.gen(function* () {
        const engine = yield* Engine
        expect((yield* engine.openSession({ path: RUNBOOK }))._tag).toBe("Invalid")
        expect(yield* engine.listSessions).toEqual([])
      }),
    )
  })
})

describe("Engine values", () => {
  const shown = <A extends FieldValue>(value: A) => ({ _tag: "Shown", value }) as const
  const waitingForValues = (block: string) =>
    ({ _tag: "WaitingFor", block: blockId(block), capability: "values" }) as const

  it("starts a form from its defaults, none of them reviewed", async () => {
    await withEngine(
      CONFIG,
      {},
      Effect.gen(function* () {
        const rb = yield* commandsFor(yield* open)
        const recording = yield* rb.record
        yield* rb.trust
        const view = yield* rb.block("config")
        expect(view.status).toEqual({ _tag: "Idle" })
        expect(view.actions).toEqual(["run", "setValues", "confirmValues"])
        expect(view.fields?.map((f) => [f.name, f.value, f.default, f.reviewed])).toEqual([
          ["region", shown("us-east-1"), "us-east-1", false],
          ["count", shown(3), 3, false],
        ])

        yield* rb.close
        // The log alone gives a client the form.
        expect(fieldsChangedOf(yield* Fiber.join(recording), "config")).toEqual([view.fields ?? []])
      }),
    )
  })

  it("marks a value reviewed once an agent sets or confirms it, and logs each change once", async () => {
    await withEngine(
      CONFIG,
      {},
      Effect.gen(function* () {
        const rb = yield* commandsFor(yield* open)
        const recording = yield* rb.record
        expect(yield* asAgent(rb.set("config", { region: "eu-west-1" }))).toEqual({
          errors: {},
          rejected: {},
          unreviewed: ["count"],
        })
        expect((yield* rb.fields("config"))?.map((f) => [f.name, f.value, f.reviewed])).toEqual([
          ["region", shown("eu-west-1"), true],
          ["count", shown(3), false],
        ])
        yield* asAgent(rb.set("config", { region: "eu-west-1" }))

        const confirmed = yield* asAgent(rb.confirm("config"))
        expect(confirmed.map((f) => [f.name, f.value, f.reviewed])).toEqual([
          ["region", shown("eu-west-1"), true],
          ["count", shown(3), true],
        ])
        yield* asAgent(rb.confirm("config"))

        yield* rb.close
        const changes = fieldsChangedOf(yield* Fiber.join(recording), "config")
        expect(changes.map((fields) => fields.map((f) => f.reviewed))).toEqual([
          [false, false],
          [true, false],
          [true, true],
        ])
      }),
    )
  })

  it("needs input while a field is empty or invalid, and blocks the blocks that read it", async () => {
    const runbook = [
      withFields('<Form id="config">', [
        "- name: name",
        "  type: string",
        "  required: true",
        "- name: email",
        "  type: string",
        "  default: nope",
        "  validations: [{ kind: email }]",
        "- name: count",
        "  type: int",
        "  default: 3",
      ]),
      '<Run id="deploy" command="ok" inputsId={["config"]} />',
    ].join("\n\n")
    await withEngine(
      runbook,
      { ok },
      Effect.gen(function* () {
        const rb = yield* commandsFor(yield* open)
        yield* rb.trust
        const blocked = { _tag: "Blocked", by: [waitingForValues("config")] } as const
        expect(yield* rb.status("config")).toEqual({
          _tag: "NeedsInput",
          fields: ["name", "email"],
        })
        expect(yield* rb.status("deploy")).toEqual(blocked)
        expect(yield* rb.run("deploy")).toEqual({ _tag: "Refused", reason: blocked })

        const entered = yield* rb.set("config", {
          name: "ada",
          email: "ada@example.com",
          count: "three",
        })
        expect(Object.keys(entered.errors)).toEqual(["count"])
        expect(entered.rejected).toEqual({})
        const count = (yield* rb.fields("config"))?.find((f) => f.name === "count")
        expect(count?.value).toEqual(shown("three"))
        expect(count?.error).toBeString()
        expect(yield* rb.status("config")).toEqual({ _tag: "NeedsInput", fields: ["count"] })
        expect(yield* rb.status("deploy")).toEqual(blocked)

        expect((yield* rb.set("config", { count: 4 })).errors).toEqual({})
        expect(yield* rb.status("config")).toEqual({ _tag: "Idle" })
        expect(yield* rb.status("deploy")).toEqual({ _tag: "Idle" })
        expect((yield* rb.run("deploy"))._tag).toBe("Started")
      }),
    )
  })

  it("refuses to run a task whose own form needs input, naming the fields", async () => {
    const ask = withFields(
      '<Ask id="ask" command="ok">',
      ["- name: target", "  type: string", "  required: true"],
      "</Ask>",
    )
    await withEngine(
      ask,
      { ok },
      Effect.gen(function* () {
        const rb = yield* commandsFor(yield* open)
        yield* rb.trust
        const needsInput = { _tag: "NeedsInput", fields: ["target"] } as const
        const view = yield* rb.block("ask")
        expect(view.status).toEqual(needsInput)
        expect(view.actions).toEqual(["setValues", "confirmValues"])
        expect(yield* rb.run("ask")).toEqual({ _tag: "Refused", reason: needsInput })

        yield* rb.set("ask", { target: "prod" })
        expect((yield* rb.block("ask")).actions).toEqual(["run", "setValues", "confirmValues"])
        expect((yield* rb.run("ask"))._tag).toBe("Started")
      }),
    )
  })

  it("gives a task the values of the forms it reads, in order, then its own", async () => {
    const { script, seen } = recorder()
    const runbook = [
      CONFIG,
      withFields('<Form id="extra">', [
        "- name: region",
        "  type: string",
        "  default: eu-west-1",
        "- name: tier",
        "  type: string",
        "  default: gold",
      ]),
      withFields(
        '<Ask id="deploy" command="record" inputsId={["config", "extra"]}>',
        ["- name: tier", "  type: string", "  default: silver"],
        "</Ask>",
      ),
    ].join("\n\n")
    await withEngine(
      runbook,
      { record: script },
      Effect.gen(function* () {
        const rb = yield* commandsFor(yield* open)
        yield* rb.trust
        yield* rb.set("config", { count: 5 })
        yield* rb.run("deploy")
        yield* rb.wait("deploy")
        expect(seen).toEqual([{ region: "eu-west-1", count: 5, tier: "silver" }])
      }),
    )
  })

  it("keeps a dependent's run when a form it read changes, and runs it again with the new values", async () => {
    const { script, seen } = recorder()
    const runbook = [
      CONFIG,
      '<Run id="deploy" command="record" inputsId={["config"]} outputs={["region"]} />',
    ].join("\n\n")
    await withEngine(
      runbook,
      { record: script },
      Effect.gen(function* () {
        const rb = yield* commandsFor(yield* open)
        yield* rb.trust
        yield* rb.run("deploy")
        yield* rb.wait("deploy")
        const done = { _tag: "Done", outcome: "success" } as const

        yield* rb.set("config", { region: "eu-west-1" })
        const after = yield* rb.block("deploy")
        expect(after.status).toEqual(done)
        expect(after.actions).toEqual(["run", "reset"])
        expect(after.outputs).toEqual({ region: shown("us-east-1") })

        yield* rb.run("deploy")
        yield* rb.wait("deploy")
        expect(seen.map((values) => values.region)).toEqual(["us-east-1", "eu-west-1"])
        expect(yield* rb.outputs).toEqual({ deploy: { region: shown("eu-west-1") } })

        yield* rb.set("config", { count: "many" })
        const invalid = yield* rb.block("deploy")
        expect(invalid.status).toEqual(done)
        expect(invalid.actions).toEqual(["reset"])
        expect(yield* rb.run("deploy")).toEqual({
          _tag: "Refused",
          reason: { _tag: "Blocked", by: [waitingForValues("config")] },
        })
      }),
    )
  })

  it("never shows a sensitive field's value in a view, a result or an event", async () => {
    const { script, seen } = recorder()
    const runbook = [
      withFields('<Form id="config">', [
        "- name: token",
        "  type: string",
        "  sensitive: true",
        "  default: default-s3cret@example.com",
        "  validations: [{ kind: email }]",
        "- name: region",
        "  type: string",
        "  default: us-east-1",
      ]),
      '<Run id="deploy" command="record" inputsId={["config"]} />',
    ].join("\n\n")
    await withEngine(
      runbook,
      { record: script },
      Effect.gen(function* () {
        const rb = yield* commandsFor(yield* open)
        const recording = yield* rb.record
        yield* rb.trust
        const review = yield* asAgent(rb.run("deploy"))
        expect(review._tag === "Refused" && review.reason._tag).toBe("NeedsReview")

        const invalid = yield* rb.set("config", { token: "typed-s3cret" })
        expect(Object.keys(invalid.errors)).toEqual(["token"])
        const valid = yield* rb.set("config", { token: "typed-s3cret@example.com" })
        const confirmed = yield* asAgent(rb.confirm("config"))
        const token = confirmed.find((f) => f.name === "token")
        expect(token?.value).toEqual({ _tag: "Hidden" })
        expect(token).not.toHaveProperty("default")

        yield* asAgent(rb.run("deploy"))
        yield* rb.wait("deploy")
        // The task that reads the form gets the value itself.
        expect(seen.map((values) => values.token)).toEqual(["typed-s3cret@example.com"])
        // The form declares the field as an output that is not sensitive; the field still is.
        yield* rb.run("config")
        expect((yield* rb.outputs).config?.token).toEqual({ _tag: "Hidden" })

        const views = [yield* rb.view, yield* rb.block("config"), yield* rb.block("deploy")]
        yield* rb.close
        const events = yield* Fiber.join(recording)
        const everything = JSON.stringify([review, invalid, valid, confirmed, views, events])
        expect(everything).toContain("us-east-1")
        expect(everything).not.toContain("s3cret")
      }),
    )
  })

  it("makes an agent's run or submit wait until the agent has set or confirmed every field it reads", async () => {
    const runbook = [
      CONFIG,
      '<Run id="deploy" command="ok" inputsId={["config"]} />',
      withFields(
        '<Ask id="ask" command="ok">',
        ["- name: target", "  type: string", "  default: prod"],
        "</Ask>",
      ),
    ].join("\n\n")
    await withEngine(
      runbook,
      { ok },
      Effect.gen(function* () {
        const rb = yield* commandsFor(yield* open)
        yield* rb.trust
        const first = yield* asAgent(rb.run("deploy"))
        expect(first).toMatchObject({
          _tag: "Refused",
          reason: { _tag: "NeedsReview", form: "config", unreviewed: ["region", "count"] },
        })
        expect(first._tag === "Refused" && first.reason).toHaveProperty("fields", [
          ...((yield* rb.fields("config")) ?? []),
        ])
        expect(yield* asAgent(rb.run("ask"))).toMatchObject({
          _tag: "Refused",
          reason: { _tag: "NeedsReview", form: "ask", unreviewed: ["target"] },
        })
        expect(yield* asAgent(rb.run("config"))).toMatchObject({
          _tag: "Refused",
          reason: { _tag: "NeedsReview", form: "config", unreviewed: ["region", "count"] },
        })

        // A person sees the form in the window, so their run does not wait.
        expect((yield* rb.run("deploy"))._tag).toBe("Started")
        yield* rb.wait("deploy")

        // A value a person sets is not one the agent has seen.
        const set = yield* rb.set("config", { region: "eu-west-1" })
        expect(set.unreviewed).toEqual(["region", "count"])
        expect(yield* asAgent(rb.run("deploy"))).toMatchObject({
          _tag: "Refused",
          reason: { _tag: "NeedsReview", form: "config", unreviewed: ["region", "count"] },
        })
        yield* asAgent(rb.confirm("config"))
        expect((yield* asAgent(rb.run("deploy")))._tag).toBe("Started")
        yield* rb.wait("deploy")
        expect(yield* asAgent(rb.run("config"))).toEqual({ _tag: "Submitted" })
        expect(yield* rb.status("config")).toEqual({ _tag: "Done", outcome: "success" })
      }),
    )
  })

  it("rejects values for fields a form lacks or nobody may change, and enters the rest", async () => {
    const runbook = withFields('<Form id="config">', [
      "- name: region",
      "  type: string",
      "  default: us-east-1",
      "- name: account",
      "  type: string",
      '  default: "123"',
      "  locked: true",
      "- name: internal",
      "  type: string",
      "  default: kept",
      "  hidden: true",
    ])
    const { script, seen } = recorder()
    await withEngine(
      `${runbook}\n\n<Run id="deploy" command="record" inputsId={["config"]} />`,
      { record: script },
      Effect.gen(function* () {
        const rb = yield* commandsFor(yield* open)
        yield* rb.trust
        const result = yield* asAgent(
          rb.set("config", {
            regin: "eu-west-1",
            region: "eu-west-2",
            account: "456",
            internal: "changed",
          }),
        )
        expect(Object.keys(result.rejected).sort()).toEqual(["account", "internal", "regin"])
        expect(result.rejected.regin).toContain('"region"')
        expect(result.unreviewed).toEqual([])
        const fields = (yield* rb.fields("config")) ?? []
        expect(fields.map((f) => [f.name, f.value, f.readOnly, f.reviewed])).toEqual([
          ["region", shown("eu-west-2"), false, true],
          ["account", shown("123"), true, true],
        ])

        yield* rb.run("deploy")
        yield* rb.wait("deploy")
        expect(seen).toEqual([{ region: "eu-west-2", account: "123", internal: "kept" }])
      }),
    )
  })

  it("does not ask for a field its showWhen hides, and gives a task its default", async () => {
    const { script, seen } = recorder()
    const runbook = [
      withFields('<Form id="config">', [
        "- name: mode",
        "  type: enum",
        "  options: [standard, custom]",
        "  default: standard",
        "- name: endpoint",
        "  type: string",
        "  required: true",
        "  showWhen: { mode: [custom] }",
      ]),
      '<Run id="deploy" command="record" inputsId={["config"]} />',
    ].join("\n\n")
    await withEngine(
      runbook,
      { record: script },
      Effect.gen(function* () {
        const rb = yield* commandsFor(yield* open)
        yield* rb.trust
        const names = Effect.map(rb.fields("config"), (fields) => fields?.map((f) => f.name))
        expect(yield* rb.status("config")).toEqual({ _tag: "Idle" })
        expect(yield* names).toEqual(["mode"])

        yield* rb.set("config", { mode: "custom" })
        expect(yield* rb.status("config")).toEqual({ _tag: "NeedsInput", fields: ["endpoint"] })
        expect(yield* names).toEqual(["mode", "endpoint"])
        yield* rb.set("config", { endpoint: "https://example.com" })
        expect(yield* rb.status("config")).toEqual({ _tag: "Idle" })

        yield* rb.set("config", { mode: "standard" })
        yield* rb.run("deploy")
        yield* rb.wait("deploy")
        expect(seen).toEqual([{ mode: "standard", endpoint: "" }])
      }),
    )
  })

  it("holds no values for a form whose fields cannot be read", async () => {
    await withEngine(
      '<BadForm id="broken" />\n\n<Run id="deploy" command="ok" inputsId={["broken"]} />',
      { ok },
      Effect.gen(function* () {
        const rb = yield* commandsFor(yield* open)
        yield* rb.trust
        const view = yield* rb.block("broken")
        expect(view.status).toEqual({ _tag: "Misconfigured" })
        expect(view.actions).toEqual([])
        expect(view).not.toHaveProperty("fields")
        expect(yield* rb.run("broken")).toEqual({
          _tag: "Refused",
          reason: { _tag: "Misconfigured" },
        })
        const result = yield* rb.set("broken", { region: "eu-west-1" })
        expect(result.rejected.region).toContain("There is no boilerplate.yml at ./gone.")
        expect(yield* rb.confirm("broken")).toEqual([])
        expect(yield* rb.status("deploy")).toEqual({
          _tag: "Blocked",
          by: [waitingForValues("broken")],
        })
      }),
    )
  })

  it("submits a valid form, which stays done and publishes its outputs while it is valid", async () => {
    const ship = "ship {{ .outputs.config.region }}"
    const runbook = [
      withFields('<Form id="config">', [
        "- name: region",
        "  type: string",
        "  default: us-east-1",
        "- name: name",
        "  type: string",
        "  required: true",
      ]),
      `<Run id="ship" command="${ship}" />`,
      '<Run id="read" command="ok" inputsId={["config"]} />',
    ].join("\n\n")
    await withEngine(
      runbook,
      { ok, [ship]: ok },
      Effect.gen(function* () {
        const rb = yield* commandsFor(yield* open)
        const recording = yield* rb.record
        yield* rb.trust
        const done = { _tag: "Done", outcome: "success" } as const
        const waitingForConfig = { _tag: "Blocked", by: [waitingFor("config")] } as const
        expect((yield* rb.block("config")).actions).toEqual(["setValues", "confirmValues"])
        expect(yield* rb.run("config")).toEqual({
          _tag: "Refused",
          reason: { _tag: "NeedsInput", fields: ["name"] },
        })

        // Valid is enough for the blocks that read its values; its outputs wait for the submit.
        yield* rb.set("config", { name: "ada" })
        expect(yield* rb.status("read")).toEqual({ _tag: "Idle" })
        expect(yield* rb.status("ship")).toEqual(waitingForConfig)
        expect(yield* rb.run("config")).toEqual({ _tag: "Submitted" })
        const submitted = yield* rb.block("config")
        expect(submitted.status).toEqual(done)
        expect(submitted.actions).toEqual(["run", "reset", "setValues", "confirmValues"])
        expect(submitted.outputs).toEqual({ region: shown("us-east-1"), name: shown("ada") })
        expect(yield* rb.status("ship")).toEqual({ _tag: "Idle" })

        // A change keeps it done while it is valid, as a submitted Inputs block stays submitted.
        yield* rb.set("config", { region: "eu-west-1" })
        expect(yield* rb.status("config")).toEqual(done)
        yield* rb.set("config", { name: "" })
        expect(yield* rb.status("config")).toEqual({ _tag: "NeedsInput", fields: ["name"] })
        expect(yield* rb.outputs).toEqual({})
        expect(yield* rb.status("ship")).toEqual(waitingForConfig)
        yield* rb.set("config", { name: "bob" })
        expect(yield* rb.outputs).toEqual({
          config: { region: shown("eu-west-1"), name: shown("bob") },
        })

        // A reset undoes the submit, and keeps the values.
        yield* rb.reset("config")
        const reset = yield* rb.block("config")
        expect([reset.status, reset.outputs]).toEqual([{ _tag: "Idle" }, {}])
        expect(reset.fields?.map((f) => f.value)).toEqual([shown("eu-west-1"), shown("bob")])
        expect(yield* rb.status("ship")).toEqual(waitingForConfig)

        yield* rb.close
        const events = yield* Fiber.join(recording)
        const lifecycle = events.flatMap(
          ({ event }): Array<string | Record<string, OutputView>> => {
            if (!("block" in event) || event.block !== blockId("config")) return []
            if (event._tag === "BlockStatusChanged") return [event.status._tag]
            if (event._tag === "OutputsPublished") return [event.outputs]
            return event._tag === "OutputsWithdrawn" ? ["withdrawn"] : []
          },
        )
        expect(lifecycle).toEqual([
          "Blocked",
          "NeedsInput",
          "Idle",
          { region: shown("us-east-1"), name: shown("ada") },
          "Done",
          { region: shown("eu-west-1"), name: shown("ada") },
          "withdrawn",
          "NeedsInput",
          { region: shown("eu-west-1"), name: shown("bob") },
          "Done",
          "withdrawn",
          "Idle",
        ])
      }),
    )
  })

  it("takes back a field's review when a person changes its value, and only then", async () => {
    await withEngine(
      `${CONFIG}\n\n<Run id="deploy" command="ok" inputsId={["config"]} />`,
      { ok },
      Effect.gen(function* () {
        const rb = yield* commandsFor(yield* open)
        yield* rb.trust
        const reviewed = Effect.map(rb.fields("config"), (fields) =>
          fields?.map((f) => [f.name, f.reviewed]),
        )
        yield* asAgent(rb.confirm("config"))
        expect((yield* rb.set("config", { region: "us-east-1", count: 3 })).unreviewed).toEqual([])

        expect((yield* rb.set("config", { region: "eu-west-1" })).unreviewed).toEqual(["region"])
        expect(yield* reviewed).toEqual([
          ["region", false],
          ["count", true],
        ])
        // A person's confirm is not the agent's review.
        yield* rb.confirm("config")
        expect(yield* asAgent(rb.run("deploy"))).toMatchObject({
          _tag: "Refused",
          reason: { _tag: "NeedsReview", form: "config", unreviewed: ["region"] },
        })
        expect((yield* asAgent(rb.set("config", { region: "eu-west-1" }))).unreviewed).toEqual([])
        expect((yield* asAgent(rb.run("deploy")))._tag).toBe("Started")
      }),
    )
  })

  it("holds no value for an empty field, and gives a task what a template prints for one", async () => {
    const { script, seen } = recorder()
    const runbook = [
      withFields('<Form id="config">', [
        "- name: port",
        "  type: int",
        "- name: zone",
        "  type: enum",
        "  options: [a, b]",
        "- name: note",
        "  type: string",
        "- name: suffix",
        "  type: string",
        '  default: ""',
        "- name: tags",
        "  type: list",
        "- name: labels",
        "  type: map",
        "- name: enabled",
        "  type: bool",
      ]),
      '<Run id="deploy" command="record" inputsId={["config"]} />',
    ].join("\n\n")
    await withEngine(
      runbook,
      { record: script },
      Effect.gen(function* () {
        const rb = yield* commandsFor(yield* open)
        yield* rb.trust
        const values = Effect.map(rb.fields("config"), (fields) =>
          Object.fromEntries((fields ?? []).flatMap((f) => (f.value ? [[f.name, f.value]] : []))),
        )
        expect(yield* values).toEqual({ suffix: shown(""), enabled: shown(false) })
        yield* rb.set("config", { port: 8080, zone: "b" })
        expect(yield* values).toMatchObject({ port: shown(8080), zone: shown("b") })
        // A cleared number or choice sends "", which leaves it empty.
        yield* rb.set("config", { port: "", zone: "" })
        expect(yield* values).toEqual({ suffix: shown(""), enabled: shown(false) })

        yield* rb.run("deploy")
        yield* rb.wait("deploy")
        const empty = { port: "", zone: "", note: "", suffix: "", tags: [], labels: {} }
        expect(seen).toEqual([{ ...empty, enabled: false }])
        yield* rb.run("config")
        expect((yield* rb.block("config")).outputs).toEqual({
          port: shown(""),
          zone: shown(""),
          note: shown(""),
          suffix: shown(""),
          tags: shown("[]"),
          labels: shown("{}"),
          enabled: shown("false"),
        })
      }),
    )
  })

  it("never counts as done a form in a loop of forms that wait for each other", async () => {
    const reading = (id: string, targets: ReadonlyArray<string>) =>
      withFields(`<Form id="${id}">`, [
        "- name: x",
        "  type: string",
        `  default: "${targets.map((target) => `{{ .outputs.${target}.x }}`).join(" ")}"`,
      ])
    // The parser reports the loop at `a`, the first; `b` and `c` still wait for each other.
    const runbook = [reading("a", ["b"]), reading("b", ["a", "c"]), reading("c", ["b"])]
    await withEngine(
      runbook.join("\n\n"),
      {},
      Effect.gen(function* () {
        const rb = yield* commandsFor(yield* open)
        yield* rb.trust
        expect(yield* rb.status("a")).toEqual({ _tag: "Misconfigured" })
        expect(yield* rb.status("b")).toEqual({
          _tag: "Blocked",
          by: [waitingFor("a"), waitingFor("c")],
        })
        expect(yield* rb.status("c")).toEqual({ _tag: "Blocked", by: [waitingFor("b")] })
      }),
    )
  })
})

describe("a run's resources", () => {
  it("are released when the run ends, not when the engine does", async () => {
    const released: string[] = []
    /** A task whose run holds a resource in the scope it is given. */
    const hold = defineTask({
      ...TOY_REGISTRY.Run,
      run: () =>
        Stream.fromEffect(
          Effect.acquireRelease(Effect.void, () => Effect.sync(() => released.push("released"))),
        ).pipe(Stream.drain),
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const rb = yield* commandsFor(yield* open)
        yield* rb.trust
        expect((yield* rb.run("a"))._tag).toBe("Started")
        const ran = yield* rb.wait("a")
        expect(ran.block.status).toEqual({ _tag: "Done", outcome: "success" })
        expect(released).toEqual(["released"])
      }).pipe(
        Effect.provide(
          Engine.layer({
            registry: { ...TOY_REGISTRY, Run: hold },
            appVersion: "0.31.0",
            workingFolders: "/work",
            stateFolders: "/state",
            processEnvironment: {},
          }),
        ),
        Effect.provide(testCredentialProviders({}, [])),
        Effect.provide(testSettingsStore()),
        Effect.provide(testSessionStore()),
        Effect.provide(makeTestFileSystem({ [RUNBOOK]: '<Run id="a" command="hold" />' })),
        Effect.provideService(Caller, { origin: "person" }),
      ),
    )
  })
})
