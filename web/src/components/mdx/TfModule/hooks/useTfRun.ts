import { useEffect, useReducer, useRef } from "react"
import { useApi } from "@/contexts/ApiContext"
import { cleanIpcErrorMessage } from "@/lib/ipcError"
import type { TfModuleCodeRef, TfModuleRepo } from "../../../../../../electron/shared/channels"
import { inputsKey, type ApplyResult } from "../../../../../../src/domain/tf-module/run"
import { INITIAL_RUN, runReducer, runStatus } from "../runMachine"

const message = (err: unknown) =>
  cleanIpcErrorMessage(err instanceof Error ? err.message : String(err))

let runSeq = 0

/**
 * Plans and applies a block's code in the main process, keeping
 * the run's state (see runMachine) and what it means for the inputs as they
 * are now.
 */
export function useTfRun(
  blockId: string,
  module: TfModuleCodeRef,
  values: Record<string, unknown>,
  /** The repository the code runs in, when there is one. */
  repo?: TfModuleRepo,
) {
  const api = useApi()
  const [state, dispatch] = useReducer(runReducer, INITIAL_RUN)
  const current = useRef<{ id: string; stopping: boolean } | null>(null)
  const unsubscribe = useRef<(() => void) | null>(null)

  useEffect(
    () => () => {
      unsubscribe.current?.()
      if (current.current) void api.invoke("tf-module:cancel", { runId: current.current.id })
    },
    [api],
  )

  /** Runs one step in the main process, streaming its events into the state. */
  const start = async <T>(call: (runId: string) => Promise<T>): Promise<T | undefined> => {
    const run = { id: `${blockId}-${++runSeq}`, stopping: false }
    current.current = run
    unsubscribe.current?.()
    unsubscribe.current = api.on("tf-module:event", ({ runId, event, at }) => {
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

  const request = (runId: string) => ({ ...module, runId, blockId, values, repo })

  const plan = async () => {
    dispatch({ type: "plan-started", inputs: inputsKey(values) })
    const result = await start((runId) => api.invoke("tf-module:plan", request(runId)))
    if (result) dispatch({ type: "planned", plan: result })
  }

  const apply = async (): Promise<ApplyResult | undefined> => {
    dispatch({ type: "apply-started" })
    const result = await start((runId) => api.invoke("tf-module:apply", request(runId)))
    if (result) dispatch({ type: "applied", result })
    return result
  }

  const cancel = () => {
    const run = current.current
    if (!run) return
    run.stopping = true
    void api.invoke("tf-module:cancel", { runId: run.id })
  }

  return { state, status: runStatus(state.phase, inputsKey(values)), plan, apply, cancel }
}
