import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from '@/contexts/useSession'
import { useRunbookContext } from '@/contexts/useRunbook'
import { normalizeBlockId } from '@/lib/utils'

interface UseDirPickerOptions {
  id: string
  gitCloneId?: string
  /** Maximum number of dropdown levels to show. */
  maxLevels?: number
}

interface DirLevel {
  /** Absolute path of this directory level. */
  path: string
  /** Selected subdirectory name at this level (empty = nothing selected). */
  selected: string
  /** Available subdirectory names. */
  dirs: string[]
  /** Whether we're currently loading dirs for this level. */
  loading: boolean
}

export function useDirPicker({ id, gitCloneId, maxLevels }: UseDirPickerOptions) {
  const { getAuthHeader, isReady: sessionReady } = useSession()
  const { registerOutputs, blockOutputs: allOutputs } = useRunbookContext()

  const [levels, setLevels] = useState<DirLevel[]>([])
  const [manualPath, setManualPath] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Track whether we've already initialized the root level
  const initializedRootRef = useRef<string | null>(null)

  // Resolve the root path from the GitClone block's outputs
  const rootPath = useMemo((): string | null => {
    if (!gitCloneId) return null
    const normalizedId = normalizeBlockId(gitCloneId)
    const blockData = allOutputs[normalizedId]
    return blockData?.values?.CLONE_PATH ?? null
  }, [gitCloneId, allOutputs])

  // Whether the GitClone dependency is met
  const isWorkspaceReady = !gitCloneId || rootPath !== null

  // Fetch subdirectories for a given absolute path
  const fetchDirs = useCallback(async (absPath: string): Promise<string[]> => {
    if (!sessionReady) return []
    try {
      const response = await fetch(`/api/workspace/dirs?path=${encodeURIComponent(absPath)}`, {
        headers: { ...getAuthHeader() },
      })
      if (!response.ok) {
        const data = await response.json().catch(() => null)
        throw new Error(data?.error ?? `Failed to fetch directories (${response.status})`)
      }
      const data = await response.json()
      return data.dirs ?? []
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch directories')
      return []
    }
  }, [sessionReady, getAuthHeader])

  // Build the composed path from dropdown selections
  const composedPath = useMemo(() => {
    const parts = levels
      .map(l => l.selected)
      .filter(Boolean)
    return parts.join('/')
  }, [levels])

  // Initialize root level when workspace becomes ready
  useEffect(() => {
    if (!isWorkspaceReady || !rootPath || !sessionReady) return
    // Don't re-initialize if we already did for this root
    if (initializedRootRef.current === rootPath) return
    initializedRootRef.current = rootPath

    setError(null)
    const init = async () => {
      const dirs = await fetchDirs(rootPath)
      setLevels([{ path: rootPath, selected: '', dirs, loading: false }])
    }
    init()
  }, [isWorkspaceReady, rootPath, sessionReady, fetchDirs])

  // Handle selection at a given dropdown level
  const selectDir = useCallback(async (levelIndex: number, dirName: string) => {
    setError(null)

    setLevels(prev => {
      // Trim levels after the current one and update selection
      const updated = prev.slice(0, levelIndex + 1)
      updated[levelIndex] = { ...updated[levelIndex], selected: dirName }
      return updated
    })

    if (!dirName || !rootPath) return

    // Don't drill deeper than maxLevels (levelIndex is 0-based, next level would be levelIndex+1)
    if (maxLevels !== undefined && levelIndex + 1 >= maxLevels) return

    // Build the absolute path for the selected directory.
    // Use selections from previous levels (stable) plus the new dirName for this level.
    const previousSelections = levels
      .slice(0, levelIndex)
      .map(l => l.selected)
      .filter(Boolean)
    const nextAbsPath = [rootPath, ...previousSelections, dirName].join('/')

    // Fetch children and add a new level
    const childDirs = await fetchDirs(nextAbsPath)
    if (childDirs.length > 0) {
      setLevels(prev => [
        ...prev,
        { path: nextAbsPath, selected: '', dirs: childDirs, loading: false },
      ])
    }
  }, [rootPath, levels, fetchDirs])

  // Sync manualPath with composed path from dropdowns
  useEffect(() => {
    setManualPath(composedPath)
  }, [composedPath])

  // Register outputs whenever the path changes
  useEffect(() => {
    if (manualPath) {
      registerOutputs(id, { selected_path: manualPath })
    }
  }, [id, manualPath, registerOutputs])

  // Handle manual path edits
  const setPath = useCallback((path: string) => {
    setManualPath(path)
    // When manually editing, clear dropdown state since it may no longer match
    if (path !== composedPath) {
      // Keep levels for display but register the manual path
      registerOutputs(id, { selected_path: path })
    }
  }, [id, composedPath, registerOutputs])

  return {
    levels,
    manualPath,
    error,
    isWorkspaceReady,
    rootPath,
    selectDir,
    setPath,
  }
}
