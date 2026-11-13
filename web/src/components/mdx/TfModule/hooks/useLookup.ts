import { useEffect, useState } from "react"
import { cleanIpcErrorMessage } from "@/lib/ipcError"
import type { Row, Use } from "../../../../../../src/domain/lookups/types"
import { matchesQuery } from "../lookupRows"
import { useLookupEngineContext } from "../../_shared/hooks/useLookupEngine"

/** How long typing pauses before the lookup asks again. */
const DEBOUNCE_MS = 200

interface Answer {
  /** The request it answers: the use, what was typed, and what the use depends on. */
  key: string
  rows: readonly Row[]
  error?: string
}

interface LookupState {
  rows: readonly Row[]
  error?: string | undefined
  loading: boolean
}

/**
 * The rows the lookup `use` names has for what the user typed. Asks only while
 * `active` (the user is searching), and again when a bound auth block signs in
 * or an input the lookup reads changes. A lookup that doesn't send what's
 * typed runs once, and its rows are filtered here. Until the newest request
 * is answered, it keeps the last answer's rows and reports loading.
 */
export function useLookup(use: Use | undefined, query: string, active: boolean): LookupState {
  const engine = useLookupEngineContext()
  const [answer, setAnswer] = useState<Answer | undefined>(undefined)
  const sendsQuery = use && engine ? engine.readsQuery(use) : false
  const asked = sendsQuery ? query : ""
  const key = use && engine ? JSON.stringify([engine.keyOf(use), asked]) : ""

  useEffect(() => {
    if (!use || !engine || !active) return
    let cancelled = false
    const timer = setTimeout(
      () => {
        engine
          .run(use, asked)
          .then(({ rows }) => {
            if (!cancelled) setAnswer({ key, rows })
          })
          .catch((err: unknown) => {
            if (cancelled) return
            const message = err instanceof Error ? err.message : String(err)
            setAnswer({ key, rows: [], error: cleanIpcErrorMessage(message) })
          })
      },
      sendsQuery ? DEBOUNCE_MS : 0,
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // Asks again when the key changes, which covers the use, the engine and what's typed.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key, active])

  const rows = answer?.rows ?? []
  return {
    rows: sendsQuery ? rows : rows.filter((row) => matchesQuery(row, query)),
    error: answer?.error,
    loading: Boolean(use && engine) && active && answer?.key !== key,
  }
}
