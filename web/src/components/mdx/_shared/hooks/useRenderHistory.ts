import { useCallback, useRef, useState } from "react"
import { useSessionHistory } from "@/contexts/useSessionHistory"
import { computeSha256Hash } from "@/lib/hash"
import { parseSavedRender, type SavedRender } from "@/lib/sessionHistory"

interface UseRenderHistoryReturn {
  /**
   * Whether the history says the block wrote files before it mounted, and the
   * block has written nothing since. Only then can isUnchangedSinceMount be true.
   */
  hasWriteBeforeMount: () => boolean
  /**
   * Whether `written` is what the block wrote before it mounted, so writing
   * it again would only overwrite changes made to the files since.
   */
  isUnchangedSinceMount: (written: string) => Promise<boolean>
  /** Record that the block wrote `written`. */
  noteWritten: (written: string) => void
}

/**
 * Keeps what template block `id` last wrote in the session's history, as a
 * hash, so a resumed block shows its files without writing them again.
 *
 * `written` is any string that changes whenever the written files would: the
 * template's files and the values it rendered them with. It holds the real
 * values of sensitive outputs, so only its hash is kept.
 */
export function useRenderHistory(id: string): UseRenderHistoryReturn {
  const history = useSessionHistory()
  const [saved] = useState(() => parseSavedRender(history.saved(id, "render")))
  // Cleared by the block's first write: from then on every render writes, as
  // it does in a session that was not resumed.
  const beforeMountRef = useRef<SavedRender | undefined>(saved)
  // Hashes resolve out of order; only the latest write is recorded.
  const writeSeqRef = useRef(0)

  const hasWriteBeforeMount = useCallback(() => beforeMountRef.current !== undefined, [])

  const isUnchangedSinceMount = useCallback(async (written: string) => {
    const before = beforeMountRef.current
    if (before === undefined) return false
    return (await computeSha256Hash(written)) === before.writtenHash
  }, [])

  const noteWritten = useCallback(
    (written: string) => {
      beforeMountRef.current = undefined
      const seq = ++writeSeqRef.current
      void computeSha256Hash(written).then((writtenHash) => {
        if (seq !== writeSeqRef.current) return
        history.record(id, "render", { writtenHash } satisfies SavedRender)
      })
    },
    [history, id],
  )

  return { hasWriteBeforeMount, isUnchangedSinceMount, noteWritten }
}
