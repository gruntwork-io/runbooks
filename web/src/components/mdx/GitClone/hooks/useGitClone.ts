import { useCallback, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import { useApi } from '@/contexts/ApiContext'
import { useRunbookContext } from '@/contexts/useRunbook'
import { normalizeBlockId } from '@/lib/utils'
import { deriveProviderFromAuth } from '@/components/mdx/_shared/lib/gitProvider'
import type { LogEntry } from '@/hooks/useApiExec'
import type { GitCloneStatus, CloneResult, GitHubOrg, GitHubRepo, GitHubRef } from '../types'

const CloneLogEventSchema = z.object({
  line: z.string(),
  timestamp: z.string().optional(),
  replace: z.boolean().optional(),
})

function createLogEntry(line: string, timestamp?: string): LogEntry {
  return {
    line,
    timestamp: timestamp ?? new Date().toISOString(),
  }
}

interface UseGitCloneOptions {
  id: string
  githubAuthId?: string
  /** Reference to a GitAuth block (GitHub or GitLab) by ID. */
  gitAuthId?: string
}

export function useGitClone({ id, githubAuthId, gitAuthId }: UseGitCloneOptions) {
  const api = useApi()
  const { registerOutputs, blockOutputs: allOutputs } = useRunbookContext()

  // State
  const [cloneStatus, setCloneStatus] = useState<GitCloneStatus>('pending')
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [cloneResult, setCloneResult] = useState<CloneResult | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [hasGitHubToken, setHasGitHubToken] = useState(false)
  const [tokenChecked, setTokenChecked] = useState(false)
  const [workingDir, setWorkingDir] = useState<string | null>(null)

  // Ref to the progress listener unsubscriber so cancel() can clean up
  const unsubLogRef = useRef<(() => void) | null>(null)

  // Check if the auth dependency is met. Supports githubAuthId (GitHub) and the
  // provider-agnostic gitAuthId (GitHub or GitLab); a referenced block is met
  // once it has emitted a token (GITHUB_TOKEN or GITLAB_TOKEN) or the
  // __AUTHENTICATED marker (env-prefilled credentials stored server-side).
  const gitHubAuthMet = useMemo((): boolean => {
    const isAuthMet = (authId: string | undefined): boolean => {
      if (!authId) return true // No dependency
      const values = allOutputs[normalizeBlockId(authId)]?.values
      if (values?.GITHUB_TOKEN && values.GITHUB_TOKEN !== '') return true
      if (values?.GITLAB_TOKEN && values.GITLAB_TOKEN !== '') return true
      if (values?.__AUTHENTICATED === 'true') return true
      return false
    }
    return isAuthMet(githubAuthId) && isAuthMet(gitAuthId)
  }, [githubAuthId, gitAuthId, allOutputs])

  // Provider of the linked auth block, derived from its outputs. Passed to the
  // clone so the backend resolves the matching session token (and oauth2 vs
  // x-access-token username) by PROVIDER rather than parsing the remote host —
  // the only thing that works for self-hosted GitHub/GitLab instances.
  const authProvider = useMemo(
    () => deriveProviderFromAuth(gitAuthId, allOutputs) ?? deriveProviderFromAuth(githubAuthId, allOutputs),
    [gitAuthId, githubAuthId, allOutputs],
  )

  // Fetch session working directory for path preview
  const fetchWorkingDir = useCallback(async () => {
    try {
      const data = await api.invoke('session:get')
      if (data.workingDir) {
        setWorkingDir(data.workingDir)
      }
    } catch {
      // Non-critical — path preview just won't show
    }
  }, [api])

  // Detect if a GitHub token is available in the session
  const checkGitHubToken = useCallback(async () => {
    // Fetch working dir in parallel
    fetchWorkingDir()

    try {
      const orgs = await api.invoke('github:orgs')
      // If we got orgs back (even just the user), we have a token
      setHasGitHubToken(Array.isArray(orgs) && orgs.length > 0)
    } catch {
      setHasGitHubToken(false)
    } finally {
      setTokenChecked(true)
      setCloneStatus('ready')
    }
  }, [api, fetchWorkingDir])

  const fetchOrgs = useCallback(async (): Promise<GitHubOrg[]> => {
    try {
      const orgs = await api.invoke('github:orgs')
      return (orgs as unknown as GitHubOrg[]) ?? []
    } catch {
      return []
    }
  }, [api])

  const fetchRepos = useCallback(async (owner: string, _query?: string): Promise<GitHubRepo[]> => {
    try {
      const repos = await api.invoke('github:repos', { org: owner })
      return (repos as unknown as GitHubRepo[]) ?? []
    } catch {
      return []
    }
  }, [api])

  const fetchRefs = useCallback(async (owner: string, repo: string, _query?: string): Promise<{ refs: GitHubRef[]; totalCount: number; hasMore: boolean }> => {
    try {
      const refs = await api.invoke('github:refs', { owner, repo })
      const typedRefs = (refs as unknown as GitHubRef[]) ?? []
      return {
        refs: typedRefs,
        totalCount: typedRefs.length,
        hasMore: false,
      }
    } catch {
      return { refs: [], totalCount: 0, hasMore: false }
    }
  }, [api])

  // Execute the clone operation. Returns 'directory_exists' if the destination
  // already exists and force was not set, so the caller can prompt the user.
  const clone = useCallback(async (url: string, ref: string, repoPath: string, localPath: string, usePty?: boolean, force?: boolean): Promise<'directory_exists' | void> => {
    setCloneStatus('running')
    setLogs([])
    setCloneResult(null)
    setErrorMessage(null)

    let unsubLog: (() => void) | null = null

    try {
      const body: Record<string, unknown> = { url }
      if (ref) body.ref = ref
      if (repoPath) body.repo_path = repoPath
      if (localPath) body.local_path = localPath
      if (usePty !== undefined) body.use_pty = usePty
      if (force) body.force = true
      if (authProvider) body.provider = authProvider

      // Subscribe to streaming events before starting the clone.
      // Store in ref so cancel() can unsubscribe.
      unsubLog = window.api.on('git:clone-progress', (data: { line: string; timestamp?: string; replace?: boolean }) => {
        const parsed = CloneLogEventSchema.safeParse(data)
        if (parsed.success) {
          const newEntry = createLogEntry(parsed.data.line, parsed.data.timestamp)
          setLogs(prev => {
            if (parsed.data.replace && prev.length > 0) {
              return [...prev.slice(0, -1), newEntry]
            }
            return [...prev, newEntry]
          })
        }
      })
      unsubLogRef.current = unsubLog

      const result = await window.api.invoke('git:clone', body as any)

      if (result.error === 'directory_exists') {
        setCloneStatus('ready')
        return 'directory_exists'
      }

      if (result.status === 'success') {
        if (result.outputs) {
          registerOutputs(id, result.outputs)
        }
        setCloneResult(result as unknown as typeof cloneResult)
        setCloneStatus('success')
      } else {
        setErrorMessage(result.error || 'Clone failed')
        setCloneStatus('fail')
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'An unexpected error occurred'
      setErrorMessage(msg)
      setCloneStatus('fail')
      setLogs(prev => [...prev, createLogEntry(`Error: ${msg}`)])
    } finally {
      // Clean up progress listener after a short delay to allow
      // late-arriving IPC events to be delivered.
      if (unsubLog) {
        const unsub = unsubLog
        setTimeout(() => unsub(), 200)
      }
      unsubLogRef.current = null
    }
  }, [api, id, registerOutputs, authProvider])

  // Cancel an in-progress clone by unsubscribing from progress events
  const cancel = useCallback(() => {
    if (unsubLogRef.current) {
      unsubLogRef.current()
      unsubLogRef.current = null
    }
    setLogs(prev => [...prev, createLogEntry('Clone cancelled by user')])
    setCloneStatus('ready')
  }, [])

  const reset = useCallback(() => {
    setCloneStatus('ready')
    setLogs([])
    setCloneResult(null)
    setErrorMessage(null)
  }, [])

  return {
    // State
    cloneStatus,
    logs,
    cloneResult,
    errorMessage,
    hasGitHubToken,
    tokenChecked,
    gitHubAuthMet,
    sessionReady: true, // Always ready in IPC mode
    workingDir,

    // Actions
    clone,
    cancel,
    reset,
    checkGitHubToken,
    fetchOrgs,
    fetchRepos,
    fetchRefs,
  }
}
