import { describe, expect, it } from "bun:test"
import { Deferred, Effect, Fiber, Schema, Stream } from "effect"
import {
  BlockId,
  defineTask,
  type TaskError,
  type TaskEvent,
  TaskFailed,
  type TaskInput,
} from "@runbooks/blocks-core/contract"
import type { BlockStatus } from "@runbooks/blocks-core/status"
import { ContentHash } from "../document/document.ts"
import { makeTestFileSystem } from "../test-utils/TestFileSystem.ts"
import { TOY_REGISTRY } from "../test-utils/toyRegistry.ts"
import { Engine } from "./engine.ts"
import { Caller, type EventEnvelope, type Origin, SessionId, type SessionView } from "./protocol.ts"

const RUNBOOK = "/rb/runbook.mdx"
const blockId = Schema.decodeSync(BlockId)

type Script = (input: TaskInput) => Stream.Stream<TaskEvent<string>, TaskError>

/**
 * The toy registry, with `<Run>` running the script its `command` names
 * (nothing, for a command with no script). An output whose key starts with
 * `secret` is sensitive.
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
      Effect.provide(Engine.layer({ registry: registryWith(scripts), appVersion: "0.31.0" })),
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
    await withEngine(
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
      }),
    )
    // Only the good block ran, in the runbook's folder.
    expect(ran).toEqual(["/rb"])
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
      `${form}\n\n<Run id="a" command="ok" />`,
      { ok },
      Effect.gen(function* () {
        const engine = yield* Engine
        const rb = yield* commandsFor(yield* open)
        const nowhere = Schema.decodeSync(SessionId)("no-such-session")
        expect((yield* Effect.flip(engine.getSession({ session: nowhere })))._tag).toBe(
          "UnknownSession",
        )
        expect((yield* Effect.flip(rb.block("b")))._tag).toBe("UnknownBlock")
        expect(yield* Effect.flip(rb.run("config"))).toMatchObject({
          _tag: "WrongClass",
          class: "form",
          expected: ["task"],
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
