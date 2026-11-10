import { useEffect, useState } from "react"
import { useApi } from "@/contexts/ApiContext"
import { cleanIpcErrorMessage } from "@/lib/ipcError"
import type { TofuModuleCode, TofuModuleRepo } from "../../../../../../electron/shared/channels"

/** How long the inputs must settle before the code renders again. */
const DEBOUNCE_MS = 300

/**
 * The block's Terragrunt code with its inputs as they are now: in the
 * repository's tree when there is one, otherwise in the block's workspace.
 * Renders only while `enabled`, and keeps the last code while it renders again.
 */
export function useUnitCode(
  blockId: string,
  source: string,
  values: Record<string, unknown>,
  repo: TofuModuleRepo | undefined,
  enabled: boolean,
) {
  const api = useApi()
  const [code, setCode] = useState<TofuModuleCode | null>(null)
  const [error, setError] = useState<string | null>(null)
  const key = JSON.stringify({ values, repo })

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const timer = setTimeout(() => {
      const request = JSON.parse(key) as {
        values: Record<string, unknown>
        repo?: TofuModuleRepo
      }
      api
        .invoke("tofu-module:render", { source, blockId, ...request })
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
  }, [api, source, blockId, key, enabled])

  return { code, error }
}
