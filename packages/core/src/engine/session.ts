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
 * while a block is done, so a form's are derived the same way, and so are a
 * credential block's, from what its provider gave (`./credentials.ts`).
 *
 * Concurrency: a command that changes a block's run or values (run, submit,
 * cancel, reset, set or confirm values, close) holds the session's lock for
 * its whole length. A run's own events and its end are recorded without the
 * lock, each in one synchronous step.
 *
 * Saving: after every change the session saves each block's form, run,
 * submit and credential that changed, and its trust, through its
 * `SessionSaver`, one save at a time. A resumed session starts from what `resumeOf` let it take
 * back, and its first save writes every block as it holds it, so what it
 * did not take back is not offered again.
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
  Result,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect"
import type {
  BlockId,
  BlockOutputs,
  CredentialBlock,
  FormOutputDecls,
  OutputDecls,
  PathOutsideRoot,
  PropError,
  RepositoryRef,
  RootedPath,
  Roots,
  RunbookPath,
  RunbookTexts,
  RunEnv,
  TaskError,
  TaskEvent,
  TaskInput,
  TaskReads,
  TaskValues,
} from "@runbooks/blocks-core/contract"
import { TaskCancelled, TaskFailed } from "@runbooks/blocks-core/contract"
import type { FieldValue, FormSpec } from "@runbooks/blocks-core/form"
import { type AnyBlock, type Registry, resolveTag } from "@runbooks/blocks-core/registry"
import { type Blocker, BlockStatus, type Outcome } from "@runbooks/blocks-core/status"
import { type CredentialAction, statusOf as credentialStatus } from "../credential/lifecycle.ts"
import type { CredentialState } from "../credential/lifecycle.ts"
import type { CredentialEnv } from "../credential/provider.ts"
import { ConfigError, ConfigWarning } from "../document/configError.ts"
import type { BlockNode, ContentHash, ParseResult, RunbookDocument } from "../document/document.ts"
import type { FileFact } from "../document/files.ts"
import { nearest } from "../document/nearest.ts"
import { SHOWN_SHARED_PROPS, startParse } from "../document/parse.ts"
import {
  type ActResult,
  type BlockAction,
  type BlockSummary,
  type BlockView,
  type DocumentBlock,
  type DocumentView,
  type EngineEvent,
  type EventEnvelope,
  FieldView,
  type FilesOnDisk,
  type Instruction,
  type FileChange,
  type LogLine,
  type LogPage,
  LIMITS,
  type Origin,
  type OutputView,
  type Refusal,
  RunId,
  type ScriptFile,
  type ScriptFiles,
  type ReloadFilesResult,
  type ReloadHeld,
  type RunResult,
  type SessionId,
  type SessionSummary,
  type SessionView,
  type SetValuesResult,
  type TrustResult,
  UnknownBlock,
  UnknownSequence,
  UnknownSession,
  type Unwatched,
  WrongClass,
} from "./protocol.ts"
import {
  confirm,
  enter,
  fieldErrors,
  fieldViews,
  type Form,
  inputIn,
  makeForm,
  sectionsOf,
  outputsOf,
  restoreValues,
  savedValuesOf,
  unreviewedOf,
  valuesOf,
} from "./form.ts"
import {
  type CredentialSlot,
  makeCredentials,
  type OpenProvider,
  type ProviderNetwork,
  savedLoginOf,
} from "./credentials.ts"
import { makeCredentialStore } from "./credentialStore.ts"
import {
  type BaseEnvironment,
  buildRunEnv,
  credentialSource,
  type EnvConflict,
  type EnvSource,
  ownEnv,
  taskSource,
  withReserved,
} from "./env.ts"
import { filesOnDiskOf, sameFiles } from "./filesOnDisk.ts"
import { type Held, hold, redacted, reveal, visible } from "./held.ts"
import type { Copied, CopyFailed, RunFiles, RunWrote } from "./runFiles.ts"
import type { RunRoots } from "./roots.ts"
import {
  fileHashesOf,
  type Resume,
  sameRecord,
  type Saved,
  savedLogOf,
  type SavedRun,
  type SessionSaver,
} from "./sessionStore.ts"

/** Lines of a run's log the session keeps. Older lines are dropped; a log page says where it starts. */
const MAX_RUN_LOG_LINES = 10_000

/** What a cut line ends with: how many characters of it were cut. */
const cutNote = (cut: number): string =>
  ` … [Runbooks cut the rest of this line: ${cut} characters]`

/** The characters of its own a cut line keeps, with room for the longest note. */
const CUT_LINE_KEEPS = LIMITS.maxLogLineLength - cutNote(Number.MAX_SAFE_INTEGER).length

/**
 * A line as a run's log holds it, in at most `LIMITS.maxLogLineLength`
 * characters: `text` as it is, or, when it is longer or the run cut it
 * already (`cut` characters left out), its start and a note of how many
 * characters were cut. A start never ends in half a character.
 */
function logLine(stream: LogLine["stream"], text: string, cut = 0): LogLine {
  if (cut === 0 && text.length <= LIMITS.maxLogLineLength) return { stream, text }
  let start = text.slice(0, CUT_LINE_KEEPS)
  const last = start.charCodeAt(start.length - 1)
  // A high surrogate: the other half of its character was cut.
  if (last >= 0xd800 && last <= 0xdbff) start = start.slice(0, -1)
  return { stream, text: start + cutNote(cut + text.length - start.length) }
}
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
  /** Starts a task block's run. What it holds in `scope` is released when the run ends. */
  readonly start: (
    block: TaskOf<AnyBlock>,
    props: unknown,
    input: TaskInput<string>,
    scope: Scope.Scope,
  ) => Stream.Stream<TaskEvent<string>, TaskError>
  /** Makes the working folder and resolves each path a run names inside its root (`resolvePaths`). */
  readonly resolve: (
    at: RunRoots,
    named: Readonly<Record<string, RootedPath>>,
    repository: string | undefined,
  ) => Effect.Effect<Record<string, string>, PathOutsideRoot | TaskFailed>
  /** Makes the files a process task's script writes to, in a folder that goes when the scope closes. */
  readonly makeRunFiles: Effect.Effect<RunFiles, TaskFailed, Scope.Scope>
  /** Reads, within bounds, what the script wrote to them. */
  readonly readRunFiles: (files: RunFiles) => Effect.Effect<RunWrote, TaskFailed>
  /** Copies what the script left in `$GENERATED_FILES` (`from`) into the generated folder (`to`). */
  readonly copyGenerated: (from: string, to: string) => Effect.Effect<Copied, CopyFailed>
  /** Opens a credential block's provider by its registry name, in the scope it is given. */
  readonly openProvider: OpenProvider
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

/** A window whose list has had `start` items already, none of them kept. */
function makeWindow<A>(capacity: number, start = 0): Window<A> {
  const items: A[] = []
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
  /** It runs alone (`TaskBlock.exclusive`). */
  readonly exclusive: boolean
  /** It runs commands: the `process` effect. */
  readonly runsCommands: boolean
}

/** The outputs of one block that another's templates read. */
interface OutputsRead {
  readonly index: number
  readonly id: BlockId
  readonly keys: ReadonlySet<string>
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
  /** The outputs its templates read: each block once, with the keys read. */
  readonly readsOutputs: ReadonlyArray<OutputsRead>
  readonly runnable: Option.Option<Runnable>
  /** A form's declared outputs, published while it is done. None for another block. */
  readonly formOutputs: FormOutputDecls
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
      /** What the run's script wrote to `$RUNBOOK_ENV`, for the blocks that name it in `envFrom`. */
      readonly env: ReadonlyMap<string, Redacted.Redacted<string>>
      /** The repository the task made, for a task that names it with `repository`. */
      readonly repository: Option.Option<RepositoryRef>
    }
  | { readonly _tag: "Failed"; readonly error: TaskError }

type Running = Extract<RunState, { readonly _tag: "Running" }>

/** A block's latest run. A block with none is idle. */
interface Run {
  readonly id: RunId
  /**
   * Its block as it ran. Read only while it runs: a reload waits until no
   * run runs, and moves a run it keeps to its block's new place in `runs`.
   */
  readonly slot: Slot
  readonly log: Window<LogLine>
  /** Lines before this place have gone out in a `LogLines` event. */
  flushed: number
  state: RunState
  /**
   * The files the run touched, by absolute path, each with its latest
   * change, in the order first touched: the first `LIMITS.maxRunFiles`.
   */
  readonly files: Map<string, FileChange["change"]>
  /** Whether the run touched more paths than `files` holds. */
  filesTruncated: boolean
}

const sameStatus = Schema.toEquivalence(BlockStatus)
const decodeRunId = Schema.decodeSync(RunId)

const sameFields = Schema.toEquivalence(Schema.Array(FieldView))

/** A block that names no files. */
const NO_FILES: RunbookTexts = new Map()

/**
 * What a task reads when it runs: what it reads from the session (`reads`);
 * its environment; the session's roots and the repository it names, and
 * each path it names, resolved. It starts in the repository, or else the
 * working folder. `gitCredential` stays empty until the engine resolves the
 * `git-credential` capability from a Ready git credential block.
 */
/** `$REPO_FILES`, for a process task's run: the repository the task names, as today's app gives it. */
const repoFiles = (at: RunRoots): { readonly REPO_FILES?: string } =>
  Option.match(at.repository, { onNone: () => ({}), onSome: (ref) => ({ REPO_FILES: ref.path }) })

const taskInput = (
  at: RunRoots,
  reads: TaskReads,
  env: RunEnv,
  paths: Readonly<Record<string, string>>,
): TaskInput<string> => ({
  ...reads,
  env,
  cwd: Option.match(at.repository, { onNone: () => at.roots.working, onSome: (ref) => ref.path }),
  roots: at.roots,
  paths,
  repository: at.repository,
  gitCredential: Option.none(),
})

/** What the session reads of one block when it opens. */
interface BlockRead {
  /** The block's node, with any error found reading it after the parser's. */
  readonly node: BlockNode
  /** Its form, as it starts: a form block's, or a task's own. */
  readonly form: Option.Option<Form>
  /** Its own props as a client is sent them (`DocumentBlock`). */
  readonly props: Option.Option<Schema.Json>
}

/**
 * Reads what the session needs of each block, from its props and the files
 * it names: its form, a form block's or a task's own, and its props as a
 * client is sent them. `fields` gets no services, so this does no I/O, as it
 * happens before trust. A form that cannot be read, a form block output
 * naming a field its form does not have, or props that cannot be sent, is a
 * configuration error in its block, which the block's node then holds beside
 * the parser's, so the block is `Misconfigured` like any other.
 */
const readBlocks = Effect.fnUntraced(function* (
  document: RunbookDocument,
  registry: Registry,
  texts: ReadonlyMap<number, RunbookTexts>,
) {
  const read = yield* Effect.forEach(document.blocks, (node): Effect.Effect<BlockRead> => {
    const block = node.errors.length > 0 ? undefined : resolveTag(registry, node.tag)?.block
    const none: BlockRead = { node, form: Option.none(), props: Option.none() }
    switch (block?.class) {
      // The parser found errors in it: the block is Misconfigured, and nothing more is read.
      case undefined:
        return Effect.succeed(none)
      // Its props may hold a sign-in field's default, which the engine shows
      // only once the block's provider says the field is not secret.
      case "credential":
        return Effect.succeed(none)
      case "form":
        return Effect.map(
          readForm(document, node, block.fields(node.props, texts.get(node.index) ?? NO_FILES)),
          (formRead) => withOutputFields(document, formRead, block.outputs(node.props)),
        )
      case "task":
        return block.fields === undefined
          ? Effect.succeed(readProps(document, node, block))
          : readForm(document, node, block.fields(node.props, texts.get(node.index) ?? NO_FILES))
      case "display":
        return Effect.succeed(readProps(document, node, block))
    }
  })
  return {
    document: { ...document, blocks: read.map(({ node }) => node) },
    forms: new Map(
      read.flatMap(({ node, form }) => (Option.isSome(form) ? [[node.index, form.value]] : [])),
    ),
    props: new Map(
      read.flatMap(({ node, props }) => (Option.isSome(props) ? [[node.index, props.value]] : [])),
    ),
  }
})

/**
 * A block's form. Its props are not sent: they define the form, and may
 * hold a sensitive field's default. Each reason the form cannot be made
 * (`makeForm`) is a configuration error.
 */
const readForm = (
  document: RunbookDocument,
  node: BlockNode,
  fields: Effect.Effect<FormSpec, PropError>,
): Effect.Effect<BlockRead> =>
  Effect.match(fields, {
    onSuccess: (spec) =>
      Result.match(makeForm(spec), {
        onSuccess: (form) => ({ node, form: Option.some(form), props: Option.none() }),
        onFailure: (problems) => ({
          node: problems
            .map((problem) => openError(document, node, problem))
            .reduce(withError, node),
          form: Option.none(),
          props: Option.none(),
        }),
      }),
    onFailure: (error) => ({
      node: withError(node, openError(document, node, error.message, { prop: error.prop })),
      form: Option.none(),
      props: Option.none(),
    }),
  })

/**
 * A form block's read, refused when an output names a field its form does
 * not have: that output could never be published. One error for each.
 */
function withOutputFields(
  document: RunbookDocument,
  read: BlockRead,
  outputs: FormOutputDecls,
): BlockRead {
  if (Option.isNone(read.form)) return read
  const fields = read.form.value.map(({ field }) => field.name)
  const errors = Object.entries(outputs).flatMap(([output, { field }]) => {
    if (fields.includes(field)) return []
    const suggestion = nearest(field, fields)
    const has = fields.length > 0 ? `Its fields: ${fields.join(", ")}.` : "It has no fields."
    return [
      openError(
        document,
        read.node,
        `The output "${output}" carries the field "${field}", which the form does not have. ${has}`,
        suggestion === undefined ? {} : { suggestion },
      ),
    ]
  })
  if (errors.length === 0) return read
  return { node: errors.reduce(withError, read.node), form: Option.none(), props: Option.none() }
}

/**
 * A block's props, encoded with its own schema, as JSON. A block's schema
 * that cannot encode what it decoded is a bug in the block, not in the
 * runbook; its block does not run, as the window could not show it.
 */
function readProps(document: RunbookDocument, node: BlockNode, block: AnyBlock): BlockRead {
  const encoded = Result.flatMap(Schema.encodeUnknownResult(block.props)(node.props), (props) =>
    Schema.decodeUnknownResult(Schema.Json)(props),
  )
  return Result.match(encoded, {
    onSuccess: (props) => ({ node, form: Option.none(), props: Option.some(props) }),
    onFailure: (error) => ({
      node: withError(
        node,
        openError(
          document,
          node,
          `Runbooks could not send <${node.tag}>'s props to the window (${error.message.replace(/\s+/g, " ")}). This is a bug in Runbooks, not in the runbook.`,
        ),
      ),
      form: Option.none(),
      props: Option.none(),
    }),
  })
}

const withError = (node: BlockNode, error: ConfigError): BlockNode => ({
  ...node,
  errors: [...node.errors, error],
})

/** A configuration error the engine found in a block when the session opened. */
const openError = (
  document: RunbookDocument,
  node: BlockNode,
  message: string,
  { prop, suggestion }: { readonly prop?: string; readonly suggestion?: string } = {},
) =>
  new ConfigError({
    code: "badProp",
    message,
    location: {
      file: document.file,
      span: node.span,
      block: { tag: node.tag, ...(node.idAsWritten === undefined ? {} : { id: node.idAsWritten }) },
      ...(prop === undefined ? {} : { prop }),
    },
    ...(suggestion === undefined ? {} : { suggestion }),
  })

/** The registry block a node's tag resolves to. */
function blockOf(node: BlockNode, registry: Registry): AnyBlock {
  const block: AnyBlock | undefined = resolveTag(registry, node.tag)?.block
  // The parser resolved this tag against the same registry, so it resolves here.
  if (block === undefined) throw new Error(`<${node.tag}> does not resolve to a block`)
  return block
}

/**
 * Whether `node`, which has no configuration errors, is a progress step:
 * `block` is its registry block. A task's own form is not: its task is.
 */
function isStep(node: BlockNode, block: AnyBlock): boolean {
  switch (block.class) {
    case "display":
      return false
    case "credential":
      return true
    case "form":
      return node.nestedIn === undefined && (block.step?.(node.props) ?? true)
    case "task":
      return block.step?.(node.props) ?? true
  }
}

/** A file a task runs as a script, with the text the session holds of it. */
interface HeldScriptFile {
  readonly path: RunbookPath
  readonly text: string
}

/**
 * Each file `node`'s block runs as a script (a `File` its `scripts`
 * gives), in its order, with its text as the session read it (`files`).
 * None for a misconfigured block, which never runs, or a block with none.
 * An inline script is in the block's props, so it is not one. A file
 * whose text the session does not hold, which only a block that breaks
 * its contract names, is left out of the document and of `GetScriptFiles`
 * alike.
 */
function heldScriptFiles(
  node: BlockNode,
  block: AnyBlock,
  files: RunbookTexts,
): ReadonlyArray<HeldScriptFile> {
  if (node.errors.length > 0 || block.class !== "task" || block.scripts === undefined) return []
  return block.scripts(node.props).flatMap((source): ReadonlyArray<HeldScriptFile> => {
    if (source._tag !== "File") return []
    const text = files.get(source.path)
    return text === undefined ? [] : [{ path: source.path, text }]
  })
}

/** What `text`, one of `node`'s scripts, is written in, as its block says (`scriptLanguage`): `text` when it says nothing. */
function scriptLanguageOf(node: BlockNode, block: AnyBlock, text: string): string {
  return (block.class === "task" ? block.scriptLanguage?.(node.props, text) : undefined) ?? "text"
}

/** The session's document as a window renders it, each block's props as `readBlocks` encoded them. */
function documentViewOf(
  document: RunbookDocument,
  props: ReadonlyMap<number, Schema.Json>,
  texts: ReadonlyMap<number, RunbookTexts>,
  registry: Registry,
): DocumentView {
  const { frontMatter } = document
  return {
    hash: document.hash.combined,
    ...(frontMatter.title === undefined ? {} : { title: frontMatter.title }),
    tree: document.tree,
    blocks: document.blocks.map((node): DocumentBlock => {
      const { title, description, autoCollapse } = node.shared
      const placed = {
        index: node.index,
        tag: node.tag,
        block: node.block,
        class: node.class,
        ...(node.id === undefined ? {} : { id: node.id }),
        span: node.span,
        ...(title === undefined ? {} : { title }),
        ...(description === undefined ? {} : { description }),
        ...(autoCollapse === undefined ? {} : { autoCollapse }),
      }
      const [first, ...rest] = node.errors
      if (first !== undefined) return { _tag: "Misconfigured", ...placed, errors: [first, ...rest] }
      const sent = props.get(node.index)
      const block = blockOf(node, registry)
      const scriptFiles = heldScriptFiles(node, block, texts.get(node.index) ?? NO_FILES)
      return {
        _tag: "Configured",
        ...placed,
        step: isStep(node, block),
        ...(node.nestedIn === undefined ? {} : { nestedIn: node.nestedIn }),
        effects: block.effects,
        ...(sent === undefined ? {} : { props: sent }),
        ...(scriptFiles.length === 0 ? {} : { scriptFiles: scriptFiles.map((held) => held.path) }),
      }
    }),
    warnings: document.warnings,
  }
}

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
    const keysRead = new Map<number, Set<string>>()
    for (const { from, to, source } of document.edges) {
      if (from !== node.index || source._tag !== "Output") continue
      keysRead.set(to, (keysRead.get(to) ?? new Set()).add(source.key))
    }
    const readsOutputs = Array.from(keysRead, ([index, keys]) => {
      const id = ids.get(index)
      return id === undefined ? [] : [{ index, id, keys }]
    }).flat()
    return [
      {
        index: node.index,
        node,
        id: node.id,
        waits,
        reads,
        readsOutputs,
        runnable: runnableOf(node, registry),
        formOutputs: formOutputsOf(node, registry),
      },
    ]
  })
}

/** The credential blocks with no configuration errors, and the request each one's props make. */
function credentialSlotsOf(
  slots: ReadonlyArray<Slot>,
  registry: Registry,
): ReadonlyArray<CredentialSlot> {
  return slots.flatMap(({ node, index, id }) => {
    if (node.class !== "credential" || node.errors.length > 0) return []
    const block: AnyBlock | undefined = resolveTag(registry, node.tag)?.block
    // The parser resolved this tag against the same registry, so it resolves here.
    if (block?.class !== "credential")
      throw new Error(`<${node.tag}> does not resolve to a credential block`)
    const credential: CredentialBlock<unknown> = block
    return [
      {
        index,
        id,
        block: credential,
        request: credential.request(node.props),
        outputs: credential.outputs(node.props),
      },
    ]
  })
}

function formOutputsOf(node: BlockNode, registry: Registry): FormOutputDecls {
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
  return Option.some({
    block,
    outputs: block.outputs(node.props),
    exclusive: block.exclusive?.(node.props) ?? false,
    runsCommands: block.effects.includes("process"),
  })
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

/** A submitted form, as it is saved: a submit is the form's run. */
const SUBMITTED: Saved = { kind: "run", payload: { _tag: "Submitted" } }

/** A run as it is saved. Its log is saved from the end. */
function savedRunOf(run: Run): SavedRun {
  const { state, log } = run
  switch (state._tag) {
    case "Running":
      return { _tag: "Running" }
    case "Done":
      return {
        _tag: "Done",
        outcome: state.outcome,
        outputs: Array.from(state.outputs, ([key, output]) => ({
          key,
          value: reveal(output),
          sensitive: output.sensitive,
        })),
        env: Object.fromEntries(
          Array.from(state.env, ([name, value]) => [name, Redacted.value(value)]),
        ),
        repository: Option.match(state.repository, {
          onNone: () => null,
          onSome: (ref) => ({ path: ref.path, remoteUrl: Option.getOrNull(ref.remoteUrl) }),
        }),
        log: savedLogOf(log.slice(log.start()), log.end()),
      }
    case "Failed":
      return {
        _tag: "Failed",
        error: state.error,
        log: savedLogOf(log.slice(log.start()), log.end()),
      }
  }
}

/**
 * A task's run as a resumed session takes it back, under a new id. One the
 * app stopped on before it ended comes back failed. A form's submit and a
 * block that is no runnable task's give none.
 */
function restoredRun(slot: Slot, saved: SavedRun): Run | undefined {
  if (Option.isNone(slot.runnable)) return undefined
  const restore = (
    state: RunState,
    kept: { readonly omitted: number; readonly lines: ReadonlyArray<LogLine> },
  ): Run => {
    const log = makeWindow<LogLine>(MAX_RUN_LOG_LINES, kept.omitted)
    log.push(kept.lines)
    return {
      id: decodeRunId(crypto.randomUUID()),
      slot,
      log,
      flushed: log.start(),
      state,
      files: new Map(),
      filesTruncated: false,
    }
  }
  switch (saved._tag) {
    case "Submitted":
      return undefined
    case "Running":
      return restore(
        {
          _tag: "Failed",
          error: new TaskFailed({ message: "Runbooks stopped before the run ended." }),
        },
        { omitted: 0, lines: [] },
      )
    case "Done":
      return restore(
        {
          _tag: "Done",
          outcome: saved.outcome,
          outputs: new Map(
            saved.outputs.map(({ key, value, sensitive }) => [key, hold(sensitive, value)]),
          ),
          env: new Map(
            Object.entries(saved.env).map(([name, value]) => [name, Redacted.make(value)]),
          ),
          repository: Option.map(
            Option.fromNullOr(saved.repository),
            ({ path: folder, remoteUrl }) => ({
              block: slot.id,
              path: folder,
              remoteUrl: Option.fromNullOr(remoteUrl),
            }),
          ),
        },
        saved.log,
      )
    case "Failed":
      return restore({ _tag: "Failed", error: saved.error }, saved.log)
  }
}

/** A runbook the parser did not refuse: what a session opens, or reloads. */
export type ParsedRunbook = Extract<ParseResult, { readonly _tag: "Parsed" }>

/** What `takeDocument` did. */
export type ReloadResult =
  | { readonly _tag: "Reloaded" }
  /** The runbook is the one the session holds: nothing changed. */
  | { readonly _tag: "Unchanged" }
  | Extract<ReloadHeld, { readonly _tag: "Running" }>

/** What the session's watcher read of its runbook on a save: parsed, refused, or not read. */
export type RunbookRead = ParseResult | { readonly _tag: "Unreadable"; readonly message: string }

/**
 * Where a reload takes the files the runbook names from: as they were read
 * with it (`runbookAndFiles` watch mode), or at the text the session holds,
 * each it holds none of as read (`runbook`).
 */
export type ReloadFilesFrom = "read" | "held"

/** What reloading the session's runbook did, or why the session holds back the one on disk. */
export type RunbookReload = ReloadResult | Exclude<ReloadHeld, { readonly _tag: "Running" }>

/**
 * What a reload compares of a block to keep it (`DocumentChanged`): its
 * registry block, its own props as its schema encodes them, and its shared
 * props but those only shown. None for a block with errors, or whose props
 * do not encode as JSON: a reload never keeps it.
 */
function keepKeyOf(node: BlockNode, registry: Registry): string | undefined {
  if (node.errors.length > 0) return undefined
  const shared = Object.entries(node.shared)
    .filter(([prop]) => !SHOWN_SHARED_PROPS.has(prop))
    .sort(([a], [b]) => (a < b ? -1 : 1))
  const encoded = Result.flatMap(
    Schema.encodeUnknownResult(blockOf(node, registry).props)(node.props),
    (props) => Schema.decodeUnknownResult(Schema.Json)(props),
  )
  return Result.isSuccess(encoded)
    ? JSON.stringify([node.block, encoded.success, shared])
    : undefined
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

export interface Session {
  readonly id: SessionId
  readonly summary: () => SessionSummary
  readonly view: () => SessionView
  /** The document the session holds now, as a window renders it. It changes only as the session reloads. */
  readonly documentView: () => DocumentView
  /** Trusts the session if `hash` is its document's, and takes `runner` to run its blocks with. */
  readonly trust: (hash: ContentHash, runner: Runner) => Effect.Effect<TrustResult>
  /** Every event after `after`, then each new one. Ends with `SessionClosed`. */
  readonly events: (after: number | undefined) => Stream.Stream<EventEnvelope, UnknownSequence>
  readonly getBlock: (
    block: BlockId,
    logOffset: number | undefined,
    logLimit: number | undefined,
  ) => Effect.Effect<BlockView, UnknownBlock>
  /** The text of the files the block runs as scripts, as the session holds them, from the document it holds now. */
  readonly getScriptFiles: (block: BlockId) => Effect.Effect<ScriptFiles, UnknownBlock>
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
  /**
   * Takes the runbook its watcher read, with its files as `files` says, as
   * the session's document, as `DocumentChanged` says. Only the session's
   * watcher calls it, and `reloadFiles` takes files so: a reload keeps
   * trust while the session is open. Only `reloadFiles`, a person's
   * choice, saves it for the new hash, over a document a person trusted or
   * chose. The files read with it count as read from disk, as the
   * watcher's are (`filesChanged`).
   *
   * Unless it takes it, or it is the document the session holds, the
   * session holds the runbook back (`SessionView.reloadHeld`): refused or
   * unread until the next save, or until no block runs, when it takes it
   * without another.
   */
  readonly reload: (
    read: RunbookRead,
    files: ReloadFilesFrom,
  ) => Effect.Effect<RunbookReload, UnknownSession>
  /**
   * What the session's watcher does when files the runbook names change:
   * `facts` is what it read at each path. Each block that names one shows
   * how its files differ from the text the session holds (`filesOnDisk`).
   * A path no block names is not the watcher's, and is left out.
   */
  readonly filesChanged: (
    facts: ReadonlyMap<RunbookPath, FileFact>,
  ) => Effect.Effect<void, UnknownSession>
  /**
   * What the session's watcher does when the system refuses a watch, as it
   * stops: from then on the session watches nothing (`SessionView.unwatched`),
   * and says why once (`Unwatched`).
   */
  readonly unwatched: (message: string) => Effect.Effect<void, UnknownSession>
  /**
   * Takes the files `block` names, at the bytes its `filesOnDisk` shows at
   * `hash`: what `filesChanged` was given, never read again. The session
   * parses the runbook it holds with them, and reloads (`reload`).
   */
  readonly reloadFiles: (
    block: BlockId,
    hash: ContentHash,
  ) => Effect.Effect<ReloadFilesResult, UnknownSession | UnknownBlock>
  /** The block once it is not running, or as it is after `timeoutMillis`. */
  readonly waitForBlock: (
    block: BlockId,
    timeoutMillis: number,
    logOffset: number | undefined,
    logLimit: number | undefined,
  ) => Effect.Effect<{ readonly block: BlockView; readonly timedOut: boolean }, UnknownBlock>
  /** Moves a credential block as a person or agent asks, if its state takes the action. */
  readonly actOnCredential: (
    block: BlockId,
    action: CredentialAction,
  ) => Effect.Effect<ActResult, UnknownSession | UnknownBlock | WrongClass>
  /** Every done block's outputs, by block id. */
  readonly outputs: () => Record<string, Record<string, OutputView>>
  /** Interrupts every run, logs `SessionClosed` and ends every `events` stream. Idempotent. */
  readonly close: Effect.Effect<void>
  /** Whether `close` has begun. Once begun, it ends, however its caller does. */
  readonly closing: () => boolean
}

export const makeSession = Effect.fnUntraced(function* (options: {
  readonly id: SessionId
  /** The runbook, as loaded. */
  readonly runbook: ParsedRunbook
  /** What the session parses its runbook again for, to take files a block names (`reloadFiles`). */
  readonly appVersion: string
  /** The folders the engine set for the session. */
  readonly roots: Roots
  /** What every run's environment starts from. */
  readonly baseEnvironment: BaseEnvironment
  readonly registry: Registry
  /** The session's folder of credential provider state, which the engine set. */
  readonly stateFolder: string
  /** What a credential block's provider runs with, from the names the block declares. */
  readonly providerEnvironment: (envNames: ReadonlyArray<string>) => BaseEnvironment
  /** The CA bundle and proxy the settings hold now: a provider reads them when it opens. */
  readonly network: Effect.Effect<ProviderNetwork>
  /** What the runbook's saved session lets this one take back, when the engine resumes it. */
  readonly resume: Option.Option<Resume>
  /** Where the session saves what it holds. */
  readonly saver: SessionSaver
  /** The sequence of the session's first event: where a resumed session's earlier one ended. */
  readonly firstSequence: number
  /**
   * What watches the runbook and the files it names on disk, given the
   * session and what it holds at each named path now. It runs in the
   * session's scope: closing the session ends it.
   */
  readonly watch?: (
    session: Session,
    files: () => ReadonlyMap<RunbookPath, FileFact>,
  ) => Effect.Effect<void>
}) {
  const { id, roots, baseEnvironment, saver, registry, appVersion } = options
  const resume = Option.getOrUndefined(options.resume)
  const opening = yield* readBlocks(options.runbook.document, registry, options.runbook.texts)
  // What the session holds of its runbook: what it opened, until it reloads (`reload`).
  let document = opening.document
  let texts = options.runbook.texts
  /** The runbook's text, and what was at each path its blocks name, as the session holds them. */
  let source = options.runbook.source
  let heldFiles = options.runbook.files
  /**
   * What the watcher last read at each path the runbook names
   * (`filesChanged`): what a block's `filesOnDisk` shows, and what
   * `reloadFiles` takes, never read again.
   */
  const disk = new Map<RunbookPath, FileFact>()
  /** Each block's `filesOnDisk`, by id, while it has one. */
  const onDisk = new Map<BlockId, FilesOnDisk>()
  /** Why the session holds back the runbook on disk, refused or unread, until a reload takes one. */
  let refused: Exclude<ReloadHeld, { readonly _tag: "Running" }> | undefined
  /** A reload that waits for the blocks running to end: the session takes it once none runs. */
  let pending: { readonly read: ParsedRunbook; readonly files: ReloadFilesFrom } | undefined
  /** `SessionView.reloadHeld`, as last logged. */
  let heldShown: ReloadHeld | undefined
  /** Why the session watches nothing, once its watcher stopped. */
  let unwatched: Unwatched | undefined
  let documentView = documentViewOf(document, opening.props, texts, registry)
  let slots = slotsOf(document, registry)
  const credentialSlots = credentialSlotsOf(slots, registry)
  let credentialSlotAt = new Map(credentialSlots.map((slot) => [slot.index, slot]))
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
  const forms = new Map(opening.forms)
  /** The form blocks submitted since they were last reset. */
  const submitted = new Set<number>()
  /** Each done form's and credential block's outputs, as last published. */
  const published = new Map<number, ReadonlyMap<string, Held<string>>>()
  const statuses = new Map<number, BlockStatus>()
  const log = makeWindow<EventEnvelope>(LIMITS.keptEvents, options.firstSequence)

  for (const slot of slots) {
    const values = resume?.values.get(slot.id)
    const form = forms.get(slot.index)
    if (values !== undefined && form !== undefined)
      forms.set(slot.index, restoreValues(form, values.values))
    const saved = resume?.runs.get(slot.id)
    if (saved === undefined) continue
    if (slot.node.class === "form" && slot.node.errors.length === 0 && saved._tag === "Submitted")
      submitted.add(slot.index)
    const run = slot.node.class === "task" ? restoredRun(slot, saved) : undefined
    if (run !== undefined) runs.set(slot.index, run)
  }

  /**
   * What the session last saved of each block, by block index: it saves
   * only what changed since. Undefined is nothing saved yet; a null run, none.
   */
  const saved = new Map<
    number,
    {
      readonly form: Form | undefined
      readonly submitted: boolean | undefined
      readonly run: RunState | null | undefined
      readonly credential: CredentialState | undefined
      readonly env: CredentialEnv | undefined
    }
  >()
  /**
   * Whether a person trusted the document the session holds
   * (`TrustSession`, or the trust a resumed session gets back), or chose
   * it with `ReloadFiles` over one they had. Only such a document's hash is
   * saved as trusted. A watcher's reload clears it: the person has not read
   * the runbook it took. Set only as trust is, so it implies trust.
   */
  let chosen = false
  /** Whether trust is saved for the document the session holds. */
  let savedTrust = false
  /** The runbook hash the saver records: the one the session opened with, until it reloads. */
  let savedRunbook = document.hash.runbook
  const saving = yield* Semaphore.make(1)
  let fileHashes = fileHashesOf(document, registry)

  /**
   * What saving a credential block in `state` does: a Ready login is saved
   * with the values its provider gave; one signed out, expired or short of
   * a requirement is dropped. Any other state leaves what was saved, so a
   * login not yet checked again, or a provider that is down, keeps it.
   */
  const credentialWrite = (
    slot: CredentialSlot,
    state: CredentialState | undefined,
    env: CredentialEnv | undefined,
    files: Readonly<Record<string, string>>,
  ): Effect.Effect<void> | undefined => {
    switch (state?._tag) {
      case "Ready":
        return env === undefined
          ? undefined
          : saver.put(
              slot.id,
              { kind: "credential", payload: savedLoginOf(slot, state, env) },
              files,
            )
      case "SignedOut":
      case "Expired":
      case "RequirementNotMet":
        return saver.drop(slot.id, "credential")
      case undefined:
      case "Detecting":
      case "Found":
      case "SigningIn":
      case "ChoosingTarget":
      case "Unavailable":
        return undefined
    }
  }

  /**
   * Saves the trust, and each block's form, submit, run and credential,
   * that changed since the last save. It runs to its end, so what it marks
   * saved is.
   */
  const persist: Effect.Effect<void> = Effect.uninterruptible(
    saving.withPermit(
      Effect.suspend(() => {
        const writes: Array<Effect.Effect<void>> = []
        // First, so each state saved after a reload records the runbook it was saved against.
        if (savedRunbook !== document.hash.runbook) {
          savedRunbook = document.hash.runbook
          writes.push(saver.runbookChanged(savedRunbook))
        }
        if (chosen && !savedTrust) {
          savedTrust = true
          writes.push(saver.trust(document.hash.combined))
        }
        for (const slot of slots) {
          const last = saved.get(slot.index) ?? {
            form: undefined,
            submitted: undefined,
            run: undefined,
            credential: undefined,
            env: undefined,
          }
          const files = fileHashes.get(slot.id) ?? {}
          const form = forms.get(slot.index)
          const formChanged = form !== undefined && form !== last.form
          if (formChanged)
            writes.push(
              saver.put(
                slot.id,
                { kind: "values", payload: { values: savedValuesOf(form) } },
                files,
              ),
            )
          const isSubmitted = submitted.has(slot.index)
          const submitChanged = slot.node.class === "form" && isSubmitted !== last.submitted
          if (submitChanged)
            writes.push(
              isSubmitted ? saver.put(slot.id, SUBMITTED, files) : saver.drop(slot.id, "run"),
            )
          const run = runs.get(slot.index)
          const state = run?.state ?? null
          const runChanged = slot.node.class === "task" && state !== last.run
          if (runChanged)
            writes.push(
              run === undefined
                ? saver.drop(slot.id, "run")
                : saver.put(slot.id, { kind: "run", payload: savedRunOf(run) }, files),
            )
          const credential = credentialSlotAt.get(slot.index)
          const login = credential === undefined ? undefined : credentials.stateOf(slot.index)
          const env = store.get(slot.id)
          const loginChanged = login !== last.credential || env !== last.env
          const loginWrite =
            credential !== undefined && loginChanged
              ? credentialWrite(credential, login, env, files)
              : undefined
          if (loginWrite !== undefined) writes.push(loginWrite)
          if (formChanged || submitChanged || runChanged || loginChanged)
            saved.set(slot.index, {
              form,
              submitted: isSubmitted,
              run: state,
              credential: login,
              env,
            })
        }
        return Effect.all(writes, { discard: true })
      }),
    ),
  )

  const byId = (block: BlockId): Effect.Effect<Slot, UnknownBlock> => {
    const slot = slots.find((candidate) => candidate.id === block)
    return slot === undefined
      ? Effect.fail(new UnknownBlock({ session: id, block }))
      : Effect.succeed(slot)
  }

  let slotAt = new Map(slots.map((slot) => [slot.index, slot]))
  /** The blocks `isDone` is deciding, so a loop of forms that wait for each other ends. */
  const deciding = new Set<number>()

  /**
   * The statuses decided so far in the current synchronous pass. A block's
   * status asks for the status of each block it waits for, so without them a
   * ladder of blocks that each wait for the two before costs about 1.5 times
   * more per block. Nothing a status reads changes within a pass.
   */
  let passStatuses: Map<number, BlockStatus | undefined> | undefined

  /** Runs `work` in the current pass, or in a new one that ends with it. */
  const inOnePass = <A>(work: (decided: Map<number, BlockStatus | undefined>) => A): A => {
    if (passStatuses !== undefined) return work(passStatuses)
    const decided = new Map<number, BlockStatus | undefined>()
    passStatuses = decided
    try {
      return work(decided)
    } finally {
      passStatuses = undefined
    }
  }

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

  /**
   * Each input the block's templates read that has no value yet (`inputIn`),
   * with the form it waits on: of the forms it reads, in order, then its
   * own, the last with the field, as for its values. An input that no form
   * it reads has holds nothing: its run fails, naming it.
   */
  const emptyInputsOf = (slot: Slot): ReadonlyArray<Blocker> => {
    const lastFirst = [...slot.reads, slot].reverse().flatMap((read) => {
      const form = forms.get(read.index)
      return form === undefined ? [] : [{ block: read.id, form }]
    })
    return slot.node.inputs.flatMap((input) => {
      for (const { block, form } of lastFirst) {
        switch (inputIn(form, input)) {
          case "absent":
            continue
          case "empty":
            return [{ _tag: "EmptyInput" as const, block, input }]
          case "ready":
            return []
        }
      }
      return []
    })
  }

  /**
   * Each running task this task may not run beside, in the runbook's order:
   * one of the two runs alone and the other runs commands. None for a block
   * that is no task. A running task is refused a run before this is asked
   * (`AlreadyRunning`), so it never meets its own run here.
   */
  const exclusiveOf = (slot: Slot): ReadonlyArray<Blocker> => {
    if (Option.isNone(slot.runnable)) return []
    const self = slot.runnable.value
    return Array.from(runs.values())
      .filter((run) => run.state._tag === "Running")
      .sort((a, b) => a.slot.index - b.slot.index)
      .flatMap((run) => {
        if (Option.isNone(run.slot.runnable)) return []
        const running = run.slot.runnable.value
        const runsAlone =
          running.exclusive && self.runsCommands
            ? ("running" as const)
            : self.exclusive && running.runsCommands
              ? ("waiting" as const)
              : undefined
        return runsAlone === undefined
          ? []
          : [{ _tag: "Exclusive" as const, block: run.slot.id, runsAlone }]
      })
  }

  const blockersOf = (slot: Slot): ReadonlyArray<Blocker> => [
    ...(trust._tag === "Trusted" ? [] : [{ _tag: "Untrusted" as const }]),
    ...slot.waits.filter((wait) => !isSatisfied(wait)).map((wait) => wait.blocker),
    ...emptyInputsOf(slot),
    ...exclusiveOf(slot),
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
  const valuesFor = (slot: Slot): TaskValues =>
    new Map(
      [...slot.reads, slot].flatMap(({ index }) => {
        const form = forms.get(index)
        return form === undefined ? [] : Array.from(valuesOf(form))
      }),
    )

  /**
   * What a task reads from the session: its values, each output its
   * templates name as its block last published it, and the files it names
   * as they were hashed when the runbook opened. An output its block has
   * not published is left out.
   */
  const readsFor = (slot: Slot): TaskReads => {
    const outputs: BlockOutputs = new Map(
      slot.readsOutputs.map((read) => {
        const target = slotAt.get(read.index)
        const given = target === undefined ? undefined : doneOutputs(target)
        const named = Array.from(given ?? []).filter(([key]) => read.keys.has(key))
        return [read.id, new Map(named.map(([key, value]) => [key, redacted(value)]))] as const
      }),
    )
    return { values: valuesFor(slot), outputs, files: texts.get(slot.index) ?? NO_FILES }
  }

  /**
   * A block's own run decides its status once it has one. Only an idle block,
   * or a submitted form, shows what blocks it or its fields that need input;
   * `runBlock` still refuses a block that has run while either holds.
   */
  const statusOf = (slot: Slot): BlockStatus | undefined =>
    inOnePass((decided) => {
      if (decided.has(slot.index)) return decided.get(slot.index)
      const status = decideStatus(slot)
      decided.set(slot.index, status)
      return status
    })

  const decideStatus = (slot: Slot): BlockStatus | undefined => {
    switch (slot.node.class) {
      case "display":
        return undefined
      case "credential":
        return credentialStatusOf(slot)
      case "form":
      case "task":
        break
    }
    if (slot.node.errors.length > 0) return { _tag: "Misconfigured" }
    // A task's own form has no Submit: it counts as submitted, as today's app has it.
    if (submitted.has(slot.index) || slot.node.nestedIn !== undefined)
      return notReady(slot) ?? { _tag: "Done", outcome: "success" }
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

  /**
   * A credential block's lifecycle decides its status once it has started,
   * which it does once nothing blocks it.
   */
  const credentialStatusOf = (slot: Slot): BlockStatus => {
    if (slot.node.errors.length > 0) return { _tag: "Misconfigured" }
    const by = blockersOf(slot)
    if (by.length > 0) return { _tag: "Blocked", by }
    const state = credentials.stateOf(slot.index)
    return state === undefined ? { _tag: "Idle" } : credentialStatus(state)
  }

  /** What a done form or credential block publishes: a form's from its values, a credential's from its provider. */
  const derivedOutputs = (slot: Slot): ReadonlyMap<string, Held<string>> | undefined => {
    switch (slot.node.class) {
      case "form": {
        const form = forms.get(slot.index)
        return form === undefined ? undefined : outputsOf(form, slot.formOutputs)
      }
      case "credential":
        return credentialSlotAt.has(slot.index) ? credentials.outputs(slot.index) : undefined
      case "display":
      case "task":
        return undefined
    }
  }

  /**
   * Publishes a form's or credential block's outputs as it becomes done or
   * they change, and withdraws them as it stops being done.
   */
  const derivedOutputChanges = (): ReadonlyArray<EngineEvent> =>
    slots.flatMap((slot): ReadonlyArray<EngineEvent> => {
      const before = published.get(slot.index)
      const outputs = statusOf(slot)?._tag === "Done" ? derivedOutputs(slot) : undefined
      if (outputs === undefined) {
        if (before === undefined) return []
        published.delete(slot.index)
        return [{ _tag: "OutputsWithdrawn", block: slot.id }]
      }
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

  /** The blocks running now, as a reload counts them. */
  const runningIds = (): ReadonlyArray<BlockId> =>
    inOnePass(() =>
      // Approvals are a later work product: a block awaiting one will count as running.
      slots.filter((slot) => statusOf(slot)?._tag === "Running").map((slot) => slot.id),
    )

  /**
   * Why the session holds back the runbook on disk now: refused, unread, or
   * waiting for the blocks running. Once the last ends, it names those it
   * waited for until the session takes the reload.
   */
  const heldNow = (): ReloadHeld | undefined => {
    if (refused !== undefined) return refused
    if (pending === undefined) return undefined
    const [first, ...rest] = runningIds()
    return first === undefined ? heldShown : { _tag: "Running", blocks: [first, ...rest] }
  }

  const sameHeld = (a: ReloadHeld | undefined, b: ReloadHeld | undefined): boolean =>
    a?._tag === "Running" && b?._tag === "Running" ? a.blocks.join() === b.blocks.join() : a === b

  /** `ReloadHeldChanged`, when why the session holds back a reload moved. */
  const heldChanges = (): ReadonlyArray<EngineEvent> => {
    const now = heldNow()
    if (sameHeld(now, heldShown)) return []
    heldShown = now
    return [
      now === undefined ? { _tag: "ReloadHeldChanged" } : { _tag: "ReloadHeldChanged", held: now },
    ]
  }

  /**
   * Set while a reload stops the credential blocks it starts over: none
   * starts until their providers are closed, as each one's state folder is
   * the one its block had.
   */
  let reloading = false

  /** A credential block may start its lifecycle: the session is trusted and nothing blocks it. */
  const startable = (index: number): boolean => {
    const slot = slotAt.get(index)
    return !closing && !reloading && slot !== undefined && blockersOf(slot).length === 0
  }

  /**
   * Applies `change` and logs the events it emits; starts the lifecycle of
   * each credential block that nothing blocks now; then logs each form's
   * and credential block's outputs that moved, and a status change for each
   * block whose status moved, all in one synchronous step. Then it opens the
   * started blocks' providers.
   */
  const update = <A>(change: (emit: (event: EngineEvent) => void) => A): Effect.Effect<A> =>
    Effect.clockWith((clock) =>
      Effect.sync(() => {
        const events: EngineEvent[] = []
        const emit = (event: EngineEvent) => events.push(event)
        const result = change(emit)
        const started = credentials.enter(startable, emit)
        events.push(
          ...inOnePass(() => [...derivedOutputChanges(), ...statusChanges(), ...heldChanges()]),
        )
        if (closed) return { result, logged: false, started }
        const at = DateTime.makeUnsafe(clock.currentTimeMillisUnsafe())
        const first = log.end()
        log.push(events.map((event, i) => ({ session: id, sequence: first + i, at, event })))
        return { result, logged: events.length > 0, started }
      }),
    ).pipe(
      Effect.tap(({ logged }) => (logged ? PubSub.publish(changed, undefined) : Effect.void)),
      Effect.tap(() => persist),
      Effect.tap(({ started }) =>
        // `startable` holds only in a trusted session.
        started.length === 0 || trust._tag === "Untrusted"
          ? Effect.void
          : credentials.begin(started, trust.runner.openProvider),
      ),
      Effect.map(({ result }) => result),
    )

  const store = makeCredentialStore(credentialSlots.map((slot) => slot.id))
  const credentials = makeCredentials(credentialSlots, {
    update,
    outputsOf: (block) => {
      const slot = slots.find((candidate) => candidate.id === block)
      return slot === undefined ? undefined : doneOutputs(slot)
    },
    scope,
    stateFolder: options.stateFolder,
    environment: options.providerEnvironment,
    store,
    network: options.network,
    resuming: resume?.credentials ?? new Map(),
  })

  const isCurrent = (run: Run) => runs.get(run.slot.index) === run

  /** A done block's outputs: its run's, or a form's or credential block's as last published. */
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

  /**
   * Holds an output the block declares, sensitive if the block declares it
   * so or the script marked it; or notes in the log that it was dropped.
   */
  const holdOutput = (
    state: Running,
    runnable: Runnable,
    key: string,
    value: string,
    marked: boolean,
    lines: LogLine[],
  ) => {
    const decl = Object.hasOwn(runnable.outputs, key) ? runnable.outputs[key] : undefined
    if (decl === undefined)
      lines.push(logLine("stderr", `Output "${key}" was dropped: the block does not declare it.`))
    else state.outputs.set(key, hold(decl.sensitive || marked, value))
  }

  /** What a run's script wrote to `$RUNBOOK_OUTPUT` and `$RUNBOOK_ENV`, held as its events are. */
  const recordWrote = (run: Run, runnable: Runnable, wrote: RunWrote) =>
    update(() => {
      const state = run.state
      if (state._tag !== "Running") return
      const lines: LogLine[] = []
      for (const [key, { value, marked }] of wrote.outputs)
        holdOutput(state, runnable, key, Redacted.value(value), marked, lines)
      for (const [name, value] of wrote.env) state.env.set(name, value)
      run.log.push(lines)
    })

  const record = (run: Run, runnable: Runnable, batch: ReadonlyArray<TaskEvent<string>>) =>
    update((emit) => {
      const state = run.state
      if (state._tag !== "Running") return
      const lines: LogLine[] = []
      const files: FileChange[] = []
      for (const event of batch) {
        switch (event._tag) {
          case "Log":
            lines.push(logLine(event.stream, event.line, event.cut))
            break
          case "Output":
            holdOutput(state, runnable, event.key, event.value, false, lines)
            break
          case "File":
            files.push({ path: event.path, change: event.change })
            break
          case "Warning":
            state.warned = true
            lines.push(logLine("stderr", event.message))
            break
        }
      }
      run.log.push(lines)
      touched(run, files, emit)
    })

  /** Lists what a running run touched, up to the limit, and tells clients what it listed. */
  const touched = (
    run: Run,
    changes: ReadonlyArray<FileChange>,
    emit: (event: EngineEvent) => void,
  ) => {
    const listed = changes.filter(({ path: file, change }) => {
      if (!run.files.has(file) && run.files.size >= LIMITS.maxRunFiles) {
        run.filesTruncated = true
        return false
      }
      run.files.set(file, change)
      return true
    })
    if (listed.length > 0 && isCurrent(run))
      emit({ _tag: "FilesChanged", block: run.slot.id, files: listed })
  }

  /** Records what a run copied from `$GENERATED_FILES`, and logs each link it did not copy. */
  const recordCopied = (run: Run, { changes, truncated, links }: Copied) =>
    update((emit) => {
      if (run.state._tag !== "Running") return
      if (truncated) run.filesTruncated = true
      run.log.push(
        links.map((link) =>
          logLine(
            "stderr",
            `Runbooks did not copy ${link} from $GENERATED_FILES: it is a symbolic link.`,
          ),
        ),
      )
      touched(run, changes, emit)
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
   * The `envFrom` sources of a run, in the order written: a done task's
   * exports as its latest run left them, or a credential block's handle,
   * which its provider answers when the run reads it.
   */
  const envSourcesFor = (slot: Slot): Effect.Effect<ReadonlyArray<EnvSource>> =>
    Effect.forEach(slot.node.shared.envFrom ?? [], (block) => {
      const target = slots.find((candidate) => candidate.id === block)
      const credential = target === undefined ? undefined : credentialSlotAt.get(target.index)
      if (target !== undefined && credential !== undefined)
        return Effect.succeed(
          credentialSource(block, credential.block.envNames, credentials.handle(target.index)),
        )
      const state = target === undefined ? undefined : runs.get(target.index)?.state
      // `notReady` waits for every source to be done; a credential's handle
      // checks that it still is when the run reads it.
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
  const runEnv = (
    run: Run,
    runnable: Runnable,
    sources: ReadonlyArray<EnvSource>,
    reads: TaskReads,
  ) =>
    runnable.block.effects.includes("process")
      ? Effect.flatMap(ownEnv(run.slot.node.shared.env ?? {}, reads), (own) =>
          buildRunEnv({ base: baseEnvironment, sources, own }),
        ).pipe(
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
   * their roots, before anything is made or started; then, for a process
   * task, the files its script writes to; then its events recorded as they
   * come, its log flushed now and then. Only a run whose events end well
   * (exit 0 or 2) has its files read; then its end is recorded, and the
   * folder holding the files goes.
   */
  const task = (
    run: Run,
    runnable: Runnable,
    runScope: Scope.Closeable,
    at: RunRoots,
    reads: TaskReads,
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
    // What the run holds, its files among them, is released when its events
    // and files are done with, before its end is recorded.
    return Effect.scopedWith((held) =>
      Effect.gen(function* () {
        yield* Effect.forkChild(flushEvery)
        const env = yield* runEnv(run, runnable, sources, reads)
        const named = block.paths?.(props, reads.values) ?? {}
        const paths = yield* runner.resolve(at, named, block.repository)
        if (block.repository !== undefined && run.state._tag === "Running")
          run.state.repository = Option.fromUndefinedOr(paths[block.repository])
        const files = block.effects.includes("process")
          ? yield* Scope.provide(runner.makeRunFiles, held)
          : undefined
        const input = taskInput(
          at,
          reads,
          files === undefined ? env : withReserved(env, { ...files, ...repoFiles(at) }),
          paths,
        )
        yield* Stream.runForEachArray(runner.start(block, props, input, held), (batch) =>
          record(run, runnable, batch),
        )
        if (files !== undefined) {
          const wrote = yield* runner.readRunFiles(files)
          // What a copy that stopped part way copied is in the generated folder, so it is listed.
          const copied = yield* runner
            .copyGenerated(files.GENERATED_FILES, at.roots.generated)
            .pipe(
              Effect.catchTag("CopyFailed", ({ failure, copied: some }) =>
                Effect.andThen(recordCopied(run, some), Effect.fail(failure)),
              ),
            )
          yield* recordWrote(run, runnable, wrote)
          yield* recordCopied(run, copied)
        }
      }),
    ).pipe(
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
      case "credential":
        return credentialSlotAt.has(slot.index) && credentials.acts(slot.index)
          ? ["credential"]
          : []
      // "run" submits a form. A task's own form has no Submit, so nothing to run or undo.
      case "form":
        return slot.node.nestedIn === undefined
          ? [...runActionsOf(slot, status), ...values]
          : values
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

  /** A task's or credential block's instruction. It gets no services, so it is built in any trust state. */
  const instructionOf = (slot: Slot): Instruction | undefined => {
    if (Option.isSome(slot.runnable))
      return slot.runnable.value.block.instruction(slot.node.props, readsFor(slot))
    return credentialSlotAt.get(slot.index)?.block.instruction(slot.node.props)
  }

  /** The paths a block names, as the parser named them from its props: none when they don't decode. */
  const pathsOf = (slot: Slot): ReadonlyArray<RunbookPath> =>
    slot.node.props === undefined
      ? []
      : (resolveTag(registry, slot.node.tag)?.block.runbookFiles(slot.node.props) ?? [])

  /**
   * Sets each block's `filesOnDisk` from the files the session holds and
   * what the watcher read, and logs `FilesOnDiskChanged` for each whose
   * changed: every block, or only those that name one of `read`.
   */
  const refreshOnDisk = (emit: (event: EngineEvent) => void, read?: ReadonlySet<RunbookPath>) => {
    const still = new Set(slots.map((slot) => slot.id))
    for (const block of onDisk.keys()) if (!still.has(block)) onDisk.delete(block)
    for (const slot of slots) {
      const paths = pathsOf(slot)
      if (read !== undefined && !paths.some((named) => read.has(named))) continue
      const was = onDisk.get(slot.id)
      const now = filesOnDiskOf(paths, heldFiles, disk)
      if (now === undefined) onDisk.delete(slot.id)
      else onDisk.set(slot.id, now)
      if (JSON.stringify(now) !== JSON.stringify(was))
        emit({ _tag: "FilesOnDiskChanged", block: slot.id })
    }
  }

  const viewOf = (
    slot: Slot,
    logOffset = 0,
    logLimit: number = LIMITS.defaultLogLimit,
  ): BlockView => {
    const run = runs.get(slot.index)
    const form = forms.get(slot.index)
    const outputs = doneOutputs(slot)
    const credential = credentialSlotAt.has(slot.index)
      ? credentials.stateOf(slot.index)
      : undefined
    const instruction = instructionOf(slot)
    const shown = onDisk.get(slot.id)
    const sections = form === undefined ? [] : sectionsOf(form)
    return {
      ...summaryOf(slot),
      ...(instruction === undefined ? {} : { instruction }),
      ...(run === undefined ? {} : { log: logPage(run, logOffset, logLimit) }),
      outputs: outputs === undefined ? {} : outputsView(outputs),
      ...(form === undefined ? {} : { fields: fieldViews(form) }),
      ...(sections.length === 0 ? {} : { sections }),
      ...(credential === undefined ? {} : { credential }),
      ...(run === undefined || run.files.size === 0
        ? {}
        : { files: Array.from(run.files, ([file, change]) => ({ path: file, change })) }),
      ...(run?.filesTruncated === true ? { filesTruncated: true as const } : {}),
      ...(shown === undefined ? {} : { filesOnDisk: shown }),
    }
  }

  /** Moves each of `map`'s entries to the place its block has in `next`, keeping those `keep` allows. */
  const moveTo = <V>(
    map: Map<number, V>,
    before: ReadonlyMap<BlockId, Slot>,
    next: ReadonlyArray<Slot>,
    keep: (id: BlockId) => boolean,
  ) => {
    const moved = next.flatMap((slot) => {
      const was = before.get(slot.id)
      const value = was === undefined ? undefined : map.get(was.index)
      return value === undefined || !keep(slot.id) ? [] : [[slot.index, value] as const]
    })
    map.clear()
    for (const [index, value] of moved) map.set(index, value)
  }

  /**
   * Takes `next` as the session's document, as `DocumentChanged` says. The
   * caller holds the lock. It runs to its end, so the session never holds
   * half of either document.
   *
   * A block whose `keepKeyOf` and file hashes are as they were keeps its
   * run or submit, its form, and its credential block's provider and login.
   * Every other block starts over: a done task's outputs are withdrawn, as
   * a reset withdraws them, and a form keeps the values of the fields it
   * still has, unreviewed, as a resumed session's form does. A block the
   * runbook no longer has goes, with what was saved of it. The blocks that
   * wait for one that starts over keep their own runs, and wait for it
   * again, as after a reset. Trust stays as it was, for the new hash, while
   * the session is open. What is saved keeps the hash the person trusted,
   * unless `by` is the person, choosing the new hash (`ReloadFiles`) over a
   * document they trusted or chose (`chosen`).
   */
  const takeDocument = (
    next: ParsedRunbook,
    by: "watcher" | "person",
  ): Effect.Effect<ReloadResult> =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        // A file missing before and outside the folder now hashes the same, and reads differently.
        if (
          next.document.hash.combined === document.hash.combined &&
          sameFiles(next.files, heldFiles)
        )
          return { _tag: "Unchanged" } as const
        const [first, ...rest] = runningIds()
        if (first !== undefined) return { _tag: "Running", blocks: [first, ...rest] } as const

        const read = yield* readBlocks(next.document, registry, next.texts)
        const nextSlots = slotsOf(read.document, registry)
        const nextCredentialSlots = credentialSlotsOf(nextSlots, registry)
        const nextFileHashes = fileHashesOf(read.document, registry)
        const before = new Map(slots.map((slot) => [slot.id, slot]))
        const still = new Set(nextSlots.map((slot) => slot.id))
        const removed = slots.filter((slot) => !still.has(slot.id)).map((slot) => slot.id)
        const kept = new Set(
          nextSlots.flatMap((slot) => {
            const was = before.get(slot.id)
            const key = keepKeyOf(slot.node, registry)
            return was !== undefined &&
              key !== undefined &&
              key === keepKeyOf(was.node, registry) &&
              sameRecord(fileHashes.get(slot.id) ?? {}, nextFileHashes.get(slot.id) ?? {})
              ? [slot.id]
              : []
          }),
        )
        const isKept = (block: BlockId) => kept.has(block)

        reloading = true
        const stopping = yield* update((emit) => {
          // What the old document's blocks published that no block keeps. A
          // form or credential block the document still has withdraws its
          // own as its status moves, as every update derives.
          for (const slot of slots) {
            if (isKept(slot.id)) continue
            const done = runs.get(slot.index)?.state._tag === "Done"
            if (done || (!still.has(slot.id) && published.has(slot.index)))
              emit({ _tag: "OutputsWithdrawn", block: slot.id })
          }
          const nextForms = new Map<number, Form>()
          const formsChanged: Slot[] = []
          const nextSlotAt = new Map(nextSlots.map((slot) => [slot.index, slot]))
          for (const [index, fresh] of read.forms) {
            const slot = nextSlotAt.get(index)
            const was = slot === undefined ? undefined : before.get(slot.id)
            const held = was === undefined ? undefined : forms.get(was.index)
            const form =
              held === undefined
                ? fresh
                : slot !== undefined && isKept(slot.id)
                  ? held
                  : restoreValues(fresh, savedValuesOf(held))
            nextForms.set(index, form)
            if (slot !== undefined && form !== held) formsChanged.push(slot)
          }
          moveTo(runs, before, nextSlots, isKept)
          forms.clear()
          for (const [index, form] of nextForms) forms.set(index, form)
          const stillSubmitted = nextSlots.filter((slot) => {
            const was = before.get(slot.id)
            return was !== undefined && isKept(slot.id) && submitted.has(was.index)
          })
          submitted.clear()
          for (const slot of stillSubmitted) submitted.add(slot.index)
          // Moved for every block the document still has, so the derived changes compare against them.
          moveTo(published, before, nextSlots, () => true)
          moveTo(statuses, before, nextSlots, () => true)
          // What blocks hold is saved again, against the new runbook and its
          // files. Trust is only when a person chose this hash over one they
          // trusted or chose: after the watcher reloads, the hash saved stays
          // the one the person trusted, until they trust the session again.
          saved.clear()
          savedTrust = false
          chosen = chosen && by === "person"
          const stopped = credentials.reload(nextCredentialSlots, kept)
          store.useBlocks(nextCredentialSlots.map((slot) => slot.id))
          document = read.document
          texts = next.texts
          documentView = documentViewOf(read.document, read.props, next.texts, registry)
          slots = nextSlots
          slotAt = nextSlotAt
          credentialSlotAt = new Map(nextCredentialSlots.map((slot) => [slot.index, slot]))
          fileHashes = nextFileHashes
          source = next.source
          heldFiles = next.files
          // The watcher stops watching a path no block names, so what it read there goes stale.
          for (const named of disk.keys()) if (!heldFiles.has(named)) disk.delete(named)
          const hash = document.hash.combined
          emit({ _tag: "DocumentChanged", hash })
          emit({ _tag: "TrustChanged", trust: { trusted: trust._tag === "Trusted", hash } })
          for (const slot of formsChanged) {
            const form = forms.get(slot.index)
            if (form !== undefined)
              emit({ _tag: "FieldsChanged", block: slot.id, fields: fieldViews(form) })
          }
          refreshOnDisk(emit)
          return stopped
        })
        yield* stopping
        reloading = false
        // Starts each credential block that starts over and nothing blocks.
        yield* update(() => undefined)
        yield* saving.withPermit(
          Effect.forEach(
            removed,
            (block) =>
              Effect.forEach(["values", "run", "credential"] as const, (kind) =>
                saver.drop(block, kind),
              ),
            { discard: true },
          ),
        )
        return { _tag: "Reloaded" } as const
      }),
    )

  /** The session's runbook text parsed with `files`: it parsed before, and only a text refuses a runbook. */
  const parseHeld = (
    text: string,
    files: ReadonlyMap<RunbookPath, FileFact>,
  ): Effect.Effect<ParsedRunbook> => {
    const next = startParse(text, registry, { file: document.file, appVersion }).finish(files)
    // Unreachable: only a runbook's own text refuses it (`refusesRunbook`), and
    // this text parsed before. A file a block names stops that block alone (`badFile`).
    return next._tag === "Parsed"
      ? Effect.succeed(next)
      : Effect.die(
          new Error(
            `This is a bug in Runbooks, not in the runbook: the runbook parsed, but not with the files the session holds or a block showed on disk (${next.errors[0].message}).`,
          ),
        )
  }

  /** Reloads the runbook its watcher read, as `reload` says. The caller holds the lock. */
  const attempt = (read: RunbookRead, files: ReloadFilesFrom): Effect.Effect<RunbookReload> =>
    Effect.gen(function* () {
      pending = undefined
      if (read._tag !== "Parsed") {
        refused = read
        yield* update(() => undefined)
        return read
      }
      refused = undefined
      const next =
        files === "read"
          ? read
          : yield* parseHeld(
              read.source,
              new Map(
                Array.from(read.files, ([named, fact]) => [named, heldFiles.get(named) ?? fact]),
              ),
            )
      const taken = yield* takeDocument(next, "watcher")
      if (taken._tag === "Running") pending = { read, files }
      yield* update((emit) => refreshOnDisk(emit))
      return taken
    })

  /** Takes the reload held back for the blocks running, once none runs. */
  const letThrough = Effect.suspend(() =>
    pending === undefined || runningIds().length > 0
      ? Effect.void
      : lock.withPermit(
          Effect.suspend(() =>
            closing || pending === undefined
              ? Effect.void
              : Effect.asVoid(attempt(pending.read, pending.files)),
          ),
        ),
  )

  // The runbook's folder, until sessions get names of their own.
  const name = path.basename(path.dirname(document.file))

  const session: Session = {
    id,
    summary: () => {
      const { title } = document.frontMatter
      return {
        session: id,
        name,
        path: document.file,
        ...(title === undefined ? {} : { title }),
        blocks: slots.length,
      }
    },

    view: () => ({
      session: id,
      name,
      path: document.file,
      ...(document.frontMatter.title === undefined ? {} : { title: document.frontMatter.title }),
      // Read in the same step as the statuses: a change logs its events as it makes them.
      ...(log.end() === 0 ? {} : { sequence: log.end() - 1 }),
      trust: { trusted: trust._tag === "Trusted", hash: document.hash.combined },
      blocks: inOnePass(() => slots.map(summaryOf)),
      warnings: document.warnings,
      ...(resume === undefined ? {} : { resumed: resume.resumed }),
      ...(heldShown === undefined ? {} : { reloadHeld: heldShown }),
      ...(unwatched === undefined ? {} : { unwatched }),
    }),

    documentView: () => documentView,

    trust: (hash, runner) =>
      update((emit): TrustResult => {
        const current = document.hash.combined
        if (hash !== current) return { _tag: "HashChanged", current }
        if (trust._tag === "Untrusted") {
          trust = { _tag: "Trusted", runner }
          emit({ _tag: "TrustChanged", trust: { trusted: true, hash: current } })
        }
        // A session trusted through a watcher's reload is trusted for this hash by the person now.
        chosen = true
        return { _tag: "Trusted" }
      }),

    events: (after) =>
      Stream.unwrap(
        Effect.map(PubSub.subscribe(changed), (wake) =>
          // A sequence not logged yet would be waited for past the session's end.
          after !== undefined && after >= log.end()
            ? Stream.fail(new UnknownSequence({ session: id, after, next: log.end() }))
            : Stream.paginate(after === undefined ? 0 : after + 1, (next: number) => {
                const page = log.slice(next)
                const last = page.at(-1)
                if (last === undefined)
                  return Effect.as(PubSub.take(wake), [[], Option.some(next)] as const)
                const more =
                  last.event._tag === "SessionClosed"
                    ? Option.none()
                    : Option.some(last.sequence + 1)
                return Effect.succeed([page, more] as const)
              }),
        ),
      ),

    getBlock: (block, logOffset, logLimit) =>
      Effect.map(byId(block), (slot) => viewOf(slot, logOffset, logLimit)),

    // Without the lock, as `getBlock`, so the read never waits behind a
    // locked operation, such as a stop's grace. It is consistent without
    // it: it reads the block's slot, `texts` and `documentView` in one
    // synchronous step when it runs, and a reload replaces all three
    // together in one synchronous step under its own lock, so the read
    // gives one document's hash and that document's files.
    getScriptFiles: (block) =>
      Effect.suspend(() => {
        const slot = slots.find((candidate) => candidate.id === block)
        if (slot === undefined) return Effect.fail(new UnknownBlock({ session: id, block }))
        const { node, index } = slot
        const defined = blockOf(node, registry)
        return Effect.succeed({
          document: documentView.hash,
          files: heldScriptFiles(node, defined, texts.get(index) ?? NO_FILES).map(
            (held): ScriptFile => ({
              ...held,
              language: scriptLanguageOf(node, defined, held.text),
            }),
          ),
        })
      }),

    reload: (read, files) =>
      lock.withPermit(
        Effect.andThen(
          notClosing,
          Effect.suspend(() => {
            // Read after what the watcher read before them, so they are what is
            // on disk now. Not again when a reload held back is taken: what the
            // watcher read since is newer.
            if (read._tag === "Parsed")
              for (const [named, fact] of read.files)
                if (heldFiles.has(named)) disk.set(named, fact)
            return attempt(read, files)
          }),
        ),
      ),

    filesChanged: (facts) =>
      lock.withPermit(
        Effect.andThen(
          notClosing,
          update((emit) => {
            const read = new Set<RunbookPath>()
            for (const [named, fact] of facts) {
              if (!heldFiles.has(named)) continue
              disk.set(named, fact)
              read.add(named)
            }
            refreshOnDisk(emit, read)
          }),
        ),
      ),

    unwatched: (message) =>
      lock.withPermit(
        Effect.andThen(
          notClosing,
          update((emit) => {
            unwatched = { message }
            emit({ _tag: "Unwatched", message })
          }),
        ),
      ),

    reloadFiles: (block, hash) =>
      lock.withPermit(
        Effect.gen(function* () {
          yield* notClosing
          const slot = yield* byId(block)
          if (onDisk.get(slot.id)?.hash !== hash) return { _tag: "NotShown" } as const
          const files = new Map(heldFiles)
          for (const named of pathsOf(slot)) {
            const fact = disk.get(named)
            if (fact !== undefined) files.set(named, fact)
          }
          const taken = yield* takeDocument(yield* parseHeld(source, files), "person")
          // Unreachable: the block showed files that differ from the session's, and took them.
          return taken._tag === "Unchanged" ? ({ _tag: "NotShown" } as const) : taken
        }),
      ),

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
          const reads = readsFor(slot)
          const sources = yield* envSourcesFor(slot)
          // The run starts, or nothing changes: a RunBlock cancelled here would
          // leave the block Running with nothing to run it. The run itself
          // stays interruptible, as every fork starts.
          return yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const runScope = yield* Scope.fork(scope)
              const run: Run = {
                id: decodeRunId(crypto.randomUUID()),
                slot,
                log: makeWindow(MAX_RUN_LOG_LINES),
                flushed: 0,
                files: new Map(),
                filesTruncated: false,
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
                if (previous?.state._tag === "Done")
                  emit({ _tag: "OutputsWithdrawn", block: slot.id })
                runs.set(slot.index, run)
              })
              // Started at once, so a cancel that comes before the run's first step still ends it.
              yield* Effect.forkIn(
                task(run, runnable, runScope, at, reads, sources, runner),
                runScope,
                {
                  startImmediately: true,
                },
              )
              return { _tag: "Started", run: run.id } as const
            }),
          )
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
            while (statusOf(slot)?._tag === "Running") yield* PubSub.take(wake)
          }),
        )
        const outcome = yield* Effect.timeoutOption(settled, timeoutMillis)
        // The block as the session holds it now: a reload may have come since it stopped running.
        return {
          block: viewOf(yield* byId(block), logOffset, logLimit),
          timedOut: Option.isNone(outcome),
        }
      }),

    actOnCredential: (block, action) =>
      lock.withPermit(
        Effect.gen(function* () {
          yield* notClosing
          const slot = yield* byId(block)
          if (slot.node.class !== "credential")
            return yield* new WrongClass({
              block,
              class: slot.node.class,
              expected: ["credential"],
            })
          if (!credentialSlotAt.has(slot.index))
            return { _tag: "NotAllowed", state: "Misconfigured" } as const
          if (trust._tag === "Untrusted") return { _tag: "NotAllowed", state: "Blocked" } as const
          return yield* credentials.act(slot.index, action, trust.runner.openProvider)
        }),
      ),

    outputs: () =>
      Object.fromEntries(
        slots.flatMap((slot) => {
          const outputs = doneOutputs(slot)
          return outputs === undefined ? [] : [[slot.id, outputsView(outputs)]]
        }),
      ),

    // Once begun, a close ends: one cancelled halfway would leave the session
    // closing, with its `events` streams waiting for a `SessionClosed`.
    closing: () => closing,
    close: lock.withPermit(
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (closing) return
          closing = true
          // Every running script is stopped at once, each with its grace. The
          // scope's finalizers run in turn, and each run's waits for its stop.
          yield* Effect.forEach(slots, stop, { concurrency: "unbounded", discard: true })
          yield* Scope.close(scope, Exit.void)
          yield* update((emit) => emit({ _tag: "SessionClosed" }))
          closed = true
          yield* saver.close(log.end())
        }),
      ),
    ),
  }

  // The first fields, resumed runs and statuses, so the log alone tells a
  // client every block's state.
  yield* update((emit) => {
    for (const slot of slots) {
      const form = forms.get(slot.index)
      if (form !== undefined)
        emit({ _tag: "FieldsChanged", block: slot.id, fields: fieldViews(form) })
      const run = runs.get(slot.index)
      if (run === undefined) continue
      flush(run, emit)
      if (run.state._tag === "Done")
        emit({ _tag: "OutputsPublished", block: slot.id, outputs: outputsView(run.state.outputs) })
    }
  })
  // Each change may end the last block running that a held reload waits
  // for. Subscribed now, so no change made before the loop first runs is missed.
  const wake = yield* Scope.provide(scope)(PubSub.subscribe(changed))
  yield* Effect.forkIn(Effect.forever(Effect.andThen(PubSub.take(wake), letThrough)), scope)
  if (options.watch !== undefined)
    yield* Effect.forkIn(
      options.watch(session, () => heldFiles),
      scope,
    )
  return session
})
