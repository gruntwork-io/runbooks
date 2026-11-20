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
}

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
}

export interface AgentBlockDetail extends AgentBlockSummary {
  /** Lines of the latest run's log from `logOffset`, at most `logLimit`. */
  logs?: string[] | undefined
  /** Index of the first line in `logs`. */
  logOffset?: number | undefined
  /** How many log lines the run has so far. Ask again from here for more. */
  logTotal?: number | undefined
  /** The latest run's outputs; sensitive ones are `<redacted>`. */
  outputs?: Record<string, string> | undefined
  error?: string | undefined
  exitCode?: number | null | undefined
  /** For Inputs and Template blocks: the form's fields. */
  inputs?: AgentInputVariable[] | undefined
  /** What the user has to do for a block an agent can't run. */
  note?: string | undefined
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
  | { op: "run_block"; blockId: string }
  | { op: "cancel_block"; blockId: string }
  | { op: "get_outputs" }

export type AgentRunResult = { started: true } | { started: false; reason: string }

export interface AgentSetInputsResult {
  /** Field errors after the values were entered, by variable name. */
  errors: Record<string, string>
  /** Values that weren't entered, and why (unknown or read-only field). */
  rejected: Record<string, string>
}

/** The answer to each request's op. */
export interface AgentResponseMap {
  get_session: AgentSession
  get_block: AgentBlockDetail
  set_inputs: AgentSetInputsResult
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
