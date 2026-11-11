import { useEffect, useState } from "react"
import { useApi } from "@/contexts/ApiContext"
import { useSimulation } from "@/contexts/useSimulation"
import { cleanIpcErrorMessage } from "@/lib/ipcError"
import { useGoogleSignIns } from "./useGoogleSignIns"
import type { TfModuleReadiness } from "../../../../../../electron/shared/channels"

export interface ReadinessState {
  readiness?: TfModuleReadiness | undefined
  /** Why the check couldn't run at all. */
  error?: string | undefined
  checking: boolean
  recheck: () => void
}

/**
 * Whether the block has what it needs outside its inputs: its Google APIs on
 * in the signed-in project, and the commands its code runs with. Checks again
 * when a GoogleAuth block signs in or changes project, when the simulation's
 * answers change, when the window comes back into focus, since that's when
 * someone has turned an API on or installed a tool, and on `recheck`.
 */
export function useReadiness(services: readonly string[], template: string): ReadinessState {
  const api = useApi()
  const { revision } = useSimulation()
  const signIns = useGoogleSignIns()
  const [attempt, setAttempt] = useState(0)
  const [answer, setAnswer] = useState<
    { key: string; readiness?: TfModuleReadiness; error?: string } | undefined
  >(undefined)

  const serviceList = services.join(",")
  const key = JSON.stringify([serviceList, template, revision, signIns, attempt])

  useEffect(() => {
    let cancelled = false
    api
      .invoke("tf-module:readiness", { services: serviceList.split(",").filter(Boolean), template })
      .then((readiness) => {
        if (!cancelled) setAnswer({ key, readiness })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        setAnswer({ key, error: cleanIpcErrorMessage(message) })
      })
    return () => {
      cancelled = true
    }
  }, [api, serviceList, template, key])

  useEffect(() => {
    const onFocus = () => setAttempt((n) => n + 1)
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [])

  return {
    readiness: answer?.readiness,
    error: answer?.error,
    checking: answer?.key !== key,
    recheck: () => setAttempt((n) => n + 1),
  }
}
