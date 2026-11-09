import { useCallback, useEffect, useRef, useState } from "react"
import { useApi } from "@/contexts/ApiContext"
import { useRunbookContext } from "@/contexts/useRunbook"
import { useSessionHistory } from "@/contexts/useSessionHistory"
import { parseSavedResource, type SavedResource } from "@/lib/sessionHistory"
import type { CreateOnePasswordItemParams } from "../../../../../../electron/shared/channels"
import type { OnePasswordItemStatus } from "../types"

/** The outputs a saved item publishes: where it is, never what it holds. */
export function itemOutputs(result: {
  itemId: string
  title: string
  vaultId: string
  vaultName: string
}): Record<string, string> {
  return {
    OP_ITEM_ID: result.itemId,
    OP_ITEM_TITLE: result.title,
    OP_VAULT_ID: result.vaultId,
    OP_VAULT: result.vaultName,
  }
}

/**
 * Saves the item in the main process and publishes its outputs. An item the
 * block already saved this session is shown from the session's history, so
 * reopening the session never saves it twice.
 */
export function useOnePasswordItem(id: string) {
  const api = useApi()
  const history = useSessionHistory()
  const { registerOutputs } = useRunbookContext()

  const [restored] = useState<SavedResource | undefined>(() =>
    parseSavedResource(history.saved(id, "resource")),
  )
  const [status, setStatus] = useState<OnePasswordItemStatus>(restored ? "success" : "ready")
  const [outputs, setOutputs] = useState<Record<string, string> | null>(restored?.outputs ?? null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (restored) registerOutputs(id, restored.outputs)
  }, [id, registerOutputs, restored])

  // A reply that comes back after the block unmounted changes nothing.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const save = useCallback(
    async (params: CreateOnePasswordItemParams) => {
      setStatus("saving")
      setError(null)
      let reply
      try {
        reply = await api.invoke("onepassword:create-item", params)
      } catch (err) {
        reply = { ok: false as const, error: err instanceof Error ? err.message : String(err) }
      }
      if (!mountedRef.current) return
      if (!reply.ok) {
        setStatus("fail")
        setError(reply.error)
        return
      }
      const published = itemOutputs(reply)
      registerOutputs(id, published)
      setOutputs(published)
      setStatus("success")
      history.record(id, "resource", {
        status: "created",
        log: [`Saved "${reply.title}" to the ${reply.vaultName} vault`],
        outputs: published,
      } satisfies SavedResource)
    },
    [api, history, id, registerOutputs],
  )

  return { status, outputs, error, save }
}
