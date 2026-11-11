import { useEffect, useReducer, useRef } from "react"
import { useApi } from "@/contexts/ApiContext"
import { cleanIpcErrorMessage } from "@/lib/ipcError"
import type { TerragruntApplyRequest } from "../../../../../../electron/shared/channels"
import type { ApplyResult } from "../../../../../../src/domain/terragrunt/run"
import { INITIAL_RUN, runReducer, runStatus } from "../runMachine"

const message = (err: unknown) =>
  cleanIpcErrorMessage(err instanceof Error ? err.message : String(err))

let runSeq = 0

/**
 * Plans and applies a block's unit in the main process, keeping the run's
 * state (see runMachine) and what it means for the unit as it is now: its
 * clone and path, as `unitKey`.
 */
export function useTerragruntRun(request: TerragruntApplyRequest, unitKey: string) {
  const api = useApi()
  const [state, dispatch] = useReducer(runReducer, INITIAL_RUN)
  const current = useRef<{ id: string; stopping: boolean } | null>(null)
  const unsubscribe = useRef<(() => void) | null>(null)

  useEffect(
    () => () => {
      unsubscribe.current?.()
      if (current.current) {
        void api.invoke("terragrunt-apply:cancel", { runId: current.current.id })
      }
    },
    [api],
  )

  /** Runs one step in the main process, streaming its events into the state. */
  const start = async <T>(call: (runId: string) => Promise<T>): Promise<T | undefined> => {
    const run = { id: `${request.blockId}-${++runSeq}`, stopping: false }
    current.current = run
    unsubscribe.current?.()
    unsubscribe.current = api.on("terragrunt-apply:event", ({ runId, event, at }) => {
      if (runId === run.id) dispatch({ type: "event", event, at })
    })
    try {
      const result = await call(run.id)
      return current.current === run ? result : undefined
    } catch (err) {
      if (current.current === run) {
        dispatch(run.stopping ? { type: "stopped" } : { type: "failed", error: message(err) })
      }
      return undefined
    }
  }

  const plan = async () => {
    dispatch({ type: "plan-started", inputs: unitKey })
    const result = await start((runId) =>
      api.invoke("terragrunt-apply:plan", { ...request, runId }),
    )
    if (result) dispatch({ type: "planned", plan: result })
  }

  const apply = async (): Promise<ApplyResult | undefined> => {
    dispatch({ type: "apply-started" })
    const result = await start((runId) =>
      api.invoke("terragrunt-apply:apply", { ...request, runId }),
    )
    if (result) dispatch({ type: "applied", result })
    return result
  }

  const cancel = () => {
    const run = current.current
    if (!run) return
    run.stopping = true
    void api.invoke("terragrunt-apply:cancel", { runId: run.id })
  }

  return { state, status: runStatus(state.phase, unitKey), plan, apply, cancel }
}
