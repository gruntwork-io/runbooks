import { createContext, type RefObject } from "react"
import type {
  AgentActResult,
  AgentActionSpec,
  AgentBlockDetail,
  AgentBlockStatus,
  AgentRunResult,
  AgentSetInputsResult,
} from "../../../src/domain/agent/protocol"

/**
 * What a block lets an AI agent see and do, through the app's MCP server.
 * Each method acts as the block's own UI does: run() is its Run (or
 * Generate) button, setInputs() types into its form.
 */
export interface AgentBlockAdapter {
  type: string
  title?: string | undefined
  status: () => AgentBlockStatus
  /** Why the block's button is disabled; empty when it isn't. */
  blockedBy: () => string[]
  /** The rest of get_block's answer: logs from `logOffset`, outputs, fields. */
  detail: (logOffset: number, logLimit: number) => Partial<AgentBlockDetail>
  run?: () => AgentRunResult
  /** False when `run` is only the stand-in useAgentBlock puts in for a block without a Run button. */
  canRun?: boolean | undefined
  /** Whether run() runs a script or writes files, so the user may want to approve it first. */
  runIsAction?: boolean | undefined
  cancel?: () => boolean
  /** The Inputs and Template blocks whose values this block reads (for a form, the ones it imports). */
  readsForms?: () => string[]
  /** What act_on_block can do to the block now: its buttons, pickers and fields. */
  actions?: () => AgentActionSpec[]
  /** Do one of `actions()`, through the handler the block's own control uses. */
  act?: (
    action: string,
    params: Record<string, unknown>,
  ) => AgentActResult | Promise<AgentActResult>
  /** What the person at the window has to do before the block can go on, if anything. */
  needsHuman?: () => string | undefined
  setInputs?: (values: Record<string, unknown>) => AgentSetInputsResult
}

export interface AgentBridgeContextType {
  /** Make a block controllable by agents. Returns the function that removes it. */
  registerBlock: (id: string, adapter: AgentBlockAdapter) => () => void
  /** Note a block on the page, controllable or not. Returns the function that removes it. */
  registerPresence: (
    id: string,
    type: string,
    element: RefObject<HTMLElement | null> | undefined,
  ) => () => void
  /** Where get_outputs reads every block's outputs from. Returns the function that removes it. */
  registerOutputs: (read: () => Record<string, Record<string, string>>) => () => void
}

export const AgentBridgeContext = createContext<AgentBridgeContextType | undefined>(undefined)
