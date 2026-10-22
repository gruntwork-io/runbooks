import { createContext } from "react"
import type { SessionEventKind } from "../../../src/domain/session/history"

/** The open session's history, as the runbook's blocks use it. */
export interface SessionHistory {
  /**
   * What the block was left as: the payload of its latest `kind` event, or
   * undefined when it has none. Parse it before use (lib/sessionHistory.ts).
   */
  saved: (blockId: string, kind: SessionEventKind) => unknown
  /**
   * Add what the user just did to the block. `payload` is the block's state
   * after it, as JSON.
   */
  record: (blockId: string, kind: SessionEventKind, payload: unknown) => void
  /**
   * Mark the session finished: a <Finish> block finished its runbook. Opening
   * the runbook again starts a new session.
   */
  finish: () => void
}

/** The history of a block rendered outside a session: nothing saved, nothing kept. */
export const noSessionHistory: SessionHistory = {
  saved: () => undefined,
  record: () => {},
  finish: () => {},
}

export const SessionHistoryContext = createContext<SessionHistory>(noSessionHistory)
