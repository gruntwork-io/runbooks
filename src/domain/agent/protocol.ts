/**
 * What the app's MCP server (electron/main/agent/) asks the renderer, and
 * what the renderer answers. The renderer holds the runbook's live state, so
 * every tool call that reads or changes a block becomes one of these requests
 * (`agent:request`), answered with `agent:respond`.
 */

/** A block's state as the window shows it. */
export type AgentBlockStatus =
  | "pending"
  | "running"
  | "success"
  | "warn"
  | "fail"
  | "generated"
  | "submitted"
  | "not_controllable"

export interface AgentBlockSummary {
  id: string
  type: string
  title?: string | undefined
  status: AgentBlockStatus
  /** Why the window's Run (or Generate) button is disabled. Empty when it isn't. */
  blockedBy: string[]
  /** Whether an agent can run or fill the block; false for blocks that need the user. */
  controllable: boolean
  /** For a form: some of its fields haven't been set or confirmed by the agent. */
  needsReview?: boolean | undefined
  /** What the person at the window has to do before the block can go on (a browser sign-in, MFA, a page). */
  needsHuman?: string | undefined
}

/** A parameter of an action, as get_block describes it. */
export interface AgentActionParam {
  type: "string" | "boolean" | "number" | "string[]"
  description: string
  required?: boolean | undefined
}

/** Something an agent can do to a block with act_on_block: one of its buttons, pickers or fields. */
export interface AgentActionSpec {
  name: string
  description: string
  params?: Record<string, AgentActionParam> | undefined
  /**
   * The action runs something or changes something outside the window (signs
   * in, clones, pushes, opens a pull request), so the window may ask the user first.
   */
  changes: boolean
  /** Why the action can't be used now; absent when it can. */
  unavailable?: string | undefined
}

export type AgentActResult = { ok: true; note?: string | undefined } | { ok: false; reason: string }

export interface AgentInputVariable {
  name: string
  type: string
  description?: string | undefined
  required?: boolean | undefined
  sensitive?: boolean | undefined
  options?: string[] | undefined
  /** The field's value; a sensitive one is `<redacted>`. */
  value: unknown
  /** The field is read-only in the form (imported from another block, or locked). */
  readOnly?: boolean | undefined
  error?: string | undefined
  /** The runbook's default; a sensitive one is left out. */
  default?: unknown
  validations?: Array<{ type: string; args?: unknown[] | undefined }> | undefined
  /** The agent set or confirmed this field. A default nobody looked at is unreviewed. */
  reviewed?: boolean | undefined
}

/** A form an agent has to review before a block that reads it runs. */
export interface AgentFormReview {
  form: string
  type: string
  fields: AgentInputVariable[]
  /** The fields not yet set or confirmed. */
  unreviewed: string[]
  message: string
}

export interface AgentBlockDetail extends AgentBlockSummary {
  /** Lines of the latest run's log from `logOffset`, at most `logLimit`. */
  logs?: string[] | undefined
  /** Index of the first line in `logs`. */
  logOffset?: number | undefined
  /** How many log lines the run has so far. */
  logTotal?: number | undefined
  /** Where the next page of log lines starts: logOffset + logs.length. */
  nextLogOffset?: number | undefined
  /** The session the block belongs to. */
  sessionId?: string | undefined
  /** The latest run's outputs; sensitive ones are `<redacted>`. */
  outputs?: Record<string, string> | undefined
  error?: string | undefined
  exitCode?: number | null | undefined
  /** For Inputs and Template blocks: the form's fields. */
  inputs?: AgentInputVariable[] | undefined
  /** What the user has to do for a block an agent can't run. */
  note?: string | undefined
  /** What act_on_block can do to the block now. */
  actions?: AgentActionSpec[] | undefined
  /** Block-specific state: the signed-in account, the cloned path, the pull request's URL, pickers' choices. */
  state?: Record<string, unknown> | undefined
}

export interface AgentSession {
  open: boolean
  runbook?: string | undefined
  runbookPath?: string | undefined
  sessionName?: string | undefined
  sessionId?: string | undefined
  blocks: AgentBlockSummary[]
}

export type AgentRequest =
  | { op: "get_session" }
  | { op: "get_block"; blockId: string; logOffset?: number; logLimit?: number }
  | { op: "set_inputs"; blockId: string; values: Record<string, unknown> }
  | { op: "confirm_inputs"; blockId: string }
  | { op: "act_on_block"; blockId: string; action: string; params: Record<string, unknown> }
  | { op: "run_block"; blockId: string }
  | { op: "cancel_block"; blockId: string }
  | { op: "get_outputs" }

export type AgentRunResult =
  | { started: true }
  | { started: false; reason: string; needsReview?: AgentFormReview | undefined }

/**
 * How long the window waits for the user to approve a run an agent asked
 * for. The server waits a little longer for the answer, so an approval can
 * never arrive after the agent was told the request failed.
 */
export const AGENT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000

export interface AgentSetInputsResult {
  /** Field errors after the values were entered, by variable name. */
  errors: Record<string, string>
  /** Values that weren't entered, and why (unknown or read-only field). */
  rejected: Record<string, string>
  /** The form's fields still not set or confirmed. */
  unreviewed?: string[] | undefined
}

/** The answer to each request's op. */
export interface AgentResponseMap {
  get_session: AgentSession
  get_block: AgentBlockDetail
  set_inputs: AgentSetInputsResult
  confirm_inputs: { confirmed: string; fields: AgentInputVariable[] }
  act_on_block: AgentActResult & { block?: AgentBlockSummary | undefined }
  run_block: AgentRunResult
  cancel_block: { cancelled: boolean }
  get_outputs: Record<string, Record<string, string>>
}

/** main → renderer */
export interface AgentRequestEvent {
  requestId: string
  request: AgentRequest
}

/** renderer → main */
export type AgentResponse =
  | { requestId: string; ok: true; result: unknown }
  | { requestId: string; ok: false; error: string }

/** The MCP server's state, as the settings dialog shows it. */
export interface AgentServerStatus {
  enabled: boolean
  /** Ask the user in the window before a run an agent starts. */
  confirmRuns: boolean
  /** Listening at, while enabled. */
  url?: string | undefined
  /** The file holding the request headers for this launch's token. */
  headersFile?: string | undefined
  /** `claude mcp add` command for this launch's token. */
  claudeCommand?: string | undefined
  /** Why the server isn't listening though enabled. */
  error?: string | undefined
}
