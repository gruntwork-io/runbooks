import { useCallback, useEffect, useRef, useState } from 'react'
import { useApi } from '@/contexts/ApiContext'
import { createAppError, type AppError } from '@/types/error'
import type { ScriptFileChange } from '../../../../../../electron/shared/channels.ts'

interface UseScriptFileChangeReturn {
  /** How the script file differs on disk from the registry's copy, or null when it doesn't. */
  change: ScriptFileChange | null
  /** Register the changed script, so Run executes it. */
  reload: () => void
  isReloading: boolean
  reloadError: AppError | null
}

/**
 * Tracks whether a block's script file differs on disk from the copy the
 * registry holds for it, and lets the user reload it into the registry.
 *
 * `executableId` is the block's registry entry, or undefined for a block
 * without a script file. The file is checked when the entry changes and each
 * time the main process reports that this block's script file was written.
 */
export function useScriptFileChange(
  componentId: string,
  executableId: string | undefined,
): UseScriptFileChangeReturn {
  const api = useApi()

  // Tagged with the entry it was checked against: a result for an entry the
  // registry has since replaced says nothing about the current one.
  const [checked, setChecked] = useState<{ executableId: string; change: ScriptFileChange | null } | null>(null)
  const [isReloading, setIsReloading] = useState(false)
  const [reloadError, setReloadError] = useState<AppError | null>(null)

  // Only the latest check may commit: IPC calls can't be cancelled.
  const checkSeqRef = useRef(0)

  const check = useCallback(async () => {
    if (!executableId) return
    const seq = ++checkSeqRef.current
    try {
      const { change } = await api.invoke('runbook:script-change', { componentId })
      if (seq !== checkSeqRef.current) return
      setChecked({ executableId, change: change ?? null })
    } catch (err) {
      // runbook:script-change reports an unreadable file as "no change", so
      // this is an IPC failure. The next check replaces the last result.
      console.error('Failed to check the script file for changes:', err)
    }
  }, [api, componentId, executableId])

  useEffect(() => {
    if (!executableId) return
    void check()
    const unsubscribe = api.on('watch:script-change', ({ componentIds }) => {
      if (componentIds.includes(componentId)) void check()
    })
    return () => {
      checkSeqRef.current++
      unsubscribe()
    }
  }, [api, check, componentId, executableId])

  const change = checked && checked.executableId === executableId ? checked.change : null

  const reload = useCallback(() => {
    if (!change) return
    const reviewedHash = change.diskContentHash
    setIsReloading(true)
    setReloadError(null)

    const reloadReviewed = async () => {
      try {
        await api.invoke('runbook:reload-script', { componentId, contentHash: reviewedHash })
        // registry:updated gives the block a new entry, which is checked again.
        // Drop the reloaded change now so the notice doesn't outlive the click.
        checkSeqRef.current++
        setChecked(null)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to reload the script'
        setReloadError(createAppError(message))
        // The file may have changed again: show what is on disk now.
        void check()
      } finally {
        setIsReloading(false)
      }
    }
    void reloadReviewed()
  }, [api, componentId, change, check])

  return { change, reload, isReloading, reloadError }
}
