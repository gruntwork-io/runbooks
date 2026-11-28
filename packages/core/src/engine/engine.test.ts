import { describe, expect, it } from "bun:test"
import { Deferred, Effect, Fiber, Redacted, Schema, Stream } from "effect"
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
import type { FieldValue } from "@runbooks/blocks-core/form"
import type { BlockStatus } from "@runbooks/blocks-core/status"
import { ContentHash } from "../document/document.ts"
import { MAX_NESTING } from "../document/mdx.ts"
import { testCredentialProviders } from "../test-utils/TestCredentialProviders.ts"
import { testSettingsStore } from "../test-utils/TestSettingsFile.ts"
import {
  type Hold,
  makeHold,
  type MemorySessionDatabase,
  memorySessionDatabase,
} from "../test-utils/TestSessionDatabase.ts"
import { testSessionStore } from "../test-utils/TestSessionStore.ts"
import { makeTestFileSystem } from "../test-utils/TestFileSystem.ts"
import { TOY_REGISTRY, ToyField, toyFormSpec } from "../test-utils/toyRegistry.ts"
import { Engine } from "./engine.ts"
import {
  ApprovalId,
  Caller,
  type EventEnvelope,
  type Origin,
  type OutputView,
  SessionId,
  type SessionView,
  UnknownSequence,
} from "./protocol.ts"

const RUNBOOK = "/rb/runbook.mdx"
const blockId = Schema.decodeSync(BlockId)

type Script = (input: TaskInput) => Stream.Stream<TaskEvent<string>, TaskError>

/**
 * The toy registry, with `<Run>`, `<Solo>`, `<Quiet>` and `<Ask>` running the script
 * their `command` names (nothing, for a command with no script). An output
 * whose key starts with `secret` is sensitive.
 */
const registryWith = (scripts: Readonly<Record<string, Script>>) => {
  const scripted = defineTask({
    ...TOY_REGISTRY.Run,
    outputs: (p) =>
      Object.fromEntries(
        (p.outputs ?? []).map((key) => [key, { sensitive: key.startsWith("secret") }]),
      ),
    run: (p, input) => scripts[p.command ?? ""]?.(input) ?? Stream.empty,
  })
  return {
    ...TOY_REGISTRY,
    Run: scripted,
    /** A `<Run>` that runs alone (`TaskBlock.exclusive`), unless its `shell` is `beside`. */
    Solo: defineTask({ ...scripted, name: "Solo", exclusive: (p) => p.shell !== "beside" }),
    /** A `<Run>` that runs no commands: it declares no `process` effect. */
    Quiet: defineTask({ ...scripted, name: "Quiet", effects: [] }),
    /** A task with a form of its own, from its YAML children, that runs commands, so it takes `env`. */
    Ask: defineTask({
      name: "Ask",
      since: "0.1.0",
      class: "task",
      props: Schema.Struct({ command: Schema.String, variables: Schema.Array(ToyField) }),
      children: { kind: "yaml", prop: "variables" },
      references: {},
      runbookFiles: () => [],
      provides: ["run"],
      effects: ["process"],
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
  }
}

/** Runs `program` against an engine for a folder that holds `runbook` at `/rb/runbook.mdx`. */
const withEngine = <A, E>(
  runbook: string,
  scripts: Readonly<Record<string, Script>>,
  program: Effect.Effect<A, E, Engine | Caller>,
  origin: Origin = "person",
  database: MemorySessionDatabase = memorySessionDatabase(),
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
      Effect.provide(testSessionStore({ database })),
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

/** A script that notes the values each run gets, unwrapped, and outputs the region it got. */
const recorder = () => {
  const seen: Array<Record<string, FieldValue>> = []
  const script: Script = (input) =>
    Stream.suspend(() => {
      const values = Object.fromEntries(
        Array.from(input.values, ([name, value]) => [name, Redacted.value(value)]),
      )
      seen.push(values)
      const region = values["region"]
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

/** A run that stops only once `stopping` is released, after saying it was asked to. */
const slowToStop =
  (stopping: Hold): Script =>
  () =>
    Stream.fromEffectDrain(
      Effect.never.pipe(
        Effect.onInterrupt(() =>
          Effect.andThen(
            Deferred.succeed(stopping.reached, undefined),
            Deferred.await(stopping.release),
          ),
        ),
      ),
    )

/** A ladder of `length` tasks, each waiting for the two before it, and its last block's id. */
const ladder = (length: number) => {
  const ids = Array.from({ length }, (_, k) => `b${k}`)
  const runbook = ids
    .map((id, k) => {
      const before = ids.slice(Math.max(0, k - 2), k).map((d) => `"${d}"`)
      return `<Run id="${id}" command="ok" dependsOn={[${before.join(", ")}]} />`
    })
    .join("\n\n")
  return { runbook, last: ids[length - 1]! }
}

/**
 * Opens a ladder, trusts it, asks for the session `views` times, as a client
 * does each time it changes, and asks its last block's status: the status,
 * and the time it all took.
 */
const openAndAsk = async (length: number, views = 0) => {
  const { runbook, last } = ladder(length)
  const started = performance.now()
  const status = await withEngine(
    runbook,
    { ok },
    Effect.gen(function* () {
      const rb = yield* commandsFor(yield* open)
      yield* rb.trust
      for (let i = 0; i < views; i++) yield* rb.view
      const lastStatus = yield* rb.status(last)
      yield* rb.close
      return lastStatus
    }),
  )
  return { status, ms: performance.now() - started }
}

/** The median time of three such opens. Each finds the last block waiting. */
const median = async (length: number, views = 0) => {
  const runs = [
    await openAndAsk(length, views),
    await openAndAsk(length, views),
    await openAndAsk(length, views),
  ]
  expect(runs.map(({ status }) => status?._tag)).toEqual(["Blocked", "Blocked", "Blocked"])
  return runs.map(({ ms }) => ms).sort((x, y) => x - y)[1]!
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

  it("forbids an agent to answer an approval, and holds none for a person to answer", async () => {
    const approval = Schema.decodeSync(ApprovalId)("a1")
    const answer = (session: SessionId) =>
      Effect.gen(function* () {
        const engine = yield* Engine
        return yield* Effect.flip(engine.resolveApproval({ session, approval, approve: true }))
      })
    await withEngine(
      '<Run id="a" command="ok" />',
      { ok },
      Effect.gen(function* () {
        const { session } = yield* open
        expect(yield* answer(session)).toMatchObject({ _tag: "UnknownApproval", approval: "a1" })
        expect(yield* answer(Schema.decodeSync(SessionId)("gone"))).toMatchObject({
          _tag: "UnknownSession",
          session: "gone",
        })
        expect(yield* asAgent(answer(session))).toMatchObject({
          _tag: "Forbidden",
          command: "ResolveApproval",
          origin: "agent",
        })
      }),
    )
  })

  it("decides a ladder's statuses in time that grows with its length, not exponentially", async () => {
    // Each block waits for the two before it, and none has run, so each status
    // asks for both of theirs. Undecided twice over, the 30-block ladder takes
    // about 1.5^18 times the 12-block one; decided once, about 2.5 times.
    await openAndAsk(12) // so neither side pays for the first compile
    const short = await median(12)
    const long = await median(30)
    expect(long / short).toBeLessThan(6)
  }, 60_000)

  it("decides each update's statuses, and the session's, once for all its blocks", async () => {
    // One ladder of 800 blocks against 16 of 50: the same blocks, so about the
    // same time when each update decides each block once (1.2 to 1.5 times).
    // Deciding each block's status apart decides the ones it waits for again,
    // and the long ladder takes 5 to 8 times as long. The 16 short opens add
    // up to tens of milliseconds, so a millisecond of jitter barely moves it.
    // Another process on the machine only ever adds time, so the two sides
    // are timed in turn and each is its fastest of three: a slow moment then
    // slows one sample, not one side.
    await openAndAsk(50, 5)
    const sixteen = async () => {
      let ms = 0
      for (let i = 0; i < 16; i++) {
        const short = await openAndAsk(50, 5)
        expect(short.status?._tag).toBe("Blocked")
        ms += short.ms
      }
      return ms
    }
    const shorts: number[] = []
    const longs: number[] = []
    for (let i = 0; i < 3; i++) {
      shorts.push(await sixteen())
      const { status, ms } = await openAndAsk(800, 5)
      expect(status?._tag).toBe("Blocked")
      longs.push(ms)
    }
    expect(Math.min(...longs) / Math.min(...shorts)).toBeLessThan(3)
  }, 60_000)

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

  it("finishes a close cancelled halfway: its event stream ends, and it is forgotten", async () => {
    const stopping = makeHold()
    await withEngine(
      '<Run id="a" command="slow" />',
      // The close waits for the run to stop.
      { slow: slowToStop(stopping) },
      Effect.gen(function* () {
        const engine = yield* Engine
        const rb = yield* commandsFor(yield* open)
        const recording = yield* rb.record
        yield* rb.trust
        yield* rb.run("a")
        const closing = yield* Effect.forkChild(rb.close)
        yield* Deferred.await(stopping.reached)
        const cancelling = yield* Effect.forkChild(Fiber.interrupt(closing), {
          startImmediately: true,
        })
        yield* Deferred.succeed(stopping.release, undefined)
        yield* Fiber.join(cancelling)

        const events = yield* Fiber.join(recording).pipe(Effect.timeout("1 second"))
        expect(events.at(-1)?.event).toEqual({ _tag: "SessionClosed" })
        expect((yield* Effect.flip(rb.close))._tag).toBe("UnknownSession")
        expect(yield* engine.listSessions).toEqual([])
      }),
    )
  })

  it("keeps a session whose close was cancelled before it began, so it can be closed again", async () => {
    const database = memorySessionDatabase()
    const saving = makeHold()
    await withEngine(
      '<Run id="a" command="ok" />',
      { ok },
      Effect.gen(function* () {
        const engine = yield* Engine
        const rb = yield* commandsFor(yield* open)
        yield* rb.trust
        // A RunBlock saving to a slow disk holds the session's lock, so the close waits for it.
        database.holding.set("putEvent", saving)
        const starting = yield* Effect.forkChild(rb.run("a"))
        yield* Deferred.await(saving.reached)
        const closing = yield* Effect.forkChild(rb.close, { startImmediately: true })
        yield* Fiber.interrupt(closing)
        database.holding.delete("putEvent")
        yield* Deferred.succeed(saving.release, undefined)
        yield* Fiber.join(starting)

        expect((yield* engine.listSessions).length).toBe(1)
        yield* rb.close
        expect(yield* engine.listSessions).toEqual([])
      }),
      "person",
      database,
    )
  })

  it("starts a run whose RunBlock was cancelled once it began, or not at all: never a block Running with nothing to run it", async () => {
    const database = memorySessionDatabase()
    const saving = makeHold()
    const status = await withEngine(
      '<Run id="a" command="ok" />',
      { ok },
      Effect.gen(function* () {
        const rb = yield* commandsFor(yield* open)
        yield* rb.trust
        // The run's start is saved on a slow disk, and the RunBlock is cancelled meanwhile.
        database.holding.set("putEvent", saving)
        const starting = yield* Effect.forkChild(rb.run("a"))
        yield* Deferred.await(saving.reached)
        const cancelling = yield* Effect.forkChild(Fiber.interrupt(starting), {
          startImmediately: true,
        })
        database.holding.delete("putEvent")
        yield* Deferred.succeed(saving.release, undefined)
        yield* Fiber.join(cancelling)
        return (yield* rb.wait("a", 1000)).block.status
      }),
      "person",
      database,
    )
    expect(status).toEqual({ _tag: "Done", outcome: "success" })
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

  it("lists its sessions in the order it opened them, a runbook opened again last", async () => {
    await withEngine(
      '<Run id="a" command="emit" />',
      {},
      Effect.gen(function* () {
        const engine = yield* Engine
        const listed = Effect.map(engine.listSessions, (all) => all.map((s) => s.session))
        const first = (yield* open).session
        const second = (yield* open).session
        const third = (yield* open).session
        expect(yield* listed).toEqual([first, second, third])

        yield* engine.closeSession({ session: second })
        const fourth = (yield* open).session
        expect(yield* listed).toEqual([first, third, fourth])
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

  it("cuts a line longer than 16384 characters where it enters the run's log, and says how much it cut", async () => {
    const grin = "😀"
    const long: Script = () =>
      Stream.make(
        { _tag: "Log", stream: "stdout", line: "x".repeat(100_000) },
        { _tag: "Log", stream: "stdout", line: "short" },
        // A run that kept the start of a line and left 500 characters out.
        { _tag: "Log", stream: "stderr", line: "kept", cut: 500 },
        // Characters of two code units, from an even place and from an odd
        // one, so whichever place a cut is at, it splits one of them.
        { _tag: "Log", stream: "stdout", line: grin.repeat(9_000) },
        { _tag: "Log", stream: "stdout", line: `a${grin.repeat(9_000)}` },
        { _tag: "Warning", message: "w".repeat(20_000) },
      )
    await withEngine(
      '<Run id="a" command="long" />',
      { long },
      Effect.gen(function* () {
        const rb = yield* commandsFor(yield* open)
        const recording = yield* rb.record
        yield* rb.trust
        yield* rb.run("a")
        yield* rb.wait("a")
        const lines = (yield* rb.block("a")).log?.lines ?? []
        expect(lines.map((line) => line.stream)).toEqual([
          "stdout",
          "stdout",
          "stderr",
          "stdout",
          "stdout",
          "stderr",
        ])
        expect(lines[1]?.text).toBe("short")
        /** How many characters of `text` are its line's, before the note, and the note. */
        const cutAt = (text: string, of: string) => {
          const kept = text.length - text.replace(new RegExp(`^(?:${of})*`), "").length
          return { kept, note: text.slice(kept) }
        }
        for (const [index, of, length] of [
          [0, "x", 100_000],
          [3, grin, 18_000],
          [4, `a|${grin}`, 18_001],
          [5, "w", 20_000],
        ] as const) {
          const text = lines[index]?.text ?? ""
          expect(text.length).toBeLessThanOrEqual(16_384)
          // Half a character, a lone surrogate, is refused here.
          expect(() => encodeURIComponent(text)).not.toThrow()
          const { kept, note } = cutAt(text, of)
          expect(kept).toBeGreaterThan(16_000)
          expect(note).toContain("cut")
          expect(note).toContain(`${length - kept} characters`)
        }
        expect(lines[2]?.text).toStartWith("kept")
        expect(lines[2]?.text).toContain("cut")
        expect(lines[2]?.text).toContain("500 characters")

        yield* rb.close
        const logged = (yield* Fiber.join(recording)).flatMap(({ event }) =>
          event._tag === "LogLines" ? event.lines : [],
        )
        expect(logged).toEqual([...lines])
      }),
    )
  })

  it("refuses events after a sequence the session has not logged, rather than waiting for it", async () => {
    await withEngine(
      '<Run id="a" command="ok" />',
      { ok },
      Effect.gen(function* () {
        const engine = yield* Engine
        const session = yield* open
        const { session: id } = session
        const rb = yield* commandsFor(session)
        const refusal = (after: number) =>
          Stream.runCollect(engine.events({ session: id, after })).pipe(
            Effect.flip,
            Effect.timeoutOrElse({
              duration: "1 second",
              orElse: () => Effect.die(new Error(`events after ${after} waited`)),
            }),
          )
        const far = yield* refusal(1_000)
        expect(far).toBeInstanceOf(UnknownSequence)
        expect(far).toMatchObject({ session: id, after: 1_000 })
        const { next } = far as UnknownSequence
        // The sequence the session logs next is not one it has logged.
        expect(yield* refusal(next)).toMatchObject({ after: next, next })
        // The last one it logged is.
        const tail = yield* Effect.forkChild(
          Stream.runCollect(engine.events({ session: id, after: next - 1 })),
        )
        yield* rb.close
        const events = yield* Fiber.join(tail)
        expect(events[0]?.sequence).toBe(next)
        expect(events.at(-1)?.event._tag).toBe("SessionClosed")
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

describe("Engine exclusive runs", () => {
  const exclusive = (block: string, runsAlone: "running" | "waiting") =>
    ({ _tag: "Blocked", by: [{ _tag: "Exclusive", block: blockId(block), runsAlone }] }) as const
  const idle = { _tag: "Idle" } as const

  it("holds every task that runs commands while one that runs alone runs, naming it, and lets the others run", async () => {
    const gate = makeGate()
    const runbook = [
      '<Solo id="migrate" command="migrate" />',
      '<Run id="build" command="ok" />',
      '<Solo id="seed" command="ok" />',
      '<Solo id="beside" shell="beside" command="ok" />',
      '<Quiet id="note" command="ok" />',
    ].join("\n\n")
    await withEngine(
      runbook,
      { migrate: gated(gate), ok },
      Effect.gen(function* () {
        const rb = yield* commandsFor(yield* open)
        const recording = yield* rb.record
        yield* rb.trust
        expect((yield* rb.run("migrate"))._tag).toBe("Started")
        yield* Deferred.await(gate.taken)
        expect(yield* rb.status("migrate")).toEqual({ _tag: "Running" })
        for (const held of ["build", "seed", "beside"]) {
          expect(yield* rb.status(held)).toEqual(exclusive("migrate", "running"))
          expect(yield* rb.run(held)).toEqual({
            _tag: "Refused",
            reason: exclusive("migrate", "running"),
          })
        }
        // A task that runs no commands runs beside it.
        expect(yield* rb.status("note")).toEqual(idle)
        expect((yield* rb.run("note"))._tag).toBe("Started")
        yield* rb.wait("note")

        yield* Deferred.succeed(gate.open, undefined)
        yield* rb.wait("migrate")
        for (const freed of ["build", "seed", "beside"])
          expect(yield* rb.status(freed)).toEqual(idle)
        yield* rb.close
        const events = yield* Fiber.join(recording)
        expect(statusesOf(events, "build")).toEqual([
          { _tag: "Blocked", by: [untrusted] },
          idle,
          exclusive("migrate", "running"),
          idle,
        ])
      }),
    )
  })

  it("holds a task that runs alone while tasks that run commands run, naming each, but not while one that runs none does", async () => {
    const build = makeGate()
    const lint = makeGate()
    const note = makeGate()
    const runbook = [
      '<Run id="build" command="build" />',
      '<Run id="lint" command="lint" />',
      '<Solo id="migrate" command="ok" />',
      '<Solo id="beside" shell="beside" command="ok" />',
      '<Quiet id="note" command="note" />',
    ].join("\n\n")
    await withEngine(
      runbook,
      { build: gated(build), lint: gated(lint), note: gated(note), ok },
      Effect.gen(function* () {
        const rb = yield* commandsFor(yield* open)
        yield* rb.trust
        yield* rb.run("build")
        yield* Deferred.await(build.taken)
        expect((yield* rb.run("lint"))._tag).toBe("Started")
        yield* Deferred.await(lint.taken)
        // Each running block that holds it, in the runbook's order.
        const both = {
          _tag: "Blocked",
          by: [
            { _tag: "Exclusive", block: blockId("build"), runsAlone: "waiting" },
            { _tag: "Exclusive", block: blockId("lint"), runsAlone: "waiting" },
          ],
        } as const
        expect(yield* rb.status("migrate")).toEqual(both)
        expect(yield* rb.run("migrate")).toEqual({ _tag: "Refused", reason: both })
        expect(yield* rb.status("beside")).toEqual(idle)

        yield* Deferred.succeed(build.open, undefined)
        yield* rb.wait("build")
        expect(yield* rb.status("migrate")).toEqual(exclusive("lint", "waiting"))
        yield* rb.cancel("lint")
        // A task that runs no commands does not hold it.
        yield* rb.run("note")
        yield* Deferred.await(note.taken)
        expect(yield* rb.status("migrate")).toEqual(idle)
        expect((yield* rb.run("migrate"))._tag).toBe("Started")
        yield* rb.wait("migrate")
        yield* Deferred.succeed(note.open, undefined)
        yield* rb.wait("note")
      }),
    )
  })

  it("holds a done task that runs commands from running again while one that runs alone runs, and offers it no run", async () => {
    const gate = makeGate()
    await withEngine(
      ['<Run id="build" command="ok" />', '<Solo id="migrate" command="migrate" />'].join("\n\n"),
      { migrate: gated(gate), ok },
      Effect.gen(function* () {
        const rb = yield* commandsFor(yield* open)
        yield* rb.trust
        yield* rb.run("build")
        yield* rb.wait("build")
        yield* rb.run("migrate")
        yield* Deferred.await(gate.taken)
        expect(yield* rb.status("build")).toEqual({ _tag: "Done", outcome: "success" })
        expect((yield* rb.block("build")).actions).toEqual(["reset"])
        expect(yield* rb.run("build")).toEqual({
          _tag: "Refused",
          reason: exclusive("migrate", "running"),
        })
        yield* Deferred.succeed(gate.open, undefined)
        yield* rb.wait("migrate")
        expect((yield* rb.block("build")).actions).toEqual(["run", "reset"])
        expect((yield* rb.run("build"))._tag).toBe("Started")
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

  it("shows each field's section, option labels and entry schema, and none for a field without them", async () => {
    const fields = await withEngine(
      withFields('<Form id="config">', [
        "- name: region",
        "  type: enum",
        "  options: [us-east-1, eu-west-1]",
        "  optionLabels: { us-east-1: N. Virginia, eu-west-1: Ireland }",
        "  section: Where",
        "- name: count",
        "  type: int",
        "- name: accounts",
        "  type: map",
        "  schema: { email: string, id: int }",
        "  schemaInstanceLabel: Account name",
      ]),
      {},
      Effect.gen(function* () {
        const rb = yield* commandsFor(yield* open)
        return yield* rb.fields("config")
      }),
    )
    const [region, count, accounts] = fields ?? []
    expect(region?.section).toBe("Where")
    expect(region?.optionLabels).toEqual({ "us-east-1": "N. Virginia", "eu-west-1": "Ireland" })
    expect(count).not.toHaveProperty("section")
    expect(count).not.toHaveProperty("optionLabels")
    expect(accounts?.schema).toEqual({ email: "string", id: "int" })
    expect(accounts?.schemaInstanceLabel).toBe("Account name")
    for (const field of [region, count]) {
      expect(field).not.toHaveProperty("schema")
      expect(field).not.toHaveProperty("schemaInstanceLabel")
    }
  })

  it("shows each field's description as the tree the window walks, parsed as markdown, not MDX", async () => {
    const fields = await withEngine(
      withFields('<Form id="config">', [
        "- name: region",
        "  type: string",
        '  description: "Where to **deploy**, as <b>{region}</b>"',
        "- name: count",
        "  type: int",
      ]),
      {},
      Effect.gen(function* () {
        const rb = yield* commandsFor(yield* open)
        return yield* rb.fields("config")
      }),
    )
    const text = (value: string) => ({ type: "text", value })
    expect(fields?.map((field) => field.description)).toEqual([
      {
        type: "root",
        children: [
          {
            type: "paragraph",
            children: [
              text("Where to "),
              { type: "strong", children: [text("deploy")] },
              text(", as "),
              { type: "html", value: "<b>" },
              text("{region}"),
              { type: "html", value: "</b>" },
            ],
          },
        ],
      },
      { type: "root", children: [] },
    ])
  })

  it("refuses a form whose description nests too deep for the window to draw, naming the field", async () => {
    // Each `>` is a quote; the innermost holds a paragraph, which holds the text.
    const quoted = (quotes: number) => `  description: "${"> ".repeat(quotes)}x"`
    await withEngine(
      withFields('<Form id="config">', [
        "- name: region",
        "  type: string",
        quoted(MAX_NESTING - 1),
        "- name: zone",
        "  type: string",
        quoted(MAX_NESTING - 2),
      ]),
      {},
      Effect.gen(function* () {
        const view = yield* open
        const rb = yield* commandsFor(view)
        const document = yield* (yield* Engine).getDocument({ session: view.session })
        const config = document.blocks[0]
        const errors = config?._tag === "Misconfigured" ? config.errors : []
        expect(errors.map((e) => [e.code, e.location.block?.id, e.message])).toEqual([
          [
            "badProp",
            "config",
            `The description of the field "region" is nested more than ${MAX_NESTING} levels deep. A description may nest its quotes and lists, and the parts inside them, at most ${MAX_NESTING} levels deep.`,
          ],
        ])
        const block = yield* rb.block("config")
        expect(block.status).toEqual({ _tag: "Misconfigured" })
        expect(block).not.toHaveProperty("fields")
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

  it("gives a task the values of a form nested in it after those of its inputsId forms", async () => {
    const { script, seen } = recorder()
    const runbook = [
      CONFIG,
      [
        '<Run id="deploy" command="record" inputsId={["config"]}>',
        withFields('<Form id="nested">', [
          "- name: region",
          "  type: string",
          "  default: eu-west-1",
        ]),
        "</Run>",
      ].join("\n"),
    ].join("\n\n")
    await withEngine(
      runbook,
      { record: script },
      Effect.gen(function* () {
        const rb = yield* commandsFor(yield* open)
        yield* rb.trust
        yield* rb.run("deploy")
        yield* rb.wait("deploy")
        yield* rb.set("nested", { region: "ap-south-1" })
        yield* rb.run("deploy")
        yield* rb.wait("deploy")
        expect(seen).toEqual([
          { region: "eu-west-1", count: 3 },
          { region: "ap-south-1", count: 3 },
        ])
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
        // The form's output carries the field, so it is sensitive as the field is.
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

  it("makes an agent's run whose env reads a form wait for review, as a script that read it did", async () => {
    await withEngine(
      `${CONFIG}\n\n<Run id="deploy" command="ok" inputsId={["config"]} env={{ REGION: "{{ .inputs.region }}" }} />`,
      { ok },
      Effect.gen(function* () {
        const rb = yield* commandsFor(yield* open)
        yield* rb.trust
        expect(yield* asAgent(rb.run("deploy"))).toMatchObject({
          _tag: "Refused",
          reason: { _tag: "NeedsReview", form: "config", unreviewed: ["region", "count"] },
        })
        yield* asAgent(rb.confirm("config"))
        expect((yield* asAgent(rb.run("deploy")))._tag).toBe("Started")
        expect((yield* rb.wait("deploy")).block.status).toEqual({
          _tag: "Done",
          outcome: "success",
        })
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

  /** A script that notes the env each run gets, unwrapped. */
  const envRecorder = () => {
    const envs: Array<Record<string, string>> = []
    const script: Script = (input) =>
      Stream.fromEffectDrain(
        Effect.sync(() =>
          envs.push(
            Object.fromEntries(
              Object.entries(input.env).map(([name, value]) => [name, Redacted.value(value)]),
            ),
          ),
        ),
      )
    return { script, envs }
  }
  const emptyInput = (block: string, input: string) =>
    ({ _tag: "EmptyInput", block: blockId(block), input }) as const

  it("waits for each input its env reads to have a value, an empty field counting as none, unless it has a default (#489)", async () => {
    const { script, envs } = envRecorder()
    const runbook = [
      withFields('<Form id="config">', [
        "- name: id",
        "  type: string",
        "- name: suffix",
        "  type: string",
        '  default: ""',
        "- name: unread",
        "  type: string",
      ]),
      '<Run id="deploy" command="record" inputsId={["config"]} env={{ ID: "{{ .inputs.id }}", SUFFIX: "{{ .inputs.suffix }}" }} />',
    ].join("\n\n")
    await withEngine(
      runbook,
      { record: script },
      Effect.gen(function* () {
        const rb = yield* commandsFor(yield* open)
        yield* rb.trust
        const blocked = { _tag: "Blocked", by: [emptyInput("config", "id")] } as const
        // The form has no errors: an optional field may be empty. Its reader waits for the one it reads.
        expect(yield* rb.status("config")).toEqual({ _tag: "Idle" })
        expect(yield* rb.status("deploy")).toEqual(blocked)
        expect(yield* rb.run("deploy")).toEqual({ _tag: "Refused", reason: blocked })

        yield* rb.set("config", { id: "i-123" })
        expect(yield* rb.status("deploy")).toEqual({ _tag: "Idle" })
        expect((yield* rb.run("deploy"))._tag).toBe("Started")
        yield* rb.wait("deploy")
        expect(envs.map(({ ID, SUFFIX }) => ({ ID, SUFFIX }))).toEqual([
          { ID: "i-123", SUFFIX: "" },
        ])

        // A field cleared is empty again, and its reader can't run again until it has a value.
        yield* rb.set("config", { id: "" })
        expect(yield* rb.status("deploy")).toEqual({ _tag: "Done", outcome: "success" })
        expect(yield* rb.run("deploy")).toEqual({ _tag: "Refused", reason: blocked })
      }),
    )
  })

  it("waits for a map field's key it reads, though the map has a default, but not for a field its form hides, nor twice for a field with an error", async () => {
    const { script, envs } = envRecorder()
    const runbook = [
      withFields('<Form id="config">', [
        "- name: tags",
        "  type: map",
        "  default: {}",
        "- name: method",
        "  type: enum",
        "  options: [email, slack]",
        "  default: email",
        "- name: channel",
        "  type: string",
        "  showWhen: { method: [slack] }",
        "- name: region",
        "  type: string",
        "  required: true",
      ]),
      '<Run id="deploy" command="record" inputsId={["config"]} env={{ ENV: "{{ .inputs.tags.env }}", CHANNEL: "{{ .inputs.channel }}", REGION: "{{ .inputs.region }}" }} />',
    ].join("\n\n")
    await withEngine(
      runbook,
      { record: script },
      Effect.gen(function* () {
        const rb = yield* commandsFor(yield* open)
        yield* rb.trust
        // The empty required field holds it as the form's error, the map's missing key as an empty input.
        expect(yield* rb.status("deploy")).toEqual({
          _tag: "Blocked",
          by: [waitingForValues("config"), emptyInput("config", "tags.env")],
        })
        yield* rb.set("config", { region: "eu-west-1", tags: { team: "infra" } })
        const keyEmpty = { _tag: "Blocked", by: [emptyInput("config", "tags.env")] } as const
        expect(yield* rb.status("deploy")).toEqual(keyEmpty)
        // The map's default lets the map stay empty, not a key it holds.
        yield* rb.set("config", { tags: { env: "" } })
        expect(yield* rb.status("deploy")).toEqual(keyEmpty)
        yield* rb.set("config", { tags: { env: "prod" } })
        expect((yield* rb.run("deploy"))._tag).toBe("Started")
        yield* rb.wait("deploy")
        // `channel` is hidden while the method is email, so it gives its default: empty.
        expect(envs.map(({ ENV, CHANNEL, REGION }) => ({ ENV, CHANNEL, REGION }))).toEqual([
          { ENV: "prod", CHANNEL: "", REGION: "eu-west-1" },
        ])
        yield* rb.set("config", { method: "slack" })
        expect(yield* rb.run("deploy")).toEqual({
          _tag: "Refused",
          reason: { _tag: "Blocked", by: [emptyInput("config", "channel")] },
        })
      }),
    )
  })

  it("waits on the form that gives an input it reads: of those it reads, the last with the field", async () => {
    const { script, envs } = envRecorder()
    const runbook = [
      withFields('<Form id="first">', ["- name: id", "  type: string", "  default: from-first"]),
      withFields('<Form id="second">', ["- name: id", "  type: string"]),
      '<Run id="deploy" command="record" inputsId={["first", "second"]} env={{ ID: "{{ .inputs.id }}" }} />',
    ].join("\n\n")
    await withEngine(
      runbook,
      { record: script },
      Effect.gen(function* () {
        const rb = yield* commandsFor(yield* open)
        yield* rb.trust
        expect(yield* rb.status("deploy")).toEqual({
          _tag: "Blocked",
          by: [emptyInput("second", "id")],
        })
        yield* rb.set("second", { id: "from-second" })
        yield* rb.run("deploy")
        yield* rb.wait("deploy")
        expect(envs.map(({ ID }) => ID)).toEqual(["from-second"])
      }),
    )
  })

  it("waits on an earlier form it reads that has the field, past a later one that has none", async () => {
    const { script, envs } = envRecorder()
    const runbook = [
      withFields('<Form id="first">', ["- name: id", "  type: string"]),
      withFields('<Form id="second">', ["- name: other", "  type: string"]),
      '<Run id="deploy" command="record" inputsId={["first", "second"]} env={{ ID: "{{ .inputs.id }}" }} />',
    ].join("\n\n")
    await withEngine(
      runbook,
      { record: script },
      Effect.gen(function* () {
        const rb = yield* commandsFor(yield* open)
        yield* rb.trust
        expect(yield* rb.status("deploy")).toEqual({
          _tag: "Blocked",
          by: [emptyInput("first", "id")],
        })
        yield* rb.set("first", { id: "from-first" })
        yield* rb.run("deploy")
        yield* rb.wait("deploy")
        expect(envs.map(({ ID }) => ID)).toEqual(["from-first"])
      }),
    )
  })

  it("waits for each input its env reads in its own form, naming itself", async () => {
    const { script, envs } = envRecorder()
    const ask = withFields(
      '<Ask id="ask" command="record" env={{ TARGET: "{{ .inputs.target }}" }}>',
      ["- name: target", "  type: string"],
      "</Ask>",
    )
    await withEngine(
      ask,
      { record: script },
      Effect.gen(function* () {
        const rb = yield* commandsFor(yield* open)
        yield* rb.trust
        expect(yield* rb.status("ask")).toEqual({
          _tag: "Blocked",
          by: [emptyInput("ask", "target")],
        })
        yield* rb.set("ask", { target: "prod" })
        yield* rb.run("ask")
        yield* rb.wait("ask")
        expect(envs.map(({ TARGET }) => TARGET)).toEqual(["prod"])
      }),
    )
  })

  // A title or a description is shown, not given to a run: an empty value in it is empty text.
  it("lets a form whose title reads its own field be submitted with the field empty", async () => {
    const config = withFields('<Form id="config" title="Settings for {{ .inputs.id }}">', [
      "- name: id",
      "  type: string",
    ])
    await withEngine(
      config,
      {},
      Effect.gen(function* () {
        const rb = yield* commandsFor(yield* open)
        yield* rb.trust
        expect(yield* rb.status("config")).toEqual({ _tag: "Idle" })
        expect(yield* rb.run("config")).toEqual({ _tag: "Submitted" })
        expect(yield* rb.status("config")).toEqual({ _tag: "Done", outcome: "success" })
      }),
    )
  })

  it("runs a task whose title and description alone read an empty input", async () => {
    const runbook = [
      withFields('<Form id="config">', ["- name: id", "  type: string"]),
      '<Run id="deploy" command="ok" inputsId="config" title="Deploy {{ .inputs.id }}" description="To {{ .inputs.id }}" />',
    ].join("\n\n")
    await withEngine(
      runbook,
      { ok },
      Effect.gen(function* () {
        const rb = yield* commandsFor(yield* open)
        yield* rb.trust
        expect((yield* rb.run("deploy"))._tag).toBe("Started")
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

  describe("a form's outputs", () => {
    /** A `<Publisher>` with its fields as YAML children and `outputs` as written. */
    const publisher = (id: string, outputs: string, fields: ReadonlyArray<string>) =>
      withFields(`<Publisher id="${id}" outputs={${outputs}}>`, fields, "</Publisher>")

    it("are the fields they name, so DirPicker's PATH is its path, and none while the path is empty", async () => {
      const given: Array<string | undefined> = []
      const ship = "ship {{ .outputs.pick.PATH }}"
      const record: Script = (input) =>
        Stream.fromEffectDrain(
          Effect.sync(() => {
            const path = input.outputs.get(blockId("pick"))?.get("PATH")
            given.push(path === undefined ? undefined : Redacted.value(path))
          }),
        )
      const runbook = [
        publisher("pick", '{ PATH: "path" }', [
          "- name: path",
          "  type: string",
          "  required: true",
        ]),
        `<Run id="ship" command="${ship}" />`,
      ].join("\n\n")
      await withEngine(
        runbook,
        { [ship]: record },
        Effect.gen(function* () {
          const rb = yield* commandsFor(yield* open)
          yield* rb.trust
          yield* rb.set("pick", { path: "dev/region-1" })
          expect(yield* rb.run("pick")).toEqual({ _tag: "Submitted" })
          expect(yield* rb.outputs).toEqual({ pick: { PATH: shown("dev/region-1") } })
          yield* rb.run("ship")
          yield* rb.wait("ship")
          expect(given).toEqual(["dev/region-1"])

          // A cleared path fails the required check: the form is not done, so it gives no output.
          yield* rb.set("pick", { path: "" })
          expect(yield* rb.status("pick")).toEqual({ _tag: "NeedsInput", fields: ["path"] })
          expect(yield* rb.outputs).not.toHaveProperty("pick")
        }),
      )
    })

    it("are sensitive when their field is, so GetOutputs and every event hide them", async () => {
      const secret = "fake-secret-form-output-7c1d"
      await withEngine(
        publisher("vault", '{ TOKEN: "token" }', [
          "- name: token",
          "  type: string",
          "  sensitive: true",
        ]),
        {},
        Effect.gen(function* () {
          const rb = yield* commandsFor(yield* open)
          const recording = yield* rb.record
          yield* rb.trust
          yield* rb.set("vault", { token: secret })
          expect(yield* rb.run("vault")).toEqual({ _tag: "Submitted" })
          expect(yield* rb.outputs).toEqual({ vault: { TOKEN: { _tag: "Hidden" } } })
          yield* rb.close
          const events = yield* Fiber.join(recording)
          const published = events.flatMap(({ event }) =>
            event._tag === "OutputsPublished" ? [event.outputs] : [],
          )
          expect(published).toEqual([{ TOKEN: { _tag: "Hidden" } }])
          expect(JSON.stringify(events)).not.toContain(secret)
        }),
      )
    })

    it("of an empty optional field are the text a task's template reads for it", async () => {
      await withEngine(
        publisher("opt", '{ NOTE: "note", COUNT: "count", TAGS: "tags" }', [
          "- name: note",
          "  type: string",
          "- name: count",
          "  type: int",
          "- name: tags",
          "  type: list",
        ]),
        {},
        Effect.gen(function* () {
          const rb = yield* commandsFor(yield* open)
          yield* rb.trust
          expect(yield* rb.run("opt")).toEqual({ _tag: "Submitted" })
          expect(yield* rb.outputs).toEqual({
            opt: { NOTE: shown(""), COUNT: shown(""), TAGS: shown("[]") },
          })
        }),
      )
    })

    it("of an Iframe-shaped form appear only once the page has set every one", async () => {
      await withEngine(
        '<Embed id="page" outputs={["region", "zone"]} />',
        {},
        Effect.gen(function* () {
          const rb = yield* commandsFor(yield* open)
          yield* rb.trust
          // One required field per output, empty until the window sets it from what the page posts.
          expect((yield* rb.fields("page"))?.map((f) => [f.name, f.required, f.value])).toEqual([
            ["region", true, undefined],
            ["zone", true, undefined],
          ])
          yield* rb.set("page", { region: "eu-west-1" })
          expect(yield* rb.run("page")).toEqual({
            _tag: "Refused",
            reason: { _tag: "NeedsInput", fields: ["zone"] },
          })
          expect(yield* rb.outputs).toEqual({})

          yield* rb.set("page", { zone: "eu-west-1a" })
          expect(yield* rb.run("page")).toEqual({ _tag: "Submitted" })
          expect(yield* rb.outputs).toEqual({
            page: { region: shown("eu-west-1"), zone: shown("eu-west-1a") },
          })

          // A later post replaces what the page set before, and the block stays done.
          yield* rb.set("page", { region: "us-east-1" })
          expect(yield* rb.status("page")).toEqual({ _tag: "Done", outcome: "success" })
          expect((yield* rb.outputs).page?.region).toEqual(shown("us-east-1"))
        }),
      )
    })

    it("that name a field the form does not have make it misconfigured when the session opens, one error each", async () => {
      const runbook = [
        publisher("lost", '{ PATH: "pth", HOME: "home", KEPT: "path" }', [
          "- name: path",
          "  type: string",
          "  default: dev",
        ]),
        '<Run id="read" command="ok" inputsId={["lost"]} />',
      ].join("\n\n")
      await withEngine(
        runbook,
        { ok },
        Effect.gen(function* () {
          const view = yield* open
          const rb = yield* commandsFor(view)
          yield* rb.trust
          const document = yield* (yield* Engine).getDocument({ session: view.session })
          const lost = document.blocks[0]
          const errors = lost?._tag === "Misconfigured" ? lost.errors : []
          expect(errors.map((e) => [e.code, e.location.block?.id, e.suggestion])).toEqual([
            ["badProp", "lost", "path"],
            ["badProp", "lost", undefined],
          ])
          expect(errors[0]?.message).toContain('"PATH"')
          expect(errors[0]?.message).toContain('"pth"')

          const block = yield* rb.block("lost")
          expect([block.status, block.actions, block.outputs]).toEqual([
            { _tag: "Misconfigured" },
            [],
            {},
          ])
          expect(block).not.toHaveProperty("fields")
          expect(yield* rb.run("lost")).toEqual({
            _tag: "Refused",
            reason: { _tag: "Misconfigured" },
          })
          expect(yield* rb.status("read")).toEqual({
            _tag: "Blocked",
            by: [waitingForValues("lost")],
          })
        }),
      )
    })
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
