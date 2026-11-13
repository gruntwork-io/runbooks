import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react"

/** Files a block asks the files panel to show, in a clone's changed files. */
export interface FileReveal {
  /** Tells one request from the next, so the same files can be shown again. */
  readonly id: number
  /** The clone the files are in. */
  readonly worktreePath: string
  /** The files, from the clone's root. The first one that has changed is selected. */
  readonly paths: readonly string[]
}

interface WorkspaceRevealContextType {
  /** The latest request, or null before the first. */
  readonly reveal: FileReveal | null
  readonly revealFiles: (worktreePath: string, paths: readonly string[]) => void
}

const NO_REVEAL: WorkspaceRevealContextType = { reveal: null, revealFiles: () => {} }

// Without a provider there's no files panel to show anything in.
const WorkspaceRevealContext = createContext<WorkspaceRevealContextType>(NO_REVEAL)

/** Holds the latest request to show a block's files in the files panel. */
export function WorkspaceRevealProvider({ children }: { children: ReactNode }) {
  const [reveal, setReveal] = useState<FileReveal | null>(null)
  const revealFiles = useCallback((worktreePath: string, paths: readonly string[]) => {
    if (paths.length === 0) return
    setReveal((prev) => ({ id: (prev?.id ?? 0) + 1, worktreePath, paths }))
  }, [])
  const value = useMemo(() => ({ reveal, revealFiles }), [reveal, revealFiles])
  return <WorkspaceRevealContext.Provider value={value}>{children}</WorkspaceRevealContext.Provider>
}

export function useWorkspaceReveal(): WorkspaceRevealContextType {
  return useContext(WorkspaceRevealContext)
}
