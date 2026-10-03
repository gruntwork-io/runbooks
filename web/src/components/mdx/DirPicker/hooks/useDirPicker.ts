import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useApi } from "@/contexts/ApiContext"
import { useSession } from "@/contexts/useSession"
import { useRunbookContext } from "@/contexts/useRunbook"
import { useSessionHistory } from "@/contexts/useSessionHistory"
import { normalizeBlockId } from "@/lib/utils"
import { revealOutput } from "@/lib/outputValues"
import { parseSavedForm, type SavedForm } from "@/lib/sessionHistory"

// How deep a path from the session's history is walked into dropdowns when
// the block sets no level limit. Each level is one directory listing.
const MAX_RESUMED_LEVELS = 32

interface UseDirPickerOptions {
  id: string
  rootDir?: string | undefined
  gitCloneId?: string | undefined
  /** Maximum number of dropdown levels to show. */
  maxLevels?: number | undefined
  /**
   * Another block has the same id (or the same id after normalization). The
   * duplicate renders nothing and leaves the PATH output to the other block.
   */
  isDuplicate?: boolean | undefined
}

/** Result of listing one directory: its subdirectories, or why it failed. */
interface DirsListing {
  dirs: string[]
  error: string | null
}

interface DirLevel {
  /** Absolute path of this directory level. */
  path: string
  /** Selected subdirectory name at this level (empty = nothing selected). */
  selected: string
  /** Available subdirectory names. */
  dirs: string[]
}

export function useDirPicker({
  id,
  rootDir,
  gitCloneId,
  maxLevels,
  isDuplicate,
}: UseDirPickerOptions) {
  const api = useApi()
  const { isReady: sessionReady } = useSession()
  const { registerOutputs, blockOutputs: allOutputs } = useRunbookContext()

  const [levels, setLevels] = useState<DirLevel[]>([])
  const [manualPath, setManualPath] = useState("")
  const [error, setError] = useState<string | null>(null)

  // The path the session's history has for this block. The first listing of
  // a root takes it back, with a dropdown selection for each of its
  // directories that is still there. Cleared once taken.
  const history = useSessionHistory()
  const [savedPath] = useState(() => {
    const path = parseSavedForm(history.saved(id, "inputs"))?.values.path
    return typeof path === "string" && path !== "" ? path : undefined
  })
  const resumePathRef = useRef(savedPath)

  // Every path the user picks or types is kept in the session's history.
  const recordPath = useCallback(
    (path: string) => {
      history.record(id, "inputs", { values: { path }, submitted: true } satisfies SavedForm)
    },
    [history, id],
  )

  // Track whether we've already initialized the root level
  const initializedRootRef = useRef<string | null>(null)

  // Monotonic stamp to discard stale fetch results: taken by every selectDir
  // call and by every root (re)initialization or reset
  const selectVersionRef = useRef(0)

  // Resolve the root path: prefer explicit rootDir, fall back to GitClone output
  const rootPath = useMemo((): string | null => {
    if (rootDir) return rootDir
    if (!gitCloneId) return null
    const normalizedId = normalizeBlockId(gitCloneId)
    const blockData = allOutputs[normalizedId]
    return revealOutput(blockData?.values?.clone_path) ?? null
  }, [rootDir, gitCloneId, allOutputs])

  // Whether the root directory is available (immediately if rootDir is set, otherwise when GitClone completes)
  const isWorkspaceReady = !!rootDir || !gitCloneId || rootPath !== null

  // Fetch subdirectories for a given absolute path. A failure comes back as
  // `error` rather than being shown here: the caller shows it only if the
  // listing is still current.
  const fetchDirs = useCallback(
    async (absPath: string): Promise<DirsListing> => {
      if (!sessionReady) return { dirs: [], error: null }
      try {
        const data = await api.invoke("workspace:dirs", { worktreePath: absPath })
        return { dirs: data.dirs ?? [], error: null }
      } catch (err) {
        return {
          dirs: [],
          error: err instanceof Error ? err.message : "Failed to fetch directories",
        }
      }
    },
    [api, sessionReady],
  )

  // Build the composed path from dropdown selections
  const composedPath = useMemo(() => composePath(levels), [levels])
  // The composed path manualPath last followed (see the sync below)
  const [prevComposedPath, setPrevComposedPath] = useState(composedPath)

  // The dropdowns for `path` under the root's level: a selection for each of
  // its directories that is still there, and a level below each.
  const walkPath = useCallback(
    async (rootLevel: DirLevel, path: string): Promise<DirLevel[]> => {
      const walked = [rootLevel]
      const segments = path.split("/").filter(Boolean)
      for (const segment of segments.slice(0, maxLevels ?? MAX_RESUMED_LEVELS)) {
        const level = walked.at(-1)!
        if (!level.dirs.includes(segment)) break
        walked[walked.length - 1] = { ...level, selected: segment }
        if (maxLevels !== undefined && walked.length >= maxLevels) break
        const listing = await fetchDirs(`${level.path}/${segment}`)
        if (listing.error || listing.dirs.length === 0) break
        walked.push({ path: `${level.path}/${segment}`, selected: "", dirs: listing.dirs })
      }
      return walked
    },
    [fetchDirs, maxLevels],
  )

  // Initialize root level when workspace becomes ready, and start over when
  // the root changes or goes away. The path, typed or selected, was relative
  // to the old root: clearing it lets the PATH effect below withdraw the
  // output. The old root's dropdowns go away until the new root is listed,
  // and a root that comes back is listed again.
  useEffect(() => {
    if (!rootPath) {
      if (initializedRootRef.current !== null) {
        initializedRootRef.current = null
        selectVersionRef.current++
        setError(null)
        setLevels([])
        setManualPath("")
      }
      return
    }
    if (!isWorkspaceReady || !sessionReady) return
    // Don't re-initialize if we already did for this root
    if (initializedRootRef.current === rootPath) return
    initializedRootRef.current = rootPath
    const version = ++selectVersionRef.current

    setError(null)
    setLevels([])
    setManualPath("")
    const init = async () => {
      const listing = await fetchDirs(rootPath)
      const current = () =>
        selectVersionRef.current === version && initializedRootRef.current === rootPath
      // Discard if the root changed or went away while we were fetching
      if (!current()) return
      if (listing.error) setError(listing.error)
      const rootLevel: DirLevel = { path: rootPath, selected: "", dirs: listing.dirs }
      const resumePath = resumePathRef.current
      resumePathRef.current = undefined
      if (resumePath === undefined) {
        setLevels([rootLevel])
        return
      }
      const walked = await walkPath(rootLevel, resumePath)
      if (!current()) return
      setLevels(walked)
      // The path stays as it was, typed parts included: the sync below would
      // otherwise cut it down to the directories the dropdowns found.
      setPrevComposedPath(composePath(walked))
      setManualPath(resumePath)
    }
    void init()
  }, [isWorkspaceReady, rootPath, sessionReady, fetchDirs, walkPath])

  // Handle selection at a given dropdown level
  const selectDir = useCallback(
    async (levelIndex: number, dirName: string) => {
      setError(null)
      const version = ++selectVersionRef.current
      recordPath(
        composePath([...levels.slice(0, levelIndex), { path: "", selected: dirName, dirs: [] }]),
      )

      setLevels((prev) => {
        // Trim levels after the current one and update selection
        const updated = prev.slice(0, levelIndex + 1)
        updated[levelIndex] = { ...updated[levelIndex]!, selected: dirName }
        return updated
      })

      if (!dirName || !rootPath) return

      // Don't drill deeper than maxLevels (levelIndex is 0-based, next level would be levelIndex+1)
      if (maxLevels !== undefined && levelIndex + 1 >= maxLevels) return

      // Build the absolute path for the selected directory.
      // Use selections from previous levels (stable) plus the new dirName for this level.
      const previousSelections = levels
        .slice(0, levelIndex)
        .map((l) => l.selected)
        .filter(Boolean)
      const nextAbsPath = [rootPath, ...previousSelections, dirName].join("/")

      // Fetch children and add a new level
      const listing = await fetchDirs(nextAbsPath)
      // Discard if a newer selectDir call has been made, or the root changed,
      // while we were fetching
      if (selectVersionRef.current !== version || initializedRootRef.current !== rootPath) return
      if (listing.error) setError(listing.error)
      if (listing.dirs.length > 0) {
        setLevels((prev) => [...prev, { path: nextAbsPath, selected: "", dirs: listing.dirs }])
      }
    },
    [rootPath, levels, fetchDirs, maxLevels, recordPath],
  )

  // Manual edits only change the path shown; the effect below publishes it.
  const setPath = useCallback(
    (path: string) => {
      setManualPath(path)
      recordPath(path)
    },
    [recordPath],
  )

  // Sync manualPath with composed path from dropdowns whenever the
  // selections change
  if (prevComposedPath !== composedPath) {
    setPrevComposedPath(composedPath)
    setManualPath(composedPath)
  }

  const publishedPath = allOutputs[normalizeBlockId(id)]?.values?.PATH

  // Set when this instance has withdrawn PATH for its current empty path.
  const withdrewRef = useRef(false)

  // Keep this block's PATH output in sync with the path shown in the input.
  // This effect is the only writer of PATH. An empty path clears the output
  // ({}), so downstream blocks see PATH as unmet again. Comparing against the
  // published value (rather than tracking what this instance wrote) also clears
  // a PATH left behind by DirPickerInstruction or a previous mount.
  //
  // An empty path withdraws PATH once. If PATH comes back while this block's
  // path is still empty, another block with the same id published it, and
  // the registry hasn't flagged the duplicate yet (it does so a tick after
  // mount). Withdrawing again would fight the other block, which publishes
  // its PATH again, until React stops the update loop.
  useEffect(() => {
    if (isDuplicate) return
    if (manualPath) {
      withdrewRef.current = false
      if (manualPath !== publishedPath) registerOutputs(id, { PATH: manualPath })
    } else if (publishedPath !== undefined && !withdrewRef.current) {
      withdrewRef.current = true
      registerOutputs(id, {})
    }
  }, [id, manualPath, publishedPath, registerOutputs, isDuplicate])

  return {
    levels,
    manualPath,
    error,
    isWorkspaceReady,
    selectDir,
    setPath,
  }
}

/** The path the dropdowns' selections make, relative to the root. */
function composePath(levels: DirLevel[]): string {
  return levels
    .map((l) => l.selected)
    .filter(Boolean)
    .join("/")
}
