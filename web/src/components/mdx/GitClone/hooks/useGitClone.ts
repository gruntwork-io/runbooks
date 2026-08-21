import { useCallback, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import { useApi } from '@/contexts/ApiContext'
import { useRunbookContext } from '@/contexts/useRunbook'
import { normalizeBlockId } from '@/lib/utils'
import { deriveProviderFromAuth } from '@/components/mdx/_shared/lib/gitProvider'
import type { LogEntry } from '@/hooks/useApiExec'
import type { GitCloneStatus, CloneResult, GitHubOrg, GitHubRepo, GitHubRef, LocalRepoInfo } from '../types'

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

  // Local-checkout preview: what `git:local-repo` reports about the directory
  // currently typed/picked, before the user confirms it.
  const [localPreview, setLocalPreview] = useState<LocalRepoInfo | null>(null)
  const [localPreviewStatus, setLocalPreviewStatus] = useState<'idle' | 'checking' | 'valid' | 'invalid'>('idle')
  const [localPreviewError, setLocalPreviewError] = useState<string | null>(null)

  // Guards against a slow preview for an earlier path landing after a newer one.
  const previewSeqRef = useRef(0)

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
      if (localPath) body.localPath = localPath
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

  // Open the native folder picker and return the chosen directory, if any.
  // Kept in the hook so every IPC call this block makes goes through useApi().
  const browseForRepoDir = useCallback(async (): Promise<string | null> => {
    try {
      const result = await api.invoke('native:show-open-dialog', {
        properties: ['openDirectory'],
      })
      return result?.filePaths?.[0] ?? null
    } catch {
      // Dialog dismissed or unavailable.
      return null
    }
  }, [api])

  // Inspect a local checkout WITHOUT registering it, to drive the inline
  // "is this a git repo?" preview as the user types or browses.
  const previewLocalRepo = useCallback(async (repoDir: string) => {
    const seq = ++previewSeqRef.current
    if (!repoDir.trim()) {
      setLocalPreview(null)
      setLocalPreviewStatus('idle')
      setLocalPreviewError(null)
      return
    }

    setLocalPreviewStatus('checking')
    try {
      const result = await api.invoke('git:local-repo', { path: repoDir.trim() })
      if (seq !== previewSeqRef.current) return // superseded by a newer path
      if (result.status === 'success') {
        setLocalPreview(result as LocalRepoInfo)
        setLocalPreviewStatus('valid')
        setLocalPreviewError(null)
      } else {
        setLocalPreview(null)
        setLocalPreviewStatus('invalid')
        setLocalPreviewError(result.error ?? 'Not a git repository')
      }
    } catch (error) {
      if (seq !== previewSeqRef.current) return
      setLocalPreview(null)
      setLocalPreviewStatus('invalid')
      setLocalPreviewError(error instanceof Error ? error.message : 'Failed to inspect directory')
    }
  }, [api])

  // Confirm a local checkout: register it as a session worktree and emit the
  // same outputs a clone would, so downstream blocks can't tell the difference.
  // Returns the repo metadata so the caller can register the worktree in the
  // renderer's GitWorkTree context.
  const selectLocalRepo = useCallback(async (repoDir: string): Promise<LocalRepoInfo | null> => {
    setCloneStatus('running')
    setErrorMessage(null)
    setCloneResult(null)

    try {
      const result = await api.invoke('git:local-repo', {
        path: repoDir.trim(),
        register: true,
        ...(authProvider ? { provider: authProvider } : {}),
      })

      if (result.status !== 'success') {
        setErrorMessage(result.error ?? 'Failed to use local checkout')
        setCloneStatus('fail')
        return null
      }

      if (result.outputs) {
        registerOutputs(id, result.outputs)
      }
      setCloneResult({
        fileCount: result.fileCount ?? 0,
        absolutePath: result.absolutePath ?? '',
        relativePath: result.relativePath ?? '',
      })
      setCloneStatus('success')
      return result as LocalRepoInfo
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'An unexpected error occurred'
      setErrorMessage(msg)
      setCloneStatus('fail')
      return null
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

  // The local checkout's own metadata survives a reset — the preview is
  // re-run from the form's current path when the user returns to it.
  const resetLocalPreview = useCallback(() => {
    previewSeqRef.current++
    setLocalPreview(null)
    setLocalPreviewStatus('idle')
    setLocalPreviewError(null)
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
    workingDir,
    localPreview,
    localPreviewStatus,
    localPreviewError,

    // Actions
    clone,
    browseForRepoDir,
    previewLocalRepo,
    selectLocalRepo,
    resetLocalPreview,
    cancel,
    reset,
    checkGitHubToken,
    fetchOrgs,
    fetchRepos,
    fetchRefs,
  }
}
