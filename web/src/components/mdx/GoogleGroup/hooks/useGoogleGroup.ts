import { useCallback, useEffect, useRef, useState } from "react"
import { useApi } from "@/contexts/ApiContext"
import { useRunbookContext } from "@/contexts/useRunbook"
import { useSessionHistory } from "@/contexts/useSessionHistory"
import { parseSavedResource, type SavedResource } from "@/lib/sessionHistory"
import type { CreateGoogleGroupParams } from "../../../../../../electron/shared/channels"
import type { GoogleGroupStatus } from "../types"

/** The outputs a created group publishes. None of them is a secret. */
export function groupOutputs(result: {
  group: { name: string; email: string; displayName?: string | undefined }
  created: boolean
  customerId: string
}): Record<string, string> {
  return {
    GROUP_EMAIL: result.group.email,
    GROUP_NAME: result.group.name,
    GROUP_ID: result.group.name.replace(/^groups\//, ""),
    GROUP_DISPLAY_NAME: result.group.displayName ?? "",
    GROUP_CREATED: String(result.created),
    CUSTOMER_ID: result.customerId,
  }
}

/**
 * Creates the group in the main process and publishes its outputs. A group
 * the block already created this session is shown from the session's history,
 * with its outputs, without asking Google again.
 */
export function useGoogleGroup(id: string) {
  const api = useApi()
  const history = useSessionHistory()
  const { registerOutputs } = useRunbookContext()

  const [restored] = useState<SavedResource | undefined>(() =>
    parseSavedResource(history.saved(id, "resource")),
  )
  const [status, setStatus] = useState<GoogleGroupStatus>(restored ? "success" : "ready")
  const [log, setLog] = useState<string[]>(restored?.log ?? [])
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

  const create = useCallback(
    async (params: CreateGoogleGroupParams) => {
      setStatus("creating")
      setError(null)
      setLog([])
      let reply
      try {
        reply = await api.invoke("google:create-group", params)
      } catch (err) {
        reply = { ok: false as const, error: err instanceof Error ? err.message : String(err) }
      }
      if (!mountedRef.current) return
      if (!reply.ok) {
        setStatus("fail")
        setError(reply.error)
        return
      }
      const published = groupOutputs(reply)
      registerOutputs(id, published)
      setOutputs(published)
      setLog(reply.log)
      setStatus("success")
      history.record(id, "resource", {
        status: "created",
        log: reply.log,
        outputs: published,
      } satisfies SavedResource)
    },
    [api, history, id, registerOutputs],
  )

  return { status, log, outputs, error, create }
}
