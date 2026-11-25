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
 * A form is done while it is submitted and nothing stops it: a change that
 * makes it invalid takes it out of `Done`, and fixing it brings it back, as
 * the app's Inputs keeps a submitted form submitted. Outputs exist exactly
 * while a block is done, so a form's are derived the same way.
 *
 * Concurrency: a command that changes a block's run or values (run, submit,
 * cancel, reset, set or confirm values, close) holds the session's lock for
 * its whole length. A run's own events and its end are recorded without the
 * lock, each in one synchronous step.
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
  PathOutsideRoot,
  PropError,
  RepositoryRef,
  RootedPath,
  Roots,
  RunbookTexts,
  RunEnv,
  TaskError,
  TaskEvent,
  TaskInput,
} from "@runbooks/blocks-core/contract"
import { TaskCancelled, TaskFailed } from "@runbooks/blocks-core/contract"
import type { FieldValue, FormSpec, FormValues } from "@runbooks/blocks-core/form"
import { type AnyBlock, type Registry, resolveTag } from "@runbooks/blocks-core/registry"
import { type Blocker, BlockStatus, type Outcome } from "@runbooks/blocks-core/status"
import { ConfigError, ConfigWarning } from "../document/configError.ts"
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
  outputsOf,
  unreviewedOf,
  valuesOf,
} from "./form.ts"
import {
  type BaseEnvironment,
  buildRunEnv,
  type EnvConflict,
  type EnvSource,
  taskSource,
} from "./env.ts"
import { type Held, hold, reveal, visible } from "./held.ts"
import type { RunRoots } from "./roots.ts"

/** Lines of a run's log the session keeps. Older lines are dropped; a log page says where it starts. */
const MAX_RUN_LOG_LINES = 10_000
/** Events the session keeps for `Events` to replay. Older ones are dropped; sequences show the gap. */
const MAX_SESSION_EVENTS = 10_000
/** How often a run's new log lines go out, as one `LogLines` event. */
const LOG_FLUSH_INTERVAL: Duration.Input = "250 millis"

/** The task blocks among `B`. */
type TaskOf<B> = Extract<B, { readonly class: "task" }>

/**
 * What a session runs its blocks with, every service it needs provided. The
 * engine hands it to a session only when the person trusts it: before that,
 * a session can do no I/O.
 */
export interface Runner {
  /** Starts a task block's run. */
  readonly start: (
    block: TaskOf<AnyBlock>,
    props: unknown,
    input: TaskInput<string>,
  ) => Stream.Stream<TaskEvent<string>, TaskError>
  /** Makes the working folder and resolves each path a run names inside its root (`resolvePaths`). */
  readonly resolve: (
    at: RunRoots,
    named: Readonly<Record<string, RootedPath>>,
    repository: string | undefined,
  ) => Effect.Effect<Record<string, string>, PathOutsideRoot | TaskFailed>
}

/** Whether the person trusts the session. Only a trusted one can run a block. */
type Trust = { readonly _tag: "Untrusted" } | { readonly _tag: "Trusted"; readonly runner: Runner }

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
  /** A form's declared outputs, published while it is done. None for another block. */
  readonly formOutputs: OutputDecls<string>
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
      /** The folder the task makes its repository in, once resolved. */
      repository: Option.Option<string>
    }
  | {
      readonly _tag: "Done"
      readonly outcome: Outcome
      readonly outputs: ReadonlyMap<string, Held<string>>
      /** For the per-run environment builder (work product 2.4), which reads a done block's env. */
      readonly env: ReadonlyMap<string, Redacted.Redacted<string>>
      /** The repository the task made, for a task that names it with `repository`. */
      readonly repository: Option.Option<RepositoryRef>
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
 * own; its environment; the session's roots and the repository it names, and
 * each path it names, resolved. It starts in the repository, or else the
 * working folder. `gitCredential` is empty until the credential lifecycle
 * (2.6) fills it.
 */
const taskInput = (
  at: RunRoots,
  values: FormValues,
  env: RunEnv,
  paths: Readonly<Record<string, string>>,
): TaskInput<string> => ({
  values,
  env,
  cwd: Option.match(at.repository, { onNone: () => at.roots.working, onSome: (ref) => ref.path }),
  roots: at.roots,
  paths,
  repository: at.repository,
  gitCredential: Option.none(),
})

/**
 * Reads each form: a form block's, or a task's own, from its props and the
 * files it names. `fields` gets no services, so this does no I/O, as it
 * happens before trust. A form that cannot be read is a configuration error
 * in its block, which the block's node then holds beside the parser's, so
 * the block is `Misconfigured` like any other.
 */
const readForms = Effect.fnUntraced(function* (
  document: RunbookDocument,
  registry: Registry,
  texts: ReadonlyMap<number, RunbookTexts>,
) {
  const read = yield* Effect.forEach(document.blocks, (node) => {
    const block = node.errors.length > 0 ? undefined : resolveTag(registry, node.tag)?.block
    const fields = block?.class === "form" || block?.class === "task" ? block.fields : undefined
    if (fields === undefined) return Effect.succeed({ node, spec: Option.none<FormSpec>() })
    const files = texts.get(node.index) ?? new Map<string, string>()
    return Effect.match(fields(node.props, files), {
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
      {
        index: node.index,
        node,
        id: node.id,
        waits,
        reads,
        runnable: runnableOf(node, registry),
        formOutputs: formOutputsOf(node, registry),
      },
    ]
  })
}

function formOutputsOf(node: BlockNode, registry: Registry): OutputDecls<string> {
  if (node.class !== "form" || node.errors.length > 0) return {}
  const block: AnyBlock | undefined = resolveTag(registry, node.tag)?.block
  // The parser resolved this tag against the same registry, so it resolves here.
  if (block?.class !== "form") throw new Error(`<${node.tag}> does not resolve to a form block`)
  return block.outputs(node.props)
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

const sameOutputs = (
  a: ReadonlyMap<string, Held<string>>,
  b: ReadonlyMap<string, Held<string>>,
): boolean =>
  a.size === b.size &&
  Array.from(a).every(([key, output]) => {
    const other = b.get(key)
    return other?.sensitive === output.sensitive && reveal(other) === reveal(output)
  })

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
  /** Trusts the session if `hash` is its document's, and takes `runner` to run its blocks with. */
  readonly trust: (hash: ContentHash, runner: Runner) => Effect.Effect<TrustResult>
  /** Every event after `after`, then each new one. Ends with `SessionClosed`. */
  readonly events: (after: number | undefined) => Stream.Stream<EventEnvelope>
  readonly getBlock: (
    block: BlockId,
    logOffset: number | undefined,
    logLimit: number | undefined,
  ) => Effect.Effect<BlockView, UnknownBlock>
  /** Runs a task or submits a form. An agent's also waits until every field it reads is reviewed. */
  readonly runBlock: (
    block: BlockId,
    origin: Origin,
  ) => Effect.Effect<RunResult, UnknownSession | UnknownBlock | WrongClass>
  /** Enters values in a form, or a task's own form, as if typed. */
  readonly setValues: (
    block: BlockId,
    values: Readonly<Record<string, FieldValue>>,
    origin: Origin,
  ) => Effect.Effect<SetValuesResult, UnknownSession | UnknownBlock | WrongClass>
  /** An agent's counts every field the form shows as reviewed; a person's changes nothing. */
  readonly confirmValues: (
    block: BlockId,
    origin: Origin,
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
  /** The text of the files each block names, by block index, as loaded. */
  readonly texts: ReadonlyMap<number, RunbookTexts>
  /** The folders the engine set for the session. */
  readonly roots: Roots
  /** What every run's environment starts from. */
  readonly baseEnvironment: BaseEnvironment
  readonly registry: Registry
}) {
  const { id, roots, baseEnvironment } = options
  const { document, specs } = yield* readForms(options.document, options.registry, options.texts)
  const slots = slotsOf(document, options.registry)
  const scope = yield* Scope.make()
  const lock = yield* Semaphore.make(1)
  /** Wakes `events` and `waitForBlock` readers. Each keeps one pending wake at most. */
  const changed = yield* PubSub.sliding<void>(1)

  let trust: Trust = { _tag: "Untrusted" }
  /** Set when closing starts: no command changes the session after it. */
  let closing = false
  /** Set once `SessionClosed` is logged: nothing is logged after it. */
  let closed = false
  const runs = new Map<number, Run>()
  /** Each block's form, by block index: a form block's, or a task's own. */
  const forms = new Map(Array.from(specs, ([index, spec]) => [index, makeForm(spec)] as const))
  /** The form blocks submitted since they were last reset. */
  const submitted = new Set<number>()
  /** Each done form's outputs, as last published. */
  const published = new Map<number, ReadonlyMap<string, Held<string>>>()
  const statuses = new Map<number, BlockStatus>()
  const log = makeWindow<EventEnvelope>(MAX_SESSION_EVENTS)

  const byId = (block: BlockId): Effect.Effect<Slot, UnknownBlock> => {
    const slot = slots.find((candidate) => candidate.id === block)
    return slot === undefined
      ? Effect.fail(new UnknownBlock({ session: id, block }))
      : Effect.succeed(slot)
  }

  const slotAt = new Map(slots.map((slot) => [slot.index, slot]))
  /** The blocks `isDone` is deciding, so a loop of forms that wait for each other ends. */
  const deciding = new Set<number>()

  /** A form's doneness depends on what it waits for, so it is asked of `statusOf`. */
  const isDone = (index: number): boolean => {
    const slot = slotAt.get(index)
    if (slot === undefined || deciding.has(index)) return false
    deciding.add(index)
    const done = statusOf(slot)?._tag === "Done"
    deciding.delete(index)
    return done
  }

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
    ...(trust._tag === "Trusted" ? [] : [{ _tag: "Untrusted" as const }]),
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

  /** The repository a task names with `repository`, as the task that made it registered it. */
  const repositoryFor = (slot: Slot): Option.Option<RepositoryRef> => {
    const wait = slot.waits.find(({ blocker }) => blocker.capability === "repository")
    const state = wait === undefined ? undefined : runs.get(wait.target)?.state
    return state?._tag === "Done" ? state.repository : Option.none()
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
   * A block's own run decides its status once it has one. Only an idle block,
   * or a submitted form, shows what blocks it or its fields that need input;
   * `runBlock` still refuses a block that has run while either holds.
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
    if (submitted.has(slot.index)) return notReady(slot) ?? { _tag: "Done", outcome: "success" }
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

  /** Publishes a form's outputs as it becomes done or its values change, and withdraws them as it stops being done. */
  const formOutputChanges = (): ReadonlyArray<EngineEvent> =>
    slots.flatMap((slot): ReadonlyArray<EngineEvent> => {
      const form = forms.get(slot.index)
      if (slot.node.class !== "form" || form === undefined) return []
      const before = published.get(slot.index)
      if (statusOf(slot)?._tag !== "Done") {
        if (before === undefined) return []
        published.delete(slot.index)
        return [{ _tag: "OutputsWithdrawn", block: slot.id }]
      }
      const outputs = outputsOf(form, slot.formOutputs)
      if (before !== undefined && sameOutputs(before, outputs)) return []
      published.set(slot.index, outputs)
      return [{ _tag: "OutputsPublished", block: slot.id, outputs: outputsView(outputs) }]
    })

  const statusChanges = (): ReadonlyArray<EngineEvent> =>
    slots.flatMap((slot) => {
      const status = statusOf(slot)
      const before = statuses.get(slot.index)
      if (status === undefined || (before !== undefined && sameStatus(before, status))) return []
      statuses.set(slot.index, status)
      return [{ _tag: "BlockStatusChanged" as const, block: slot.id, status }]
    })

  /**
   * Applies `change` and logs the events it emits, then each form's outputs
   * that moved, then a status change for each block whose status moved, all
   * in one synchronous step.
   */
  const update = <A>(change: (emit: (event: EngineEvent) => void) => A): Effect.Effect<A> =>
    Effect.clockWith((clock) =>
      Effect.sync(() => {
        const events: EngineEvent[] = []
        const result = change((event) => events.push(event))
        events.push(...formOutputChanges(), ...statusChanges())
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

  /** A done block's outputs: its run's, or a form's as last published. */
  const doneOutputs = (slot: Slot): ReadonlyMap<string, Held<string>> | undefined => {
    const run = runs.get(slot.index)
    return run?.state._tag === "Done" ? run.state.outputs : published.get(slot.index)
  }

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
          repository: Option.map(state.repository, (folder) => ({
            block: run.slot.id,
            path: folder,
            remoteUrl: Option.none(),
          })),
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

  /**
   * The `envFrom` sources of a run, in the order written, each read as the
   * run is started: a done task's exports as its latest run left them.
   */
  const envSourcesFor = (slot: Slot): Effect.Effect<ReadonlyArray<EnvSource>> =>
    Effect.forEach(slot.node.shared.envFrom ?? [], (block) => {
      const target = slots.find((candidate) => candidate.id === block)
      const state = target === undefined ? undefined : runs.get(target.index)?.state
      // `notReady` waits for every source to be done, and until the
      // credential lifecycle (2.6) only a task can be.
      return state?._tag === "Done"
        ? Effect.succeed(taskSource(block, state.env))
        : Effect.die(new Error(`The envFrom source ${block} was not done when a run started.`))
    })

  /** A variable two of the block's `envFrom` sources set: the author may not know which wins. */
  const conflictWarning = (slot: Slot, { name, earlier, later }: EnvConflict) =>
    new ConfigWarning({
      code: "envConflict",
      message: `${name} is set by both ${earlier} and ${later} in envFrom. The run gets ${later}'s, the later one.`,
      location: {
        file: document.file,
        span: slot.node.span,
        block: {
          tag: slot.node.tag,
          ...(slot.node.idAsWritten === undefined ? {} : { id: slot.node.idAsWritten }),
        },
        prop: "envFrom",
      },
    })

  /**
   * A process task's environment, with a warning for each variable two of
   * its sources set. Any other task starts no process, so it gets none.
   */
  const runEnv = (run: Run, runnable: Runnable, sources: ReadonlyArray<EnvSource>) =>
    runnable.block.effects.includes("process")
      ? buildRunEnv({
          base: baseEnvironment,
          sources,
          own: run.slot.node.shared.env ?? {},
        }).pipe(
          Effect.tap(({ conflicts }) =>
            conflicts.length === 0
              ? Effect.void
              : update((emit) => {
                  for (const conflict of conflicts)
                    emit({ _tag: "Warning", warning: conflictWarning(run.slot, conflict) })
                }),
          ),
          Effect.map(({ env }) => env),
        )
      : Effect.succeed<RunEnv>({})

  /**
   * The run itself: its environment built and its paths resolved inside
   * their roots, before anything is made or started; then its events
   * recorded as they come, its log flushed now and then, its end recorded.
   */
  const task = (
    run: Run,
    runnable: Runnable,
    runScope: Scope.Closeable,
    at: RunRoots,
    values: FormValues,
    sources: ReadonlyArray<EnvSource>,
    runner: Runner,
  ) => {
    const flushEvery = Effect.forever(
      Effect.andThen(
        Effect.sleep(LOG_FLUSH_INTERVAL),
        update((emit) => flush(run, emit)),
      ),
    )
    const { block } = runnable
    const props = run.slot.node.props
    return Effect.gen(function* () {
      yield* Effect.forkChild(flushEvery)
      const env = yield* runEnv(run, runnable, sources)
      const named = block.paths?.(props, values) ?? {}
      const paths = yield* runner.resolve(at, named, block.repository)
      if (block.repository !== undefined && run.state._tag === "Running")
        run.state.repository = Option.fromUndefinedOr(paths[block.repository])
      yield* Stream.runForEachArray(
        runner.start(block, props, taskInput(at, values, env, paths)),
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

  /** A block that may hold values and be run: a form, or a task, which may have a form of its own. */
  const formOrTaskSlot = (block: BlockId) =>
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

  /** Submits a form, as its button does: it is done from now on while it stays valid. It has no run. */
  const submit = (slot: Slot, origin: Origin) =>
    Effect.gen(function* () {
      if (slot.node.errors.length > 0)
        return { _tag: "Refused", reason: { _tag: "Misconfigured" } } as const
      const reason = notReady(slot) ?? reviewFor(slot, origin)
      if (reason !== undefined) return { _tag: "Refused", reason } as const
      yield* update(() => submitted.add(slot.index))
      return { _tag: "Submitted" } as const
    })

  /** A person's confirm leaves the form as it is: only an agent's review counts. */
  const confirmedBy = (form: Form, origin: Origin): Form => {
    switch (origin) {
      case "agent":
        return confirm(form)
      case "person":
        return form
    }
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
      // "run" submits a form.
      case "form":
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
    const outputs = doneOutputs(slot)
    return {
      ...summaryOf(slot),
      ...(run === undefined ? {} : { log: logPage(run, logOffset, logLimit) }),
      outputs: outputs === undefined ? {} : outputsView(outputs),
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
      trust: { trusted: trust._tag === "Trusted", hash: document.hash.combined },
      blocks: slots.map(summaryOf),
      warnings: document.warnings,
    }),

    trust: (hash, runner) =>
      update((emit): TrustResult => {
        const current = document.hash.combined
        if (hash !== current) return { _tag: "HashChanged", current }
        if (trust._tag === "Untrusted") {
          trust = { _tag: "Trusted", runner }
          emit({ _tag: "TrustChanged", trust: { trusted: true, hash: current } })
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
          const slot = yield* formOrTaskSlot(block)
          if (slot.node.class === "form") return yield* submit(slot, origin)
          if (Option.isNone(slot.runnable))
            return { _tag: "Refused", reason: { _tag: "Misconfigured" } } as const
          const runnable = slot.runnable.value
          const previous = runs.get(slot.index)
          if (previous?.state._tag === "Running")
            return { _tag: "Refused", reason: { _tag: "AlreadyRunning" } } as const
          const reason = notReady(slot) ?? reviewFor(slot, origin)
          if (reason !== undefined) return { _tag: "Refused", reason } as const
          // `notReady` refuses an untrusted session's block, so this holds the runner.
          if (trust._tag === "Untrusted")
            return yield* Effect.die(new Error("A block was ready in an untrusted session."))
          const { runner } = trust

          // Approvals are a later work product: an agent's run starts as a person's does.
          const at: RunRoots = { roots, repository: repositoryFor(slot) }
          const values = valuesFor(slot)
          const sources = yield* envSourcesFor(slot)
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
              repository: Option.none(),
            },
          }
          yield* update((emit) => {
            if (previous?.state._tag === "Done") emit({ _tag: "OutputsWithdrawn", block: slot.id })
            runs.set(slot.index, run)
          })
          // Started at once, so a cancel that comes before the run's first step still ends it.
          yield* Effect.forkIn(
            task(run, runnable, runScope, at, values, sources, runner),
            runScope,
            {
              startImmediately: true,
            },
          )
          return { _tag: "Started", run: run.id } as const
        }),
      ),

    setValues: (block, values, origin) =>
      lock.withPermit(
        Effect.gen(function* () {
          yield* notClosing
          const slot = yield* formOrTaskSlot(block)
          return yield* update((emit): SetValuesResult => {
            const form = forms.get(slot.index)
            if (form === undefined) {
              const reason = noForm(slot)
              const rejected = Object.fromEntries(Object.keys(values).map((key) => [key, reason]))
              return { errors: {}, rejected, unreviewed: [] }
            }
            const entered = enter(form, values, origin)
            changeForm(slot, entered.form, emit)
            return {
              errors: Object.fromEntries(fieldErrors(entered.form)),
              rejected: entered.rejected,
              unreviewed: unreviewedOf(entered.form),
            }
          })
        }),
      ),

    confirmValues: (block, origin) =>
      lock.withPermit(
        Effect.gen(function* () {
          yield* notClosing
          const slot = yield* formOrTaskSlot(block)
          return yield* update((emit) => {
            const form = forms.get(slot.index)
            if (form === undefined) return []
            const confirmed = confirmedBy(form, origin)
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

    // A form keeps its values: only its submit is undone.
    resetBlock: (block) =>
      lock.withPermit(
        Effect.gen(function* () {
          yield* notClosing
          const slot = yield* formOrTaskSlot(block)
          yield* stop(slot)
          yield* update((emit) => {
            submitted.delete(slot.index)
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
          const outputs = doneOutputs(slot)
          return outputs === undefined ? [] : [[slot.id, outputsView(outputs)]]
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
