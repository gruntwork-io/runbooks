/**
 * One open runbook: its document, every block's run, the trust state and the
 * event log. Everything a session holds lives in `makeSession`'s closure and
 * its scope; closing the session closes the scope, which interrupts its runs.
 *
 * A block's status is derived, never set: `statusOf` reads the block's node,
 * its latest run, its form, the trust state and the blocks it waits for.
 * After every change the session derives every status again and logs a
 * `BlockStatusChanged` for each one that moved.
 *
 * Concurrency: a command that changes a block's run or values (run, cancel,
 * reset, set or confirm values, close) holds the session's lock for its whole
 * length. A run's own events and its end are recorded without the lock, each
 * in one synchronous step.
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
  PropError,
  TaskError,
  TaskEvent,
  TaskInput,
} from "@runbooks/blocks-core/contract"
import { TaskCancelled, TaskFailed } from "@runbooks/blocks-core/contract"
import type { FieldValue, FormSpec, FormValues } from "@runbooks/blocks-core/form"
import { type AnyBlock, type Registry, resolveTag } from "@runbooks/blocks-core/registry"
import { type Blocker, BlockStatus, type Outcome } from "@runbooks/blocks-core/status"
import { ConfigError } from "../document/configError.ts"
import type { BlockNode, ContentHash, RunbookDocument } from "../document/document.ts"
import {
  type BlockAction,
  type BlockSummary,
  type BlockView,
  type EngineEvent,
  type EventEnvelope,
  FieldView,
  type LogLine,
  type LogPage,
  LIMITS,
  type Origin,
  type OutputView,
  type Refusal,
  RunId,
  type RunResult,
  type SessionId,
  type SessionSummary,
  type SessionView,
  type SetValuesResult,
  type TrustResult,
  UnknownBlock,
  UnknownSession,
  WrongClass,
} from "./protocol.ts"
import {
  confirm,
  enter,
  fieldErrors,
  fieldViews,
  type Form,
  makeForm,
  unreviewedOf,
  valuesOf,
} from "./form.ts"
import { type Held, hold, visible } from "./held.ts"

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

/** A form block's `fields`, or a task's. */
type ReadsFields = NonNullable<Extract<AnyBlock, { readonly class: "form" | "task" }>["fields"]>

/** Reads a block's form from its props, with the services every block needs already provided. */
export type ReadForm = (fields: ReadsFields, props: unknown) => Effect.Effect<FormSpec, PropError>

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
  /** The blocks whose values it reads (`inputsId`), in the order written, each once. */
  readonly reads: ReadonlyArray<{ readonly index: number; readonly id: BlockId }>
  readonly runnable: Option.Option<Runnable>
}

type RunState =
  | {
      readonly _tag: "Running"
      /** Closing it interrupts the run. */
      readonly scope: Scope.Closeable
      /** Held until the run ends well, then published. */
      readonly outputs: Map<string, Held<string>>
      readonly env: Map<string, Redacted.Redacted<string>>
      warned: boolean
    }
  | {
      readonly _tag: "Done"
      readonly outcome: Outcome
      readonly outputs: ReadonlyMap<string, Held<string>>
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

const sameFields = Schema.toEquivalence(Schema.Array(FieldView))

/**
 * What a task reads when it runs: `values` from the forms it reads, then its
 * own. The rest are empty until the work product that fills them lands: `env`
 * with the per-run environment builder (2.4), `repository` and
 * `gitCredential` with the blocks that provide them. `cwd` becomes a root the
 * engine sets (2.3).
 */
const taskInput = (document: RunbookDocument, values: FormValues): TaskInput => ({
  values,
  env: {},
  cwd: path.dirname(document.file),
  repository: Option.none(),
  gitCredential: Option.none(),
})

/**
 * Reads each form: a form block's, or a task's own. A form that cannot be read
 * is a configuration error in its block, which the block's node then holds
 * beside the parser's, so the block is `Misconfigured` like any other.
 */
const readForms = Effect.fnUntraced(function* (
  document: RunbookDocument,
  registry: Registry,
  readForm: ReadForm,
) {
  const read = yield* Effect.forEach(document.blocks, (node) => {
    const block = node.errors.length > 0 ? undefined : resolveTag(registry, node.tag)?.block
    const fields = block?.class === "form" || block?.class === "task" ? block.fields : undefined
    if (fields === undefined) return Effect.succeed({ node, spec: Option.none<FormSpec>() })
    return Effect.match(readForm(fields, node.props), {
      onSuccess: (spec) => ({ node, spec: Option.some(spec) }),
      onFailure: (error) => ({
        node: { ...node, errors: [...node.errors, formError(document, node, error)] },
        spec: Option.none<FormSpec>(),
      }),
    })
  })
  return {
    document: { ...document, blocks: read.map(({ node }) => node) },
    specs: new Map(
      read.flatMap(({ node, spec }) => (Option.isSome(spec) ? [[node.index, spec.value]] : [])),
    ),
  }
})

const formError = (document: RunbookDocument, node: BlockNode, error: PropError) =>
  new ConfigError({
    code: "badProp",
    message: error.message,
    location: {
      file: document.file,
      span: node.span,
      block: { tag: node.tag, ...(node.idAsWritten === undefined ? {} : { id: node.idAsWritten }) },
      prop: error.prop,
    },
  })

function slotsOf(document: RunbookDocument, registry: Registry): ReadonlyArray<Slot> {
  const ids = new Map<number, BlockId>()
  const indices = new Map<BlockId, number>()
  for (const node of document.blocks) {
    if (node.id === undefined) continue
    ids.set(node.index, node.id)
    indices.set(node.id, node.index)
  }
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
    const reads = Array.from(new Set(node.shared.inputsId)).flatMap((id) => {
      const index = indices.get(id)
      return index === undefined ? [] : [{ index, id }]
    })
    return [
      { index: node.index, node, id: node.id, waits, reads, runnable: runnableOf(node, registry) },
    ]
  })
}

function runnableOf(node: BlockNode, registry: Registry): Option.Option<Runnable> {
  if (node.class !== "task" || node.errors.length > 0) return Option.none()
  const block: AnyBlock | undefined = resolveTag(registry, node.tag)?.block
  // The parser resolved this tag against the same registry, so it resolves here.
  if (block?.class !== "task") throw new Error(`<${node.tag}> does not resolve to a task block`)
  return Option.some({ block, outputs: block.outputs(node.props) })
}

const outputsView = (outputs: ReadonlyMap<string, Held<string>>): Record<string, OutputView> =>
  Object.fromEntries(Array.from(outputs, ([key, output]) => [key, visible(output)]))

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
  /** An agent's run also waits until every field it reads is reviewed. */
  readonly runBlock: (
    block: BlockId,
    origin: Origin,
  ) => Effect.Effect<RunResult, UnknownSession | UnknownBlock | WrongClass>
  /** Enters values in a form, or a task's own form, as if typed. */
  readonly setValues: (
    block: BlockId,
    values: Readonly<Record<string, FieldValue>>,
  ) => Effect.Effect<SetValuesResult, UnknownSession | UnknownBlock | WrongClass>
  /** Counts every field the form shows as reviewed. */
  readonly confirmValues: (
    block: BlockId,
  ) => Effect.Effect<ReadonlyArray<FieldView>, UnknownSession | UnknownBlock | WrongClass>
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
  readonly readForm: ReadForm
}) {
  const { id, start } = options
  const { document, specs } = yield* readForms(options.document, options.registry, options.readForm)
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
  /** Each block's form, by block index: a form block's, or a task's own. */
  const forms = new Map(Array.from(specs, ([index, spec]) => [index, makeForm(spec)] as const))
  const statuses = new Map<number, BlockStatus>()
  const log = makeWindow<EventEnvelope>(MAX_SESSION_EVENTS)

  const byId = (block: BlockId): Effect.Effect<Slot, UnknownBlock> => {
    const slot = slots.find((candidate) => candidate.id === block)
    return slot === undefined
      ? Effect.fail(new UnknownBlock({ session: id, block }))
      : Effect.succeed(slot)
  }

  const isDone = (index: number) => runs.get(index)?.state._tag === "Done"

  /** The fields of the block's form that are empty or invalid. None for a block without a form. */
  const needsInput = (index: number): ReadonlyArray<string> => {
    const form = forms.get(index)
    return form === undefined ? [] : fieldErrors(form).map(([name]) => name)
  }

  /** A block that reads values waits for a form without errors; any other reference, for a done block. */
  const isSatisfied = ({ target, blocker }: Wait): boolean => {
    switch (blocker.capability) {
      case "values":
        return forms.has(target) && needsInput(target).length === 0
      case "run":
      case "env":
      case "git-credential":
      case "repository":
        return isDone(target)
    }
  }

  const blockersOf = (slot: Slot): ReadonlyArray<Blocker> => [
    ...(trusted ? [] : [{ _tag: "Untrusted" as const }]),
    ...slot.waits.filter((wait) => !isSatisfied(wait)).map((wait) => wait.blocker),
  ]

  /** Why the block cannot start now, whoever asks: what blocks it, then its own form. */
  const notReady = (
    slot: Slot,
  ): Extract<BlockStatus, { readonly _tag: "Blocked" | "NeedsInput" }> | undefined => {
    const by = blockersOf(slot)
    if (by.length > 0) return { _tag: "Blocked", by }
    const fields = needsInput(slot.index)
    return fields.length > 0 ? { _tag: "NeedsInput", fields } : undefined
  }

  /**
   * The first form the block reads, then its own, with a field nobody has set
   * or confirmed. A person sees the form in the window, so only an agent's
   * run waits for it.
   */
  const reviewFor = (
    slot: Slot,
    origin: Origin,
  ): Extract<Refusal, { readonly _tag: "NeedsReview" }> | undefined => {
    switch (origin) {
      case "person":
        return undefined
      case "agent":
        break
    }
    for (const { index, id: form } of [...slot.reads, slot]) {
      const held = forms.get(index)
      const [first, ...rest] = held === undefined ? [] : unreviewedOf(held)
      if (held !== undefined && first !== undefined)
        return { _tag: "NeedsReview", form, fields: fieldViews(held), unreviewed: [first, ...rest] }
    }
    return undefined
  }

  /** The values a task runs with: each form it reads, in order, then its own, a later one winning. */
  const valuesFor = (slot: Slot): FormValues =>
    Object.fromEntries(
      [...slot.reads, slot].flatMap(({ index }) => {
        const form = forms.get(index)
        return form === undefined ? [] : Object.entries(valuesOf(form))
      }),
    )

  /**
   * A block's own run decides its status once it has one. Only an idle block
   * shows what blocks it or its fields that need input; `runBlock` still
   * refuses a block that has run while either holds.
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
    return notReady(slot) ?? { _tag: "Idle" }
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
            else state.outputs.set(event.key, hold(decl.sensitive, event.value))
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
  const task = (run: Run, runnable: Runnable, runScope: Scope.Closeable, input: TaskInput) => {
    const flushEvery = Effect.forever(
      Effect.andThen(
        Effect.sleep(LOG_FLUSH_INTERVAL),
        update((emit) => flush(run, emit)),
      ),
    )
    return Effect.gen(function* () {
      yield* Effect.forkChild(flushEvery)
      yield* Stream.runForEachArray(start(runnable.block, run.slot.node.props, input), (batch) =>
        record(run, runnable, batch),
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

  /** A block that may hold values: a form, or a task, which may have a form of its own. */
  const valuesSlot = (block: BlockId) =>
    Effect.flatMap(byId(block), (slot) => {
      switch (slot.node.class) {
        case "form":
        case "task":
          return Effect.succeed(slot)
        case "display":
        case "credential":
          return Effect.fail(
            new WrongClass({ block, class: slot.node.class, expected: ["form", "task"] }),
          )
      }
    })

  /** Why a block holds no form to put a value in. */
  const noForm = (slot: Slot): string =>
    slot.node.errors.length > 0
      ? `The block's configuration has errors, so it holds no values: ${slot.node.errors.map((e) => e.message).join(" ")}`
      : "The block has no form."

  /** Replaces the block's form, and logs its fields if a client would see them change. */
  const changeForm = (slot: Slot, form: Form, emit: (event: EngineEvent) => void) => {
    const before = forms.get(slot.index)
    forms.set(slot.index, form)
    const fields = fieldViews(form)
    if (before === undefined || !sameFields(fieldViews(before), fields))
      emit({ _tag: "FieldsChanged", block: slot.id, fields })
  }

  /** Interrupts the block's run if it is running, and waits until it has ended. */
  const stop = (slot: Slot) => {
    const run = runs.get(slot.index)
    return run?.state._tag === "Running"
      ? Effect.as(Scope.close(run.state.scope, Exit.void), true)
      : Effect.succeed(false)
  }

  const actionsOf = (slot: Slot, status: BlockStatus | undefined): ReadonlyArray<BlockAction> => {
    const values: ReadonlyArray<BlockAction> = forms.has(slot.index)
      ? ["setValues", "confirmValues"]
      : []
    switch (slot.node.class) {
      case "display":
        return []
      // Its actions arrive with the credential lifecycle's work product.
      case "credential":
        return []
      case "form":
        return values
      case "task":
        return [...runActionsOf(slot, status), ...values]
    }
  }

  const runActionsOf = (
    slot: Slot,
    status: BlockStatus | undefined,
  ): ReadonlyArray<BlockAction> => {
    switch (status?._tag) {
      case "Idle":
        return ["run"]
      case "Running":
        return ["cancel", "reset"]
      case "Done":
      case "Failed":
        return notReady(slot) === undefined ? ["run", "reset"] : ["reset"]
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
    const form = forms.get(slot.index)
    return {
      ...summaryOf(slot),
      ...(run === undefined ? {} : { log: logPage(run, logOffset, logLimit) }),
      outputs: run?.state._tag === "Done" ? outputsView(run.state.outputs) : {},
      ...(form === undefined ? {} : { fields: fieldViews(form) }),
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

    runBlock: (block, origin) =>
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
          const reason = notReady(slot) ?? reviewFor(slot, origin)
          if (reason !== undefined) return { _tag: "Refused", reason } as const

          // Approvals are a later work product: an agent's run starts as a person's does.
          const input = taskInput(document, valuesFor(slot))
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
          yield* Effect.forkIn(task(run, runnable, runScope, input), runScope, {
            startImmediately: true,
          })
          return { _tag: "Started", run: run.id } as const
        }),
      ),

    setValues: (block, values) =>
      lock.withPermit(
        Effect.gen(function* () {
          yield* notClosing
          const slot = yield* valuesSlot(block)
          return yield* update((emit): SetValuesResult => {
            const form = forms.get(slot.index)
            if (form === undefined) {
              const reason = noForm(slot)
              const rejected = Object.fromEntries(Object.keys(values).map((key) => [key, reason]))
              return { errors: {}, rejected, unreviewed: [] }
            }
            const entered = enter(form, values)
            changeForm(slot, entered.form, emit)
            return {
              errors: Object.fromEntries(fieldErrors(entered.form)),
              rejected: entered.rejected,
              unreviewed: unreviewedOf(entered.form),
            }
          })
        }),
      ),

    confirmValues: (block) =>
      lock.withPermit(
        Effect.gen(function* () {
          yield* notClosing
          const slot = yield* valuesSlot(block)
          return yield* update((emit) => {
            const form = forms.get(slot.index)
            if (form === undefined) return []
            const confirmed = confirm(form)
            changeForm(slot, confirmed, emit)
            return fieldViews(confirmed)
          })
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

  // The first fields and statuses, so the log alone tells a client every block's state.
  yield* update((emit) => {
    for (const slot of slots) {
      const form = forms.get(slot.index)
      if (form !== undefined)
        emit({ _tag: "FieldsChanged", block: slot.id, fields: fieldViews(form) })
    }
  })
  return session
})
