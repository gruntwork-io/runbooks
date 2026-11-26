/**
 * The engine protocol: every command a client sends, every event it
 * receives, and every error, defined once. Electron IPC, the in-process CLI
 * and MCP are transports for this one `RpcGroup`.
 *
 * - A command is decoded on arrival; a malformed one fails naming the field.
 * - Faults (an unknown session, a call the block's class does not take) are
 *   typed errors. Expected outcomes (a run refused because the block is
 *   blocked) are closed unions in the success channel.
 * - Who is calling, a person or an agent, comes from the transport through
 *   `CallerMiddleware`, never from the payload.
 * - Every event carries its session, and every block event its block id.
 * - No secret leaves the engine: sensitive values are `Hidden`, and a
 *   secret a person types travels one way, in.
 * - Settings belong to no session. The engine holds the only copy; a
 *   client reads and watches them, and a person changes them, here.
 */
import { Context, Schema, Struct } from "effect"
import { Rpc, type RpcClient, type RpcClientError, RpcGroup, RpcMiddleware } from "effect/rpc"
import { BlockClass, BlockId } from "@runbooks/blocks-core/contract"
import { Field, FieldType, FieldValue, Validation } from "@runbooks/blocks-core/form"
import { Blocker, BlockStatus } from "@runbooks/blocks-core/status"
import { CredentialAction, CredentialState } from "../credential/lifecycle.ts"
import { ConfigError, ConfigWarning, Span } from "../document/configError.ts"
import { ContentHash, TreeNode } from "../document/document.ts"

// ---------------------------------------------------------------------------
// Identifiers and limits
// ---------------------------------------------------------------------------

export const SessionId = Schema.NonEmptyString.pipe(Schema.brand("SessionId"))
export type SessionId = typeof SessionId.Type

export const RunId = Schema.NonEmptyString.pipe(Schema.brand("RunId"))
export type RunId = typeof RunId.Type

export const ApprovalId = Schema.NonEmptyString.pipe(Schema.brand("ApprovalId"))
export type ApprovalId = typeof ApprovalId.Type

/**
 * An absolute path. The engine reads a relative one against its own working
 * directory, which no client sees, and the runbook's folder is a root.
 */
export const AbsolutePath = Schema.NonEmptyString.check(
  Schema.isPattern(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/, { expected: "an absolute path" }),
)

/**
 * An event's place in its session's log: from 0 in a new session, and on
 * past the session it resumes in a resumed one. A client resumes with the
 * last one it saw.
 */
export const Sequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const LIMITS = {
  /** Log lines a read returns when it does not say. */
  defaultLogLimit: 200,
  maxLogLimit: 5000,
  /** `WaitForBlock` waits at most this long in one call, inside MCP clients' tool timeouts. */
  maxWaitMillis: 120_000,
  defaultWaitMillis: 30_000,
  /** The files a block's view lists for its latest run. */
  maxRunFiles: 10_000,
  /** The events a session keeps for `Events` to replay. Older ones are dropped. */
  keptEvents: 10_000,
} as const

const LogLimit = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(LIMITS.maxLogLimit),
)
const LogOffset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

// ---------------------------------------------------------------------------
// Who is calling
// ---------------------------------------------------------------------------

/**
 * The window and the CLI are a person; MCP is an agent. An agent cannot
 * trust a session or answer an approval, and the engine asks the person to
 * approve an agent's run when the setting says so.
 */
export const Origin = Schema.Literals(["person", "agent"])
export type Origin = typeof Origin.Type

export class Caller extends Context.Service<Caller, { readonly origin: Origin }>()(
  "@runbooks/core/engine/Caller",
) {}

/** Each transport's server provides `Caller` from what it knows of the connection. */
export class CallerMiddleware extends RpcMiddleware.Service<
  CallerMiddleware,
  { provides: Caller }
>()("@runbooks/core/engine/CallerMiddleware") {}

// ---------------------------------------------------------------------------
// Views: what a client is shown
// ---------------------------------------------------------------------------

/** A value a client may or may not see. A sensitive one is `Hidden`. */
const Visible = <S extends Schema.Top>(value: S) =>
  Schema.Union([Schema.TaggedStruct("Shown", { value }), Schema.TaggedStruct("Hidden", {})])

export const OutputView = Visible(Schema.String)
export type OutputView = typeof OutputView.Type

export const FieldView = Schema.Struct({
  name: Schema.String,
  type: FieldType,
  description: Schema.String,
  required: Schema.Boolean,
  sensitive: Schema.Boolean,
  options: Schema.optionalKey(Schema.Array(Schema.String)),
  optionLabels: Field.fields.optionLabels,
  /** The section the window groups the field in. */
  section: Field.fields.section,
  /** Absent while the field is empty: an optional int left blank has no value, not `""`. */
  value: Schema.optionalKey(Visible(FieldValue)),
  /** The runbook's default. Left out for a sensitive field. */
  default: Schema.optionalKey(FieldValue),
  /** Imported from another block, or locked. */
  readOnly: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
  validations: Schema.Array(Validation),
  /** An agent set or confirmed it. A default nobody looked at is unreviewed. */
  reviewed: Schema.Boolean,
  /** For a value that reads other values: what it comes to now. */
  resolvedValue: Schema.optionalKey(Visible(FieldValue)),
  /** References in the value that cannot be resolved yet, and why. */
  unresolved: Schema.Array(Schema.String),
})
export type FieldView = typeof FieldView.Type

export const LogLine = Schema.Struct({
  stream: Schema.Literals(["stdout", "stderr"]),
  text: Schema.String,
})
export type LogLine = typeof LogLine.Type

/** One page of the latest run's log. */
export const LogPage = Schema.Struct({
  offset: LogOffset,
  /** How many lines the run has so far. The next page starts at `offset + lines.length`. */
  total: LogOffset,
  lines: Schema.Array(LogLine),
})
export type LogPage = typeof LogPage.Type

/** A run or credential action that waits for the person to approve it in the window. */
export const Approval = Schema.Struct({
  approval: ApprovalId,
  block: BlockId,
  /** "run", or the credential action's tag. */
  action: Schema.String,
})
export type Approval = typeof Approval.Type

/** What a client may ask of a block now. The engine refuses anything else. */
export const BlockAction = Schema.Literals([
  "run",
  "cancel",
  "reset",
  "setValues",
  "confirmValues",
  "credential",
])
export type BlockAction = typeof BlockAction.Type

export const BlockSummary = Schema.Struct({
  /** Normalized: hyphens become underscores. */
  block: BlockId,
  /** The MDX tag as written, which may be an alias. */
  tag: Schema.String,
  class: BlockClass,
  title: Schema.optionalKey(Schema.String),
  /** Absent for a display block, which has no lifecycle. */
  status: Schema.optionalKey(BlockStatus),
  approval: Schema.optionalKey(Approval),
  actions: Schema.Array(BlockAction),
})
export type BlockSummary = typeof BlockSummary.Type

/** A file a run wrote, changed or removed. */
export const FileChange = Schema.Struct({
  path: AbsolutePath,
  change: Schema.Literals(["created", "modified", "deleted"]),
})
export type FileChange = typeof FileChange.Type

export const BlockView = Schema.Struct({
  ...BlockSummary.fields,
  log: Schema.optionalKey(LogPage),
  outputs: Schema.Record(Schema.String, OutputView),
  /** A form block's fields, or a task's own form. */
  fields: Schema.optionalKey(Schema.Array(FieldView)),
  credential: Schema.optionalKey(CredentialState),
  /**
   * The files the block's latest run wrote, changed or removed: one entry
   * per path, with its latest change, in the order the run first touched
   * each. The first `LIMITS.maxRunFiles` paths only: `filesTruncated` says
   * the run touched more. Absent when it touched none.
   */
  files: Schema.optionalKey(Schema.Array(FileChange).check(Schema.isMaxLength(LIMITS.maxRunFiles))),
  /** Present when the run touched more paths than `files` lists. */
  filesTruncated: Schema.optionalKey(Schema.Literal(true)),
})
export type BlockView = typeof BlockView.Type

export const TrustState = Schema.Struct({
  trusted: Schema.Boolean,
  /** The hash trust is, or would be, granted for. */
  hash: ContentHash,
})
export type TrustState = typeof TrustState.Type

export const SessionSummary = Schema.Struct({
  session: SessionId,
  name: Schema.String,
  /** The runbook file. */
  path: Schema.String,
  title: Schema.optionalKey(Schema.String),
  blocks: Schema.Int,
})
export type SessionSummary = typeof SessionSummary.Type

/**
 * Why part of a saved session was not restored. Each block a problem names
 * starts over in that part; the rest of the session is as it was left.
 */
export const ResumeProblem = Schema.Union([
  /**
   * A Runbooks older than this one saved the runs of `blocks`, in
   * saved-session version `version`. Their form values and credentials were
   * kept, and their runs were not (open decision 6).
   */
  Schema.TaggedStruct("OlderVersion", { version: Schema.Int, blocks: Schema.Array(BlockId) }),
  /** A newer Runbooks saved what `blocks` hold, in saved-session version `version`, which this one does not read. */
  Schema.TaggedStruct("NewerVersion", { version: Schema.Int, blocks: Schema.Array(BlockId) }),
  /**
   * The runbook, or a file it names, changed since the session was saved. A
   * session that was trusted is untrusted until the person trusts it again,
   * and the runs of `blocks`, whose runbook or files changed, were not kept.
   */
  Schema.TaggedStruct("RunbookChanged", { blocks: Schema.Array(BlockId) }),
  /** What `blocks` hold could not be decrypted, as when the system's key changed. */
  Schema.TaggedStruct("Unreadable", { blocks: Schema.Array(BlockId) }),
])
export type ResumeProblem = typeof ResumeProblem.Type

/** The runbook's saved session, which the engine resumed instead of starting one. */
export const Resumed = Schema.Struct({
  /** When the session was last opened or closed before. */
  lastUsed: Schema.DateTimeUtc,
  problems: Schema.Array(ResumeProblem),
})
export type Resumed = typeof Resumed.Type

export const SessionView = Schema.Struct({
  ...SessionSummary.fields,
  trust: TrustState,
  blocks: Schema.Array(BlockSummary),
  warnings: Schema.Array(ConfigWarning),
  /** Present when the engine resumed the runbook's saved session. */
  resumed: Schema.optionalKey(Resumed),
})
export type SessionView = typeof SessionView.Type

/** What a window is shown of every block in the document, whatever its configuration. */
const placedBlock = {
  /** Its place in `DocumentView.blocks`. The tree's `block` node for it holds the same index. */
  index: Schema.Int,
  /** The MDX tag as written, which may be an alias. */
  tag: Schema.String,
  /** The registry block the tag resolves to. */
  block: Schema.String,
  class: BlockClass,
  /** Normalized, as `BlockSummary.block`. Absent only for a display block written without one. */
  id: Schema.optionalKey(BlockId),
  /** Where the block is written in the runbook. */
  span: Span,
  /** Shared props the block's frame shows: its header, and whether it folds once done. */
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  autoCollapse: Schema.optionalKey(Schema.Boolean),
}

export const DocumentBlock = Schema.Union([
  Schema.TaggedStruct("Configured", {
    ...placedBlock,
    /**
     * The block's own props, encoded with its own schema after alias locks:
     * what the author wrote. Sent for a display block, and for a task with no
     * form of its own. Any other block's props can hold a default the engine
     * hides (a sensitive field's, a secret sign-in field's), so its view
     * draws from `BlockView.fields` or `BlockView.credential` instead.
     */
    props: Schema.optionalKey(Schema.Json),
  }),
  /**
   * The block's configuration has errors: the parser's, then those the
   * engine found when the session opened, as a form it could not read. Its
   * status is `Misconfigured`, and a window shows these in place of its view.
   */
  Schema.TaggedStruct("Misconfigured", {
    ...placedBlock,
    errors: Schema.NonEmptyArray(ConfigError),
  }),
])
export type DocumentBlock = typeof DocumentBlock.Type

/** The session's runbook as a window renders it. Nothing in it changes while the session is open. */
export const DocumentView = Schema.Struct({
  /** The front matter's title. */
  title: Schema.optionalKey(Schema.String),
  /**
   * The mdast root, as JSON. Each block is a `{ type: "block", index }`
   * node, holding its markdown children for a block that takes them.
   */
  tree: TreeNode,
  /** Every block, in document order: `blocks[i].index` is `i`. */
  blocks: Schema.Array(DocumentBlock),
  warnings: Schema.Array(ConfigWarning),
})
export type DocumentView = typeof DocumentView.Type

// ---------------------------------------------------------------------------
// Results: expected outcomes, as closed unions
// ---------------------------------------------------------------------------

export const OpenResult = Schema.Union([
  Schema.TaggedStruct("Opened", { session: SessionView }),
  /**
   * The runbook has an error that refuses it (`RunbookErrorCode`): it does
   * not parse, would run code, uses a block this version lacks, or needs
   * another version. `errors` holds every error found. Nothing was started.
   * A runbook whose errors are all in blocks opens, those blocks `Misconfigured`.
   */
  Schema.TaggedStruct("Invalid", {
    errors: Schema.NonEmptyArray(ConfigError),
    warnings: Schema.Array(ConfigWarning),
  }),
])
export type OpenResult = typeof OpenResult.Type

export const TrustResult = Schema.Union([
  Schema.TaggedStruct("Trusted", {}),
  /** The runbook or a file it names changed since the person saw it. Nothing was trusted. */
  Schema.TaggedStruct("HashChanged", { current: ContentHash }),
])
export type TrustResult = typeof TrustResult.Type

export const Refusal = Schema.Union([
  Schema.TaggedStruct("Blocked", { by: Schema.Array(Blocker) }),
  /** The block's own fields are empty or invalid. */
  Schema.TaggedStruct("NeedsInput", { fields: Schema.Array(Schema.String) }),
  /** An agent has not set or confirmed every field of a form the block reads. */
  Schema.TaggedStruct("NeedsReview", {
    form: BlockId,
    fields: Schema.Array(FieldView),
    unreviewed: Schema.NonEmptyArray(Schema.String),
  }),
  Schema.TaggedStruct("AlreadyRunning", {}),
  /** The block's configuration has errors (its document node's `errors`), so it never runs. */
  Schema.TaggedStruct("Misconfigured", {}),
])
export type Refusal = typeof Refusal.Type

export const RunResult = Schema.Union([
  Schema.TaggedStruct("Started", { run: RunId }),
  /** A form was submitted: it is done, with no run to follow. */
  Schema.TaggedStruct("Submitted", {}),
  /** The person is asked to approve it in the window; it starts if they do. */
  Schema.TaggedStruct("AwaitingApproval", { approval: ApprovalId }),
  Schema.TaggedStruct("Refused", { reason: Refusal }),
])
export type RunResult = typeof RunResult.Type

/**
 * Where a credential block is when it does not take an action. A closed set:
 * each `CredentialState` tag, then two for a block with no state.
 *
 * - A credential state's tag: the block is in that state, and that state
 *   does not take the action.
 * - `Blocked`: its lifecycle has not started, because the session is not
 *   trusted or a block it waits for is not done.
 * - `Misconfigured`: its configuration has errors (its document node's
 *   `errors`), so it has no lifecycle and takes no action.
 */
const NotAllowedState = Schema.Literals([
  ...CredentialState.members.map((state) => state.fields._tag.schema.literal),
  "Blocked",
  "Misconfigured",
])

export const ActResult = Schema.Union([
  Schema.TaggedStruct("Accepted", {}),
  Schema.TaggedStruct("AwaitingApproval", { approval: ApprovalId }),
  Schema.TaggedStruct("NotAllowed", { state: NotAllowedState }),
  /**
   * The action names a sign-in method, a level or a target the block does
   * not offer now, in its field `field`. Nothing changed. A null `id` is no
   * target, at a level that is not optional. A Ready block holds no list of
   * a level's targets, so for an `id` it offers none.
   */
  Schema.TaggedStruct("NotOffered", {
    field: Schema.Literals(["method", "level", "id"]),
    value: Schema.NullOr(Schema.String),
    offered: Schema.Array(Schema.String),
  }),
])
export type ActResult = typeof ActResult.Type

export const SetValuesResult = Schema.Struct({
  /** Field errors after the values were entered, by field name. */
  errors: Schema.Record(Schema.String, Schema.String),
  /** Values not entered, and why: an unknown or read-only field. */
  rejected: Schema.Record(Schema.String, Schema.String),
  /** Fields an agent has still not set or confirmed. */
  unreviewed: Schema.Array(Schema.String),
})
export type SetValuesResult = typeof SetValuesResult.Type

export const CancelResult = Schema.Literals(["cancelled", "notRunning"])

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** The most hosts a recent-hosts list keeps, newest first. */
const MAX_RECENT_HOSTS = 5

/** A host as a URL's `host` has it: a name or address, and a port if it is not the default. */
const Host = Schema.NonEmptyString.check(
  Schema.isMaxLength(255),
  Schema.isPattern(/^[^\s/@]+$/, { expected: "a host, with a port if needed" }),
)

const RecentHosts = Schema.Array(Host).check(Schema.isMaxLength(MAX_RECENT_HOSTS))

/**
 * An HTTP or HTTPS proxy, as `http://proxy.example.com:3128`. It may hold no
 * user name or password: every client is shown the settings, and the
 * settings file is not a secret store.
 */
const ProxyUrl = Schema.NonEmptyString.check(
  Schema.isMaxLength(2048),
  Schema.makeFilter((text: string) => {
    if (!URL.canParse(text)) return "Expected a URL, as http://proxy.example.com:3128."
    const url = new URL(text)
    if (url.protocol !== "http:" && url.protocol !== "https:")
      return "Expected an http:// or https:// proxy URL."
    if (url.username !== "" || url.password !== "")
      return "A proxy URL may not hold a user name or password."
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "")
      return "Expected a proxy URL with no path, query or fragment."
    return undefined
  }),
)

/**
 * Every setting, as it applies now: the one a person chose, or its
 * default. The engine holds the only copy. The window, the CLI and MCP read
 * them here, and none keeps one of its own.
 */
export const Settings = Schema.Struct({
  /** The window's colors. */
  theme: Schema.Literals(["light", "dark", "system"]),
  /** The window shows each step's command to copy and run, and runs nothing. */
  instructionMode: Schema.Boolean,
  /** The runbook column's width in pixels, as the person dragged it. Null: the layout's own. */
  runbookWidth: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  /** On opening a runbook, the window asks what to do with files it generated before. */
  askAboutGeneratedFiles: Schema.Boolean,
  /**
   * A PEM file of certificates to trust beside the system's, for a network
   * that inspects TLS. A credential provider gets it when it opens.
   */
  caBundleFile: Schema.NullOr(AbsolutePath.check(Schema.isMaxLength(4096))),
  /** The proxy a credential provider connects through. It gets it when it opens. */
  proxy: Schema.NullOr(ProxyUrl),
  /** Agents may drive the app over MCP. */
  agentAccess: Schema.Boolean,
  /** The person approves each run an agent starts. */
  confirmAgentRuns: Schema.Boolean,
  /** GitHub hosts the person signed in to, newest first. */
  recentGitHubHosts: RecentHosts,
  lastSelectedGitHubHost: Schema.NullOr(Host),
  /** GitLab hosts the person typed in, newest first. */
  recentGitLabHosts: RecentHosts,
  lastSelectedGitLabHost: Schema.NullOr(Host),
})
export type Settings = typeof Settings.Type

/** Some settings and their new values. A setting left out keeps the value it has. */
export const SettingsChange = Settings.mapFields(Struct.map(Schema.optionalKey))
export type SettingsChange = typeof SettingsChange.Type

/** The settings file could not be read, or not copied aside. Defaults apply, and a change is refused, so the file stays as it is. */
const Unreadable = Schema.TaggedStruct("Unreadable", { reason: Schema.String })

/**
 * A newer Runbooks wrote the settings file, with settings version
 * `version`. The settings this version knows apply. A change is refused:
 * saving it would lose the ones this version does not know.
 */
const Newer = Schema.TaggedStruct("Newer", { version: Schema.Int })

/** Why the settings shown are not all, or not only, what the settings file holds. */
export const SettingsProblem = Schema.Union([
  Unreadable,
  Newer,
  /**
   * The file is not settings this version reads (`reason`). Defaults apply.
   * It was copied to `keptAt`, and the next change replaces it.
   */
  Schema.TaggedStruct("KeptAside", { reason: Schema.String, keptAt: Schema.String }),
  /**
   * The file's value for `setting` is not one this version takes
   * (`message`), so its default applies. The file keeps the value until a
   * change sets the setting.
   */
  Schema.TaggedStruct("InvalidSetting", { setting: Schema.String, message: Schema.String }),
  /** The file holds `setting`, which this version does not know. Nothing reads it, and the file keeps it. */
  Schema.TaggedStruct("UnknownSetting", { setting: Schema.String }),
])
export type SettingsProblem = typeof SettingsProblem.Type

export const SettingsView = Schema.Struct({
  settings: Settings,
  /** The settings file. */
  file: Schema.String,
  problems: Schema.Array(SettingsProblem),
})
export type SettingsView = typeof SettingsView.Type

export const ChangeSettingsResult = Schema.Union([
  Schema.TaggedStruct("Changed", { settings: SettingsView }),
  /** The settings file cannot be replaced without losing what it holds. Nothing changed. */
  Schema.TaggedStruct("ReadOnly", { problem: Schema.Union([Unreadable, Newer]) }),
])
export type ChangeSettingsResult = typeof ChangeSettingsResult.Type

// ---------------------------------------------------------------------------
// Faults
// ---------------------------------------------------------------------------

export class UnknownSession extends Schema.TaggedError<UnknownSession>()("UnknownSession", {
  session: Schema.String,
}) {}

export class UnknownBlock extends Schema.TaggedError<UnknownBlock>()("UnknownBlock", {
  session: SessionId,
  block: Schema.String,
}) {}

/** `Events` was asked for the events after a sequence the session has not logged yet. */
export class UnknownSequence extends Schema.TaggedError<UnknownSequence>()("UnknownSequence", {
  session: SessionId,
  after: Sequence,
  /** The sequence the session logs next. */
  next: Sequence,
}) {}

/** The command does not apply to the block's class: running a display block, signing in to a task. */
export class WrongClass extends Schema.TaggedError<WrongClass>()("WrongClass", {
  block: BlockId,
  class: BlockClass,
  expected: Schema.Array(BlockClass),
}) {}

/** The caller's origin may not send this command: an agent trusting a session, answering an approval or changing a setting. */
export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {
  command: Schema.String,
  origin: Origin,
}) {}

export class RunbookUnreadable extends Schema.TaggedError<RunbookUnreadable>()(
  "RunbookUnreadable",
  { path: Schema.String, message: Schema.String },
) {}

export class UnknownApproval extends Schema.TaggedError<UnknownApproval>()("UnknownApproval", {
  approval: Schema.String,
}) {}

/** The settings file could not be written. Nothing changed. */
export class SettingsNotSaved extends Schema.TaggedError<SettingsNotSaved>()("SettingsNotSaved", {
  file: Schema.String,
  message: Schema.String,
}) {}

const SessionError = UnknownSession
const BlockError = Schema.Union([UnknownSession, UnknownBlock])
const ClassError = Schema.Union([UnknownSession, UnknownBlock, WrongClass])

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const EngineEvent = Schema.Union([
  Schema.TaggedStruct("TrustChanged", { trust: TrustState }),
  Schema.TaggedStruct("BlockStatusChanged", { block: BlockId, status: BlockStatus }),
  /** Batched: the engine sends lines as they arrive, at most a few batches a second. */
  Schema.TaggedStruct("LogLines", {
    block: BlockId,
    run: RunId,
    offset: LogOffset,
    lines: Schema.Array(LogLine),
  }),
  Schema.TaggedStruct("OutputsPublished", {
    block: BlockId,
    outputs: Schema.Record(Schema.String, OutputView),
  }),
  Schema.TaggedStruct("OutputsWithdrawn", { block: BlockId }),
  Schema.TaggedStruct("FieldsChanged", { block: BlockId, fields: Schema.Array(FieldView) }),
  /** What a run just touched. The block's view keeps the run's list. */
  Schema.TaggedStruct("FilesChanged", { block: BlockId, files: Schema.Array(FileChange) }),
  Schema.TaggedStruct("CredentialChanged", { block: BlockId, state: CredentialState }),
  Schema.TaggedStruct("ApprovalRequested", { approval: Approval }),
  Schema.TaggedStruct("ApprovalResolved", { approval: ApprovalId, approved: Schema.Boolean }),
  Schema.TaggedStruct("Warning", { warning: ConfigWarning }),
  Schema.TaggedStruct("SessionClosed", {}),
])
export type EngineEvent = typeof EngineEvent.Type

export const EventEnvelope = Schema.Struct({
  session: SessionId,
  /**
   * Rises by one with each event. A resumed session goes on past every
   * sequence the session it resumes logged, so an `after` from before still
   * holds.
   */
  sequence: Sequence,
  at: Schema.DateTimeUtc,
  event: EngineEvent,
})
export type EventEnvelope = typeof EventEnvelope.Type

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const session = { session: SessionId }
const block = { session: SessionId, block: BlockId }

export class OpenSession extends Rpc.make("OpenSession", {
  /** The runbook the person chose. Its folder is the session's `runbook` root. */
  payload: { path: AbsolutePath },
  success: OpenResult,
  error: RunbookUnreadable,
}) {}

export class CloseSession extends Rpc.make("CloseSession", {
  payload: session,
  error: SessionError,
}) {}

/**
 * The sessions open in the engine, in the order it opened them: the last
 * is the one opened last. Opening a runbook that is already open opens
 * another session of it, which comes last.
 */
export class ListSessions extends Rpc.make("ListSessions", {
  success: Schema.Array(SessionSummary),
}) {}

export class GetSession extends Rpc.make("GetSession", {
  payload: session,
  success: SessionView,
  error: SessionError,
}) {}

/**
 * The session's runbook as a window renders it: its markdown, and each
 * block's place, props and configuration errors. It is as large as the
 * runbook and does not change while the session is open, so a client asks
 * once, where `GetSession` is asked after every change.
 */
export class GetDocument extends Rpc.make("GetDocument", {
  payload: session,
  success: DocumentView,
  error: SessionError,
}) {}

/** Person only. `hash` is the one the person was shown. */
export class TrustSession extends Rpc.make("TrustSession", {
  payload: { ...session, hash: ContentHash },
  success: TrustResult,
  error: Schema.Union([UnknownSession, Forbidden]),
}) {}

/**
 * Every event after `after`, then each new one as it happens. Ends when the
 * session closes. `after` is a sequence the session has logged: a later one
 * is `UnknownSequence`. The session keeps its last `LIMITS.keptEvents`
 * events, so an older `after` (or none) starts from the oldest it keeps, and
 * the jump in `sequence` shows what was dropped.
 */
export class Events extends Rpc.make("Events", {
  payload: { ...session, after: Schema.optionalKey(Sequence) },
  success: EventEnvelope,
  error: Schema.Union([UnknownSession, UnknownSequence]),
  stream: true,
}) {}

export class GetBlock extends Rpc.make("GetBlock", {
  payload: {
    ...block,
    logOffset: Schema.optionalKey(LogOffset),
    logLimit: Schema.optionalKey(LogLimit),
  },
  success: BlockView,
  error: BlockError,
}) {}

/** Enters values in a form, or a task's own form, as if typed. Counts as reviewed for an agent. */
export class SetValues extends Rpc.make("SetValues", {
  payload: { ...block, values: Schema.Record(Schema.String, FieldValue) },
  success: SetValuesResult,
  error: ClassError,
}) {}

/** An agent accepts a form's values as shown, defaults included. */
export class ConfirmValues extends Rpc.make("ConfirmValues", {
  payload: block,
  success: Schema.Array(FieldView),
  error: ClassError,
}) {}

/** Runs a task or submits a form: the block's main button. */
export class RunBlock extends Rpc.make("RunBlock", {
  payload: block,
  success: RunResult,
  error: ClassError,
}) {}

export class CancelBlock extends Rpc.make("CancelBlock", {
  payload: block,
  success: CancelResult,
  error: ClassError,
}) {}

/** Back to idle: start over, create another. Withdraws the block's outputs. */
export class ResetBlock extends Rpc.make("ResetBlock", {
  payload: block,
  error: ClassError,
}) {}

/** Returns once the block is not running or awaiting approval, or after `timeoutMillis`. */
export class WaitForBlock extends Rpc.make("WaitForBlock", {
  payload: {
    ...block,
    timeoutMillis: Schema.optionalKey(
      Schema.Int.check(
        Schema.isGreaterThanOrEqualTo(1),
        Schema.isLessThanOrEqualTo(LIMITS.maxWaitMillis),
      ),
    ),
    logOffset: Schema.optionalKey(LogOffset),
    logLimit: Schema.optionalKey(LogLimit),
  },
  success: Schema.Struct({ block: BlockView, timedOut: Schema.Boolean }),
  error: BlockError,
}) {}

/** Every block's outputs so far, by block id. Sensitive ones are `Hidden`. */
export class GetOutputs extends Rpc.make("GetOutputs", {
  payload: session,
  success: Schema.Record(Schema.String, Schema.Record(Schema.String, OutputView)),
  error: SessionError,
}) {}

export class ActOnCredential extends Rpc.make("ActOnCredential", {
  payload: { ...block, action: CredentialAction },
  success: ActResult,
  error: ClassError,
}) {}

/** Person only. */
export class ResolveApproval extends Rpc.make("ResolveApproval", {
  payload: { ...session, approval: ApprovalId, approve: Schema.Boolean },
  error: Schema.Union([UnknownSession, UnknownApproval, Forbidden]),
}) {}

export class GetSettings extends Rpc.make("GetSettings", {
  success: SettingsView,
}) {}

/**
 * Person only. Sets each setting `changes` names, and no other. A setting
 * the protocol does not have fails the decode, naming it, as does a value
 * the setting does not take.
 */
export class ChangeSettings extends Rpc.make("ChangeSettings", {
  payload: { changes: SettingsChange },
  success: ChangeSettingsResult,
  error: Schema.Union([Forbidden, SettingsNotSaved]),
}).annotate(Rpc.ParseOptions, { onExcessProperty: "error", errors: "all" }) {}

/**
 * The settings now, then again after each change. A reader that falls
 * behind gets the latest, not each one. Ends when the engine stops.
 */
export class WatchSettings extends Rpc.make("WatchSettings", {
  success: SettingsView,
  stream: true,
}) {}

export const EngineProtocol = RpcGroup.make(
  OpenSession,
  CloseSession,
  ListSessions,
  GetSession,
  GetDocument,
  TrustSession,
  Events,
  GetBlock,
  SetValues,
  ConfirmValues,
  RunBlock,
  CancelBlock,
  ResetBlock,
  WaitForBlock,
  GetOutputs,
  ActOnCredential,
  ResolveApproval,
  GetSettings,
  ChangeSettings,
  WatchSettings,
).middleware(CallerMiddleware)
export type EngineCommand = RpcGroup.Rpcs<typeof EngineProtocol>

/** A client of the engine, as every transport gives one. */
export type EngineClient = RpcClient.RpcClient<EngineCommand, RpcClientError.RpcClientError>

/**
 * Open decision 12: the MCP baseline is the in-app server's ten tools. Each
 * maps to the command that serves it; the MCP client (phase 3) keeps the
 * tool names and result shapes the baseline e2e spec checks. Under the
 * alternative, the CLI server's ten (open_runbook, get_runbook, run_all,
 * skip_block, close_runbook and five shared names), this table changes and
 * `run_all` and `skip_block` need commands.
 */
export const BASELINE_MCP_TOOLS = {
  list_sessions: "ListSessions",
  get_session: "GetSession",
  get_block: "GetBlock",
  set_inputs: "SetValues",
  confirm_inputs: "ConfirmValues",
  run_block: "RunBlock",
  act_on_block: "ActOnCredential",
  wait_for_block: "WaitForBlock",
  cancel_block: "CancelBlock",
  get_outputs: "GetOutputs",
} as const satisfies Record<string, EngineCommand["_tag"]>
