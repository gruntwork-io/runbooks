import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState } from "react"
import type { ReactNode } from "react"
import { normalizeBlockId } from "../lib/utils"

/**
 * The OAuth scopes the page's blocks need from each auth block, so an auth
 * block can request them at sign-in instead of the runbook listing them by
 * hand. Keyed by the auth block's normalized id, then by the block that needs
 * them.
 */
type Requests = ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>

type SetRequest = (requester: string, scopes: Readonly<Record<string, readonly string[]>>) => void

const RequestsContext = createContext<Requests | undefined>(undefined)
// Separate, and stable, so the blocks that declare scopes don't re-render when any block does.
const SetRequestContext = createContext<SetRequest | undefined>(undefined)

const NO_SCOPES: readonly string[] = []

export function ScopeRequestsProvider({ children }: { children: ReactNode }) {
  const [requests, setRequests] = useState<Requests>(new Map())
  const setRequest = useCallback<SetRequest>(
    (requester, scopes) =>
      setRequests((prev) => {
        const next = new Map<string, Map<string, readonly string[]>>()
        for (const [authId, byRequester] of prev) {
          const kept = new Map(byRequester)
          kept.delete(requester)
          if (kept.size > 0) next.set(authId, kept)
        }
        for (const [authId, needed] of Object.entries(scopes)) {
          if (needed.length === 0) continue
          const key = normalizeBlockId(authId)
          const byRequester = next.get(key) ?? new Map<string, readonly string[]>()
          byRequester.set(requester, needed)
          next.set(key, byRequester)
        }
        return next
      }),
    [],
  )
  return (
    <SetRequestContext.Provider value={setRequest}>
      <RequestsContext.Provider value={requests}>{children}</RequestsContext.Provider>
    </SetRequestContext.Provider>
  )
}

/**
 * Declares the scopes the calling block needs from each auth block, by the
 * auth block's id, for as long as the block is on the page.
 */
export function useScopeRequests(scopes: Readonly<Record<string, readonly string[]>>): void {
  const setRequest = useContext(SetRequestContext)
  const requester = useId()
  // Declares again when the scopes change, not when a new object holds the same ones.
  const key = JSON.stringify(
    Object.entries(scopes)
      .map(([authId, needed]): [string, string[]] => [authId, [...needed].sort()])
      .sort(([a], [b]) => a.localeCompare(b)),
  )
  useEffect(() => {
    if (!setRequest) return
    setRequest(requester, Object.fromEntries(JSON.parse(key) as [string, string[]][]))
    return () => setRequest(requester, {})
  }, [setRequest, key, requester])
}

/** The scopes the page's blocks need from the auth block with this id, sorted. */
export function useRequestedScopes(authId: string): readonly string[] {
  const requests = useContext(RequestsContext)
  const byRequester = requests?.get(normalizeBlockId(authId))
  const key = byRequester ? [...new Set([...byRequester.values()].flat())].sort().join(" ") : ""
  // The same array while the scopes stay the same, so the auth block's sign-in doesn't start over.
  return useMemo(() => (key ? key.split(" ") : NO_SCOPES), [key])
}
