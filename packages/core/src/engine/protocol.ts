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
 */
import { Context, Schema } from "effect"
import { Rpc, RpcGroup, RpcMiddleware } from "effect/rpc"
import { BlockClass, BlockId } from "@runbooks/blocks-core/contract"
import { FieldType, FieldValue, Validation } from "@runbooks/blocks-core/form"
import { Blocker, BlockStatus } from "@runbooks/blocks-core/status"
import { CredentialAction, CredentialState } from "../credential/lifecycle.ts"
import { ConfigError, ConfigWarning } from "../document/configError.ts"
import { ContentHash } from "../document/document.ts"

// ---------------------------------------------------------------------------
// Identifiers and limits
// ---------------------------------------------------------------------------

export const SessionId = Schema.NonEmptyString.pipe(Schema.brand("SessionId"))
export type SessionId = typeof SessionId.Type

export const RunId = Schema.NonEmptyString.pipe(Schema.brand("RunId"))
export type RunId = typeof RunId.Type

export const ApprovalId = Schema.NonEmptyString.pipe(Schema.brand("ApprovalId"))
export type ApprovalId = typeof ApprovalId.Type

/** An event's place in its session's log, from 0. A client resumes with the last one it saw. */
export const Sequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const LIMITS = {
  /** Log lines a read returns when it does not say. */
  defaultLogLimit: 200,
  maxLogLimit: 5000,
  /** `WaitForBlock` waits at most this long in one call, inside MCP clients' tool timeouts. */
  maxWaitMillis: 120_000,
  defaultWaitMillis: 30_000,
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

export const BlockView = Schema.Struct({
  ...BlockSummary.fields,
  log: Schema.optionalKey(LogPage),
  outputs: Schema.Record(Schema.String, OutputView),
  /** A form block's fields, or a task's own form. */
  fields: Schema.optionalKey(Schema.Array(FieldView)),
  credential: Schema.optionalKey(CredentialState),
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

export const SessionView = Schema.Struct({
  ...SessionSummary.fields,
  trust: TrustState,
  blocks: Schema.Array(BlockSummary),
  warnings: Schema.Array(ConfigWarning),
})
export type SessionView = typeof SessionView.Type

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

export const ActResult = Schema.Union([
  Schema.TaggedStruct("Accepted", {}),
  Schema.TaggedStruct("AwaitingApproval", { approval: ApprovalId }),
  /** The block's credential state does not take that action. */
  Schema.TaggedStruct("NotAllowed", { state: Schema.String }),
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
// Faults
// ---------------------------------------------------------------------------

export class UnknownSession extends Schema.TaggedError<UnknownSession>()("UnknownSession", {
  session: Schema.String,
}) {}

export class UnknownBlock extends Schema.TaggedError<UnknownBlock>()("UnknownBlock", {
  session: SessionId,
  block: Schema.String,
}) {}

/** The command does not apply to the block's class: running a display block, signing in to a task. */
export class WrongClass extends Schema.TaggedError<WrongClass>()("WrongClass", {
  block: BlockId,
  class: BlockClass,
  expected: Schema.Array(BlockClass),
}) {}

/** The caller's origin may not send this command: an agent trusting a session or answering an approval. */
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
  Schema.TaggedStruct("FilesChanged", {
    block: BlockId,
    files: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        change: Schema.Literals(["created", "modified", "deleted"]),
      }),
    ),
  }),
  Schema.TaggedStruct("CredentialChanged", { block: BlockId, state: CredentialState }),
  Schema.TaggedStruct("ApprovalRequested", { approval: Approval }),
  Schema.TaggedStruct("ApprovalResolved", { approval: ApprovalId, approved: Schema.Boolean }),
  Schema.TaggedStruct("Warning", { warning: ConfigWarning }),
  Schema.TaggedStruct("SessionClosed", {}),
])
export type EngineEvent = typeof EngineEvent.Type

export const EventEnvelope = Schema.Struct({
  session: SessionId,
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
  payload: { path: Schema.NonEmptyString },
  success: OpenResult,
  error: RunbookUnreadable,
}) {}

export class CloseSession extends Rpc.make("CloseSession", {
  payload: session,
  error: SessionError,
}) {}

export class ListSessions extends Rpc.make("ListSessions", {
  success: Schema.Array(SessionSummary),
}) {}

export class GetSession extends Rpc.make("GetSession", {
  payload: session,
  success: SessionView,
  error: SessionError,
}) {}

/** Person only. `hash` is the one the person was shown. */
export class TrustSession extends Rpc.make("TrustSession", {
  payload: { ...session, hash: ContentHash },
  success: TrustResult,
  error: Schema.Union([UnknownSession, Forbidden]),
}) {}

/** Every event after `after`, then each new one as it happens. Ends when the session closes. */
export class Events extends Rpc.make("Events", {
  payload: { ...session, after: Schema.optionalKey(Sequence) },
  success: EventEnvelope,
  error: SessionError,
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

export const EngineProtocol = RpcGroup.make(
  OpenSession,
  CloseSession,
  ListSessions,
  GetSession,
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
).middleware(CallerMiddleware)
export type EngineCommand = RpcGroup.Rpcs<typeof EngineProtocol>

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
