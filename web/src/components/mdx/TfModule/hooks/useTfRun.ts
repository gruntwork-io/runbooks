import { useCallback, useEffect, useRef, useState } from "react"
import { useApi } from "@/contexts/ApiContext"
import { cleanIpcErrorMessage } from "@/lib/ipcError"
import type { TfModuleRepo } from "../../../../../../electron/shared/channels"
import type {
  ApplyResult,
  PlanResult,
  ResourceProgress,
  RunEvent,
} from "../../../../../../src/domain/tf-module/run"

export type RunStep = Extract<RunEvent, { kind: "step" }>["step"]

export interface LogLine {
  readonly line: string
  readonly level?: "error" | "warn" | undefined
}

export interface RunState {
  readonly phase: "idle" | "planning" | "planned" | "applying" | "applied" | "failed"
  /** What Terragrunt is doing now. */
  readonly step?: RunStep | undefined
  readonly log: readonly LogLine[]
  /** Each resource's progress in an apply, by address. */
  readonly progress: Readonly<Record<string, { progress: ResourceProgress; elapsed?: number }>>
  readonly plan?: PlanResult | undefined
  readonly result?: ApplyResult | undefined
  readonly error?: string | undefined
  /** Which step failed. */
  readonly failed?: "plan" | "apply" | undefined
  /** The inputs the plan was made with, as JSON, so a change shows it's stale. */
  readonly plannedWith?: string | undefined
}

const IDLE: RunState = { phase: "idle", log: [], progress: {} }

const message = (err: unknown) =>
  cleanIpcErrorMessage(err instanceof Error ? err.message : String(err))

let runSeq = 0

/**
 * Plans and applies a block's Terragrunt code in the main process, and keeps
 * what the Apply tab shows: the step, the log, each resource's progress, the
 * plan, and what the apply made.
 */
export function useTfRun(
  blockId: string,
  source: string,
  values: Record<string, unknown>,
  /** The repository the code runs in, when there is one. */
  repo?: TfModuleRepo,
) {
  const api = useApi()
  const [state, setState] = useState<RunState>(IDLE)
  const runId = useRef<string | null>(null)
  const unsubscribe = useRef<(() => void) | null>(null)

  const listen = useCallback(
    (id: string) => {
      unsubscribe.current?.()
      unsubscribe.current = api.on("tf-module:event", ({ runId: from, event }) => {
        if (from !== id) return
        setState((prev) => {
          switch (event.kind) {
            case "step":
              return { ...prev, step: event.step }
            case "log":
              return { ...prev, log: [...prev.log, { line: event.line, level: event.level }] }
            case "resource":
              return {
                ...prev,
                progress: {
                  ...prev.progress,
                  [event.address]: {
                    progress: event.progress,
                    ...(event.elapsedSeconds !== undefined
                      ? { elapsed: event.elapsedSeconds }
                      : {}),
                  },
                },
              }
          }
        })
      })
    },
    [api],
  )

  useEffect(
    () => () => {
      unsubscribe.current?.()
      if (runId.current) void api.invoke("tf-module:cancel", { runId: runId.current })
    },
    [api],
  )

  const start = () => {
    const id = `${blockId}-${++runSeq}`
    runId.current = id
    listen(id)
    return id
  }

  const plan = async () => {
    const id = start()
    const plannedWith = JSON.stringify(values)
    setState({ phase: "planning", log: [], progress: {}, plannedWith })
    try {
      const result = await api.invoke("tf-module:plan", {
        runId: id,
        blockId,
        source,
        values,
        repo,
      })
      if (runId.current !== id) return
      setState((prev) => ({ ...prev, phase: "planned", step: undefined, plan: result }))
    } catch (err) {
      if (runId.current !== id) return
      setState((prev) => ({ ...prev, phase: "failed", failed: "plan", error: message(err) }))
    }
  }

  const apply = async (): Promise<ApplyResult | undefined> => {
    const id = start()
    setState((prev) => ({
      ...prev,
      phase: "applying",
      progress: Object.fromEntries(
        (prev.plan?.resources ?? []).map((r) => [r.address, { progress: "waiting" as const }]),
      ),
    }))
    try {
      const result = await api.invoke("tf-module:apply", {
        runId: id,
        blockId,
        source,
        values,
        repo,
      })
      if (runId.current !== id) return undefined
      setState((prev) => ({ ...prev, phase: "applied", step: undefined, result }))
      return result
    } catch (err) {
      if (runId.current !== id) return undefined
      setState((prev) => ({ ...prev, phase: "failed", failed: "apply", error: message(err) }))
      return undefined
    }
  }

  const cancel = () => {
    if (runId.current) void api.invoke("tf-module:cancel", { runId: runId.current })
  }

  const stale =
    state.plannedWith !== undefined &&
    state.phase === "planned" &&
    state.plannedWith !== JSON.stringify(values)

  const applied = state.phase === "applied" && state.plannedWith === JSON.stringify(values)

  return { state, plan, apply, cancel, stale, applied }
}
