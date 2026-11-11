import { useEffect, useState } from "react"
import { useApi } from "@/contexts/ApiContext"
import { useSimulation } from "@/contexts/useSimulation"
import { cleanIpcErrorMessage } from "@/lib/ipcError"
import { useGoogleSignIns } from "./useGoogleSignIns"
import type { LookupRow } from "../../../../../../src/domain/tf-module/rowTemplate"

/** How long typing pauses before the lookup asks again. */
const DEBOUNCE_MS = 200

interface Answer {
  /** The request it answers: the lookup, what was typed, the simulation's revision, and who's signed in. */
  key: string
  rows: readonly LookupRow[]
  error?: string
}

interface LookupState {
  rows: readonly LookupRow[]
  error?: string | undefined
  loading: boolean
}

/**
 * The rows a named lookup has for what the user typed. Asks only while
 * `active` (the user is searching), and again when the simulation's answers
 * change or someone signs in to Google. Until the newest request is answered, it keeps the last answer's
 * rows and reports loading.
 */
export function useLookup(from: string | undefined, query: string, active: boolean): LookupState {
  const api = useApi()
  const { revision } = useSimulation()
  const [answer, setAnswer] = useState<Answer | undefined>(undefined)
  const signIns = useGoogleSignIns()
  const key = JSON.stringify([from, query, revision, signIns])

  useEffect(() => {
    if (!from || !active) return
    let cancelled = false
    const timer = setTimeout(() => {
      api
        .invoke("tf-module:lookup", { from, query })
        .then(({ rows }) => {
          if (!cancelled) setAnswer({ key, rows })
        })
        .catch((err: unknown) => {
          if (cancelled) return
          const message = err instanceof Error ? err.message : String(err)
          setAnswer({ key, rows: [], error: cleanIpcErrorMessage(message) })
        })
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [api, from, query, active, key])

  return {
    rows: answer?.rows ?? [],
    error: answer?.error,
    loading: Boolean(from) && active && answer?.key !== key,
  }
}
