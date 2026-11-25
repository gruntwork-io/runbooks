/**
 * One open runbook: its document, every block's run, the trust state and the
 * event log. Everything a session holds lives in `makeSession`'s closure and
 * its scope; closing the session closes the scope, which interrupts its runs.
 *
 * A block's status is derived, never set: `statusOf` reads the block's node,
 * its latest run, the trust state and the runs of the blocks it waits for.
 * After every change the session derives every status again and logs a
 * `BlockStatusChanged` for each one that moved.
 *
 * Concurrency: a command that changes a block's run (run, cancel, reset,
 * close) holds the session's lock for its whole length. A run's own events
 * and its end are recorded without the lock, each in one synchronous step.
 */
import path from "node:path"
import type { Duration } from "effect"
import {
  Cause,
  DateTime,
  Effect,
  Exit,
  Option,
  PubSub,
  Redacted,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect"
import type {
  BlockId,
  OutputDecls,
  TaskError,
  TaskEvent,
  TaskInput,
} from "@runbooks/blocks-core/contract"
import { TaskCancelled, TaskFailed } from "@runbooks/blocks-core/contract"
import { type AnyBlock, type Registry, resolveTag } from "@runbooks/blocks-core/registry"
import { type Blocker, BlockStatus, type Outcome } from "@runbooks/blocks-core/status"
import type { BlockNode, ContentHash, RunbookDocument } from "../document/document.ts"
import {
  type BlockAction,
  type BlockSummary,
  type BlockView,
  type EngineEvent,
  type EventEnvelope,
  type LogLine,
  type LogPage,
  LIMITS,
  type OutputView,
  RunId,
  type RunResult,
  type SessionId,
  type SessionSummary,
  type SessionView,
  type TrustResult,
  UnknownBlock,
  UnknownSession,
  WrongClass,
} from "./protocol.ts"

/** Lines of a run's log the session keeps. Older lines are dropped; a log page says where it starts. */
const MAX_RUN_LOG_LINES = 10_000
/** Events the session keeps for `Events` to replay. Older ones are dropped; sequences show the gap. */
const MAX_SESSION_EVENTS = 10_000
/** How often a run's new log lines go out, as one `LogLines` event. */
const LOG_FLUSH_INTERVAL: Duration.Input = "250 millis"

/** The task blocks among `B`. */
type TaskOf<B> = Extract<B, { readonly class: "task" }>

/** Starts a task block's run, with the services every block needs already provided. */
export type StartRun = (
  block: TaskOf<AnyBlock>,
  props: unknown,
  input: TaskInput,
) => Stream.Stream<TaskEvent<string>, TaskError>

// ---------------------------------------------------------------------------
// A bounded list
// ---------------------------------------------------------------------------

/** The last `capacity` items of a list that only grows, each addressed by its place in the whole list. */
interface Window<A> {
  /** The place of the first item kept. */
  readonly start: () => number
  /** How many items the list has had. */
  readonly end: () => number
  readonly push: (items: ReadonlyArray<A>) => void
  /** Kept items from `from` (clamped to `start`) up to `to`. */
  readonly slice: (from: number, to?: number) => ReadonlyArray<A>
}

function makeWindow<A>(capacity: number): Window<A> {
  const items: A[] = []
  let start = 0
  return {
    start: () => start,
    end: () => start + items.length,
    push: (more) => {
      for (const item of more) items.push(item)
      const over = items.length - capacity
      if (over > 0) {
        items.splice(0, over)
        start += over
      }
    },
    slice: (from, to) =>
      items.slice(Math.max(from, start) - start, to === undefined ? undefined : to - start),
  }
}

// ---------------------------------------------------------------------------
// Blocks and runs
// ---------------------------------------------------------------------------

/** A block another one waits for, and the capability it waits on. */
interface Wait {
  readonly target: number
  readonly blocker: Extract<Blocker, { _tag: "WaitingFor" }>
}

/** A task with no configuration errors: what running it needs. */
interface Runnable {
  readonly block: TaskOf<AnyBlock>
  readonly outputs: OutputDecls<string>
}

/** A block a client can address: every block with an id. */
interface Slot {
  readonly index: number
  readonly node: BlockNode
  readonly id: BlockId
  /** The blocks it waits for, from the document's edges, each once. */
  readonly waits: ReadonlyArray<Wait>
  readonly runnable: Option.Option<Runnable>
}

/** An output as the session holds it. A sensitive value stays redacted inside the engine too. */
type HeldOutput =
  | { readonly sensitive: false; readonly value: string }
  | { readonly sensitive: true; readonly value: Redacted.Redacted<string> }

type RunState =
  | {
      readonly _tag: "Running"
      /** Closing it interrupts the run. */
      readonly scope: Scope.Closeable
      /** Held until the run ends well, then published. */
      readonly outputs: Map<string, HeldOutput>
      readonly env: Map<string, Redacted.Redacted<string>>
      warned: boolean
    }
  | {
      readonly _tag: "Done"
      readonly outcome: Outcome
      readonly outputs: ReadonlyMap<string, HeldOutput>
      /** For the per-run environment builder (work product 2.4), which reads a done block's env. */
      readonly env: ReadonlyMap<string, Redacted.Redacted<string>>
    }
  | { readonly _tag: "Failed"; readonly error: TaskError }

/** A block's latest run. A block with none is idle. */
interface Run {
  readonly id: RunId
  readonly slot: Slot
  readonly log: Window<LogLine>
  /** Lines before this place have gone out in a `LogLines` event. */
  flushed: number
  state: RunState
}

const sameStatus = Schema.toEquivalence(BlockStatus)
const decodeRunId = Schema.decodeSync(RunId)

/**
 * What a task reads when it runs. Every field but `cwd` is empty until the
 * work product that fills it lands: `values` with forms, `env` with the
 * per-run environment builder (2.4), `repository` and `gitCredential` with
 * the blocks that provide them. `cwd` becomes a root the engine sets (2.3).
 */
const taskInput = (document: RunbookDocument): TaskInput => ({
  values: {},
  env: {},
  cwd: path.dirname(document.file),
  repository: Option.none(),
  gitCredential: Option.none(),
})

function slotsOf(document: RunbookDocument, registry: Registry): ReadonlyArray<Slot> {
  const ids = new Map<number, BlockId>()
  for (const node of document.blocks) if (node.id !== undefined) ids.set(node.index, node.id)
  return document.blocks.flatMap((node) => {
    if (node.id === undefined) return []
    const waits: Wait[] = []
    for (const edge of document.edges) {
      const target = ids.get(edge.to)
      if (edge.from !== node.index || target === undefined) continue
      // Reading a block's outputs needs it to have run, as `dependsOn` does.
      const capability = edge.source._tag === "Prop" ? edge.source.capability : "run"
      const seen = waits.some(
        (wait) => wait.target === edge.to && wait.blocker.capability === capability,
      )
      if (!seen)
        waits.push({ target: edge.to, blocker: { _tag: "WaitingFor", block: target, capability } })
    }
    return [{ index: node.index, node, id: node.id, waits, runnable: runnableOf(node, registry) }]
  })
}

function runnableOf(node: BlockNode, registry: Registry): Option.Option<Runnable> {
  if (node.class !== "task" || node.errors.length > 0) return Option.none()
  const block: AnyBlock | undefined = resolveTag(registry, node.tag)?.block
  // The parser resolved this tag against the same registry, so it resolves here.
  if (block?.class !== "task") throw new Error(`<${node.tag}> does not resolve to a task block`)
  return Option.some({ block, outputs: block.outputs(node.props) })
}

const outputView = (output: HeldOutput): OutputView =>
  output.sensitive ? { _tag: "Hidden" } : { _tag: "Shown", value: output.value }

const outputsView = (outputs: ReadonlyMap<string, HeldOutput>) =>
  Object.fromEntries(Array.from(outputs, ([key, output]) => [key, outputView(output)]))

/** Why a run ended badly. Interrupting a run cancels it. */
function taskErrorOf(cause: Cause.Cause<TaskError>): TaskError {
  const error = Cause.findErrorOption(cause)
  if (Option.isSome(error)) return error.value
  if (Cause.hasInterruptsOnly(cause)) return new TaskCancelled({})
  const defect = Cause.squash(cause)
  return new TaskFailed({
    message: `The block stopped with an unexpected error: ${defect instanceof Error ? defect.message : String(defect)}`,
  })
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

export interface Session {
  readonly id: SessionId
  readonly summary: () => SessionSummary
  readonly view: () => SessionView
  readonly trust: (hash: ContentHash) => Effect.Effect<TrustResult>
  /** Every event after `after`, then each new one. Ends with `SessionClosed`. */
  readonly events: (after: number | undefined) => Stream.Stream<EventEnvelope>
  readonly getBlock: (
    block: BlockId,
    logOffset: number | undefined,
    logLimit: number | undefined,
  ) => Effect.Effect<BlockView, UnknownBlock>
  readonly runBlock: (
    block: BlockId,
  ) => Effect.Effect<RunResult, UnknownSession | UnknownBlock | WrongClass>
  readonly cancelBlock: (
    block: BlockId,
  ) => Effect.Effect<"cancelled" | "notRunning", UnknownSession | UnknownBlock | WrongClass>
  readonly resetBlock: (
    block: BlockId,
  ) => Effect.Effect<void, UnknownSession | UnknownBlock | WrongClass>
  /** The block once it is not running, or as it is after `timeoutMillis`. */
  readonly waitForBlock: (
    block: BlockId,
    timeoutMillis: number,
    logOffset: number | undefined,
    logLimit: number | undefined,
  ) => Effect.Effect<{ readonly block: BlockView; readonly timedOut: boolean }, UnknownBlock>
  /** Every done block's outputs, by block id. */
  readonly outputs: () => Record<string, Record<string, OutputView>>
  /** Interrupts every run, logs `SessionClosed` and ends every `events` stream. Idempotent. */
  readonly close: Effect.Effect<void>
}

export const makeSession = Effect.fnUntraced(function* (options: {
  readonly id: SessionId
  readonly document: RunbookDocument
  readonly registry: Registry
  readonly start: StartRun
}) {
  const { id, document, start } = options
  const slots = slotsOf(document, options.registry)
  const scope = yield* Scope.make()
  const lock = yield* Semaphore.make(1)
  /** Wakes `events` and `waitForBlock` readers. Each keeps one pending wake at most. */
  const changed = yield* PubSub.sliding<void>(1)

  let trusted = false
  /** Set when closing starts: no command changes the session after it. */
  let closing = false
  /** Set once `SessionClosed` is logged: nothing is logged after it. */
  let closed = false
  const runs = new Map<number, Run>()
  const statuses = new Map<number, BlockStatus>()
  const log = makeWindow<EventEnvelope>(MAX_SESSION_EVENTS)

  const byId = (block: BlockId): Effect.Effect<Slot, UnknownBlock> => {
    const slot = slots.find((candidate) => candidate.id === block)
    return slot === undefined
      ? Effect.fail(new UnknownBlock({ session: id, block }))
      : Effect.succeed(slot)
  }

  const isDone = (index: number) => runs.get(index)?.state._tag === "Done"

  const blockersOf = (slot: Slot): ReadonlyArray<Blocker> => [
    ...(trusted ? [] : [{ _tag: "Untrusted" as const }]),
    ...slot.waits.filter((wait) => !isDone(wait.target)).map((wait) => wait.blocker),
  ]

  /**
   * A block's own run decides its status once it has one. Only an idle block
   * shows what blocks it; `runBlock` still refuses a block that has run while
   * anything blocks it.
   */
  const statusOf = (slot: Slot): BlockStatus | undefined => {
    switch (slot.node.class) {
      case "display":
        return undefined
      case "form":
      case "credential":
      case "task":
        break
    }
    if (slot.node.errors.length > 0) return { _tag: "Misconfigured" }
    const run = runs.get(slot.index)
    if (run !== undefined) {
      switch (run.state._tag) {
        case "Running":
          return { _tag: "Running" }
        case "Done":
          return { _tag: "Done", outcome: run.state.outcome }
        case "Failed":
          return { _tag: "Failed", error: run.state.error }
      }
    }
    const by = blockersOf(slot)
    return by.length > 0 ? { _tag: "Blocked", by } : { _tag: "Idle" }
  }

  const statusChanges = (): ReadonlyArray<EngineEvent> =>
    slots.flatMap((slot) => {
      const status = statusOf(slot)
      const before = statuses.get(slot.index)
      if (status === undefined || (before !== undefined && sameStatus(before, status))) return []
      statuses.set(slot.index, status)
      return [{ _tag: "BlockStatusChanged" as const, block: slot.id, status }]
    })

  /**
   * Applies `change` and logs the events it emits, then a status change for
   * each block whose status moved, all in one synchronous step.
   */
  const update = <A>(change: (emit: (event: EngineEvent) => void) => A): Effect.Effect<A> =>
    Effect.clockWith((clock) =>
      Effect.sync(() => {
        const events: EngineEvent[] = []
        const result = change((event) => events.push(event))
        events.push(...statusChanges())
        if (closed) return { result, logged: false }
        const at = DateTime.makeUnsafe(clock.currentTimeMillisUnsafe())
        const first = log.end()
        log.push(events.map((event, i) => ({ session: id, sequence: first + i, at, event })))
        return { result, logged: events.length > 0 }
      }),
    ).pipe(
      Effect.tap(({ logged }) => (logged ? PubSub.publish(changed, undefined) : Effect.void)),
      Effect.map(({ result }) => result),
    )

  const isCurrent = (run: Run) => runs.get(run.slot.index) === run

  /** Logs the run's lines that have not gone out yet. */
  const flush = (run: Run, emit: (event: EngineEvent) => void) => {
    const offset = Math.max(run.flushed, run.log.start())
    const lines = run.log.slice(offset)
    run.flushed = run.log.end()
    if (lines.length > 0 && isCurrent(run))
      emit({ _tag: "LogLines", block: run.slot.id, run: run.id, offset, lines })
  }

  const record = (run: Run, runnable: Runnable, batch: ReadonlyArray<TaskEvent<string>>) =>
    update((emit) => {
      const state = run.state
      if (state._tag !== "Running") return
      const lines: LogLine[] = []
      const files: Array<{ path: string; change: "created" | "modified" | "deleted" }> = []
      for (const event of batch) {
        switch (event._tag) {
          case "Log":
            lines.push({ stream: event.stream, text: event.line })
            break
          case "Output": {
            const decl = Object.hasOwn(runnable.outputs, event.key)
              ? runnable.outputs[event.key]
              : undefined
            if (decl === undefined)
              lines.push({
                stream: "stderr",
                text: `Output "${event.key}" was dropped: the block does not declare it.`,
              })
            else
              state.outputs.set(
                event.key,
                decl.sensitive
                  ? { sensitive: true, value: Redacted.make(event.value) }
                  : { sensitive: false, value: event.value },
              )
            break
          }
          case "Env":
            state.env.set(event.name, event.value)
            break
          case "File":
            files.push({ path: event.path, change: event.change })
            break
          case "Warning":
            state.warned = true
            lines.push({ stream: "stderr", text: event.message })
            break
        }
      }
      run.log.push(lines)
      if (files.length > 0 && isCurrent(run))
        emit({ _tag: "FilesChanged", block: run.slot.id, files })
    })

  /** Ends a run: publishes its outputs if it ended well, or records why it did not. */
  const finish = (run: Run, exit: Exit.Exit<void, TaskError>) =>
    update((emit) => {
      const state = run.state
      if (state._tag !== "Running") return
      flush(run, emit)
      if (Exit.isSuccess(exit)) {
        run.state = {
          _tag: "Done",
          outcome: state.warned ? "warning" : "success",
          outputs: state.outputs,
          env: state.env,
        }
        if (isCurrent(run))
          emit({
            _tag: "OutputsPublished",
            block: run.slot.id,
            outputs: outputsView(state.outputs),
          })
      } else {
        run.state = { _tag: "Failed", error: taskErrorOf(exit.cause) }
      }
    })

  /** The run itself: its events recorded as they come, its log flushed now and then, its end recorded. */
  const task = (run: Run, runnable: Runnable, runScope: Scope.Closeable) => {
    const flushEvery = Effect.forever(
      Effect.andThen(
        Effect.sleep(LOG_FLUSH_INTERVAL),
        update((emit) => flush(run, emit)),
      ),
    )
    return Effect.gen(function* () {
      yield* Effect.forkChild(flushEvery)
      yield* Stream.runForEachArray(
        start(runnable.block, run.slot.node.props, taskInput(document)),
        (batch) => record(run, runnable, batch),
      )
    }).pipe(
      Effect.onExit((exit) => Effect.andThen(finish(run, exit), Scope.close(runScope, Exit.void))),
    )
  }

  const notClosing = Effect.suspend(() =>
    closing ? Effect.fail(new UnknownSession({ session: id })) : Effect.void,
  )

  const taskSlot = (block: BlockId) =>
    Effect.flatMap(byId(block), (slot) =>
      slot.node.class === "task"
        ? Effect.succeed(slot)
        : Effect.fail(new WrongClass({ block, class: slot.node.class, expected: ["task"] })),
    )

  /** Interrupts the block's run if it is running, and waits until it has ended. */
  const stop = (slot: Slot) => {
    const run = runs.get(slot.index)
    return run?.state._tag === "Running"
      ? Effect.as(Scope.close(run.state.scope, Exit.void), true)
      : Effect.succeed(false)
  }

  const actionsOf = (slot: Slot, status: BlockStatus | undefined): ReadonlyArray<BlockAction> => {
    switch (slot.node.class) {
      case "display":
        return []
      // Their actions arrive with their work products: values for forms, the lifecycle for credentials.
      case "form":
      case "credential":
        return []
      case "task":
        break
    }
    switch (status?._tag) {
      case "Idle":
        return ["run"]
      case "Running":
        return ["cancel", "reset"]
      case "Done":
      case "Failed":
        return blockersOf(slot).length > 0 ? ["reset"] : ["run", "reset"]
      case "Blocked":
      case "NeedsInput":
      case "Misconfigured":
      case undefined:
        return []
    }
  }

  const summaryOf = (slot: Slot): BlockSummary => {
    const status = statusOf(slot)
    const title = slot.node.shared.title
    return {
      block: slot.id,
      tag: slot.node.tag,
      class: slot.node.class,
      ...(title === undefined ? {} : { title }),
      ...(status === undefined ? {} : { status }),
      actions: actionsOf(slot, status),
    }
  }

  const logPage = (run: Run, offset: number, limit: number): LogPage => {
    const from = Math.max(offset, run.log.start())
    return { offset: from, total: run.log.end(), lines: run.log.slice(from, from + limit) }
  }

  const viewOf = (
    slot: Slot,
    logOffset = 0,
    logLimit: number = LIMITS.defaultLogLimit,
  ): BlockView => {
    const run = runs.get(slot.index)
    return {
      ...summaryOf(slot),
      ...(run === undefined ? {} : { log: logPage(run, logOffset, logLimit) }),
      outputs: run?.state._tag === "Done" ? outputsView(run.state.outputs) : {},
    }
  }

  // The runbook's folder, until sessions get names of their own.
  const name = path.basename(path.dirname(document.file))
  const title = document.frontMatter.title

  const session: Session = {
    id,
    summary: () => ({
      session: id,
      name,
      path: document.file,
      ...(title === undefined ? {} : { title }),
      blocks: slots.length,
    }),

    view: () => ({
      session: id,
      name,
      path: document.file,
      ...(title === undefined ? {} : { title }),
      trust: { trusted, hash: document.hash.combined },
      blocks: slots.map(summaryOf),
      warnings: document.warnings,
    }),

    trust: (hash) =>
      update((emit): TrustResult => {
        const current = document.hash.combined
        if (hash !== current) return { _tag: "HashChanged", current }
        if (!trusted) {
          trusted = true
          emit({ _tag: "TrustChanged", trust: { trusted, hash: current } })
        }
        return { _tag: "Trusted" }
      }),

    events: (after) =>
      Stream.unwrap(
        Effect.map(PubSub.subscribe(changed), (wake) =>
          Stream.paginate(after === undefined ? 0 : after + 1, (next: number) => {
            const page = log.slice(next)
            const last = page.at(-1)
            if (last === undefined)
              return Effect.as(PubSub.take(wake), [[], Option.some(next)] as const)
            const more =
              last.event._tag === "SessionClosed" ? Option.none() : Option.some(last.sequence + 1)
            return Effect.succeed([page, more] as const)
          }),
        ),
      ),

    getBlock: (block, logOffset, logLimit) =>
      Effect.map(byId(block), (slot) => viewOf(slot, logOffset, logLimit)),

    runBlock: (block) =>
      lock.withPermit(
        Effect.gen(function* () {
          yield* notClosing
          const slot = yield* taskSlot(block)
          if (Option.isNone(slot.runnable))
            return { _tag: "Refused", reason: { _tag: "Misconfigured" } } as const
          const runnable = slot.runnable.value
          const previous = runs.get(slot.index)
          if (previous?.state._tag === "Running")
            return { _tag: "Refused", reason: { _tag: "AlreadyRunning" } } as const
          const by = blockersOf(slot)
          if (by.length > 0) return { _tag: "Refused", reason: { _tag: "Blocked", by } } as const

          // Approvals are a later work product: an agent's run starts as a person's does.
          const runScope = yield* Scope.fork(scope)
          const run: Run = {
            id: decodeRunId(crypto.randomUUID()),
            slot,
            log: makeWindow(MAX_RUN_LOG_LINES),
            flushed: 0,
            state: {
              _tag: "Running",
              scope: runScope,
              outputs: new Map(),
              env: new Map(),
              warned: false,
            },
          }
          yield* update((emit) => {
            if (previous?.state._tag === "Done") emit({ _tag: "OutputsWithdrawn", block: slot.id })
            runs.set(slot.index, run)
          })
          // Started at once, so a cancel that comes before the run's first step still ends it.
          yield* Effect.forkIn(task(run, runnable, runScope), runScope, { startImmediately: true })
          return { _tag: "Started", run: run.id } as const
        }),
      ),

    cancelBlock: (block) =>
      lock.withPermit(
        Effect.gen(function* () {
          yield* notClosing
          const slot = yield* taskSlot(block)
          return (yield* stop(slot)) ? "cancelled" : "notRunning"
        }),
      ),

    resetBlock: (block) =>
      lock.withPermit(
        Effect.gen(function* () {
          yield* notClosing
          const slot = yield* taskSlot(block)
          yield* stop(slot)
          yield* update((emit) => {
            const run = runs.get(slot.index)
            if (run === undefined) return
            if (run.state._tag === "Done") emit({ _tag: "OutputsWithdrawn", block: slot.id })
            runs.delete(slot.index)
          })
        }),
      ),

    waitForBlock: (block, timeoutMillis, logOffset, logLimit) =>
      Effect.gen(function* () {
        const slot = yield* byId(block)
        const settled = Effect.scoped(
          Effect.gen(function* () {
            const wake = yield* PubSub.subscribe(changed)
            while (runs.get(slot.index)?.state._tag === "Running") yield* PubSub.take(wake)
          }),
        )
        const outcome = yield* Effect.timeoutOption(settled, timeoutMillis)
        return { block: viewOf(slot, logOffset, logLimit), timedOut: Option.isNone(outcome) }
      }),

    outputs: () =>
      Object.fromEntries(
        slots.flatMap((slot) => {
          const run = runs.get(slot.index)
          return run?.state._tag === "Done" ? [[slot.id, outputsView(run.state.outputs)]] : []
        }),
      ),

    close: lock.withPermit(
      Effect.gen(function* () {
        if (closing) return
        closing = true
        yield* Scope.close(scope, Exit.void)
        yield* update((emit) => emit({ _tag: "SessionClosed" }))
        closed = true
      }),
    ),
  }

  // The first statuses, so the log alone tells a client every block's state.
  yield* update(() => undefined)
  return session
})
