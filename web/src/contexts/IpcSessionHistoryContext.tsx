import { useMemo, useState, type ReactNode } from "react"
import { useApi } from "./ApiContext"
import { SessionHistoryContext, type SessionHistory } from "./SessionHistoryContext.types"
import { errorMessage } from "../../../src/errors/message"
import type { SavedBlockState, SessionEventKind } from "../../../src/domain/session/history"

interface IpcSessionHistoryProviderProps {
  /** The session the runbook was opened in. Undefined while no runbook is loaded. */
  sessionId: string | undefined
  /** What the session's history said each block was left as when the runbook loaded */
  blockStates: SavedBlockState[] | undefined
  children: ReactNode
}

/**
 * Gives the runbook's blocks their session's history: each event a block
 * records goes to the main process, which saves it.
 *
 * The provider also keeps every block's latest state itself, starting from
 * `blockStates`. A block that remounts while the session is open (a
 * watch-mode reload, a switch to or from instruction mode) resumes from that,
 * including where the main process could not save the event.
 *
 * Mount one per session, keyed by it: a later `blockStates` is ignored.
 */
export function IpcSessionHistoryProvider({
  sessionId,
  blockStates,
  children,
}: IpcSessionHistoryProviderProps) {
  const api = useApi()
  const [states] = useState(
    () =>
      new Map(
        (blockStates ?? []).map((state) => [stateKey(state.blockId, state.kind), state.payload]),
      ),
  )

  const history = useMemo<SessionHistory>(
    () => ({
      saved: (blockId, kind) => states.get(stateKey(blockId, kind)),
      record: (blockId, kind, payload) => {
        states.set(stateKey(blockId, kind), payload)
        if (sessionId === undefined) return
        api.invoke("session:record-event", { sessionId, blockId, kind, payload }).catch((err) => {
          // The payload stays out of the console: it can hold credentials.
          console.warn(
            `Could not save the ${kind} of block "${blockId}" to the session's history:`,
            errorMessage(err),
          )
        })
      },
    }),
    [api, sessionId, states],
  )

  return <SessionHistoryContext.Provider value={history}>{children}</SessionHistoryContext.Provider>
}

// A kind has no line break, so no two pairs share a key.
function stateKey(blockId: string, kind: SessionEventKind): string {
  return `${kind}\n${blockId}`
}
