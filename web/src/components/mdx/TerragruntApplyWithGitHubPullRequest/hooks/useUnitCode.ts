import { useEffect, useState } from "react"
import { useApi } from "@/contexts/ApiContext"
import { useSimulation } from "@/contexts/useSimulation"
import { cleanIpcErrorMessage } from "@/lib/ipcError"
import type {
  TfModuleCode,
  TfModuleCodeRef,
  TfModuleRepo,
} from "../../../../../../electron/shared/channels"

/** How long the inputs must settle before the code renders again. */
const DEBOUNCE_MS = 300

/**
 * The block's code with its inputs as they are now: in the
 * repository's tree when there is one, otherwise in the block's workspace.
 * Renders only while `enabled`, and keeps the last code while it renders again.
 * Renders again when the simulation's answers change, since the repository's
 * files may have.
 */
export function useUnitCode(
  blockId: string,
  module: TfModuleCodeRef,
  values: Record<string, unknown>,
  repo: TfModuleRepo | undefined,
  enabled: boolean,
) {
  const api = useApi()
  const { revision } = useSimulation()
  const [code, setCode] = useState<TfModuleCode | null>(null)
  const [error, setError] = useState<string | null>(null)
  const key = JSON.stringify({ ...module, values, repo })

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const timer = setTimeout(() => {
      const request = JSON.parse(key) as TfModuleCodeRef & {
        values: Record<string, unknown>
        repo?: TfModuleRepo
      }
      api
        .invoke("tf-module:render", { blockId, ...request })
        .then((result) => {
          if (cancelled) return
          setCode(result)
          setError(null)
        })
        .catch((err: unknown) => {
          if (!cancelled)
            setError(cleanIpcErrorMessage(err instanceof Error ? err.message : String(err)))
        })
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [api, blockId, key, enabled, revision])

  return { code, error }
}
