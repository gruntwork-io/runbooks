import { useCallback, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import { useSession } from '@/contexts/useSession'
import { useRunbookContext } from '@/contexts/useRunbook'
import { normalizeBlockId } from '@/lib/utils'
import type { LogEntry } from '@/hooks/useApiExec'
import type { GitCloneStatus, CloneResult, GitHubOrg, GitHubRepo, GitHubBranch } from '../types'

// Zod schemas for SSE events (reuse same format as exec)
const LogEventSchema = z.object({
  line: z.string(),
  timestamp: z.string(),
  replace: z.boolean().optional(),
})

const StatusEventSchema = z.object({
  status: z.enum(['success', 'warn', 'fail']),
  exitCode: z.number(),
})

const CloneResultEventSchema = z.object({
  fileCount: z.number(),
  absolutePath: z.string(),
  relativePath: z.string(),
})

const OutputsEventSchema = z.object({
  outputs: z.record(z.string(), z.string()),
})

function createLogEntry(line: string, timestamp?: string): LogEntry {
  return {
    line,
    timestamp: timestamp ?? new Date().toISOString(),
  }
}

interface UseGitCloneOptions {
  id: string
  gitHubAuthId?: string
}

export function useGitClone({ id, gitHubAuthId }: UseGitCloneOptions) {
  const { getAuthHeader, isReady: sessionReady } = useSession()
  const { registerOutputs, blockOutputs: allOutputs } = useRunbookContext()

  // State
  const [cloneStatus, setCloneStatus] = useState<GitCloneStatus>('pending')
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [cloneResult, setCloneResult] = useState<CloneResult | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [hasGitHubToken, setHasGitHubToken] = useState(false)
  const [tokenChecked, setTokenChecked] = useState(false)
  const [workingDir, setWorkingDir] = useState<string | null>(null)

  // Abort controller for cancelling clone
  const abortControllerRef = useRef<AbortController | null>(null)

  // Check if gitHubAuthId dependency is met
  const gitHubAuthMet = useMemo((): boolean => {
    if (!gitHubAuthId) return true // No dependency

    const normalizedId = normalizeBlockId(gitHubAuthId)
    const blockOutputs = allOutputs[normalizedId]

    // Check for GITHUB_TOKEN in outputs
    if (blockOutputs?.values?.GITHUB_TOKEN && blockOutputs.values.GITHUB_TOKEN !== '') {
      return true
    }

    // Check for __AUTHENTICATED marker (env-prefilled credentials stored server-side)
    if (blockOutputs?.values?.__AUTHENTICATED === 'true') {
      return true
    }

    return false
  }, [gitHubAuthId, allOutputs])

  // Fetch session working directory for path preview
  const fetchWorkingDir = useCallback(async () => {
    if (!sessionReady) return
    try {
      const response = await fetch('/api/session', {
        headers: { ...getAuthHeader() },
      })
      if (response.ok) {
        const data = await response.json()
        if (data.workingDir) {
          setWorkingDir(data.workingDir)
        }
      }
    } catch {
      // Non-critical — path preview just won't show
    }
  }, [sessionReady, getAuthHeader])

  // Detect if a GitHub token is available in the session
  const checkGitHubToken = useCallback(async () => {
    if (!sessionReady) return

    // Fetch working dir in parallel
    fetchWorkingDir()

    try {
      const response = await fetch('/api/github/orgs', {
        headers: {
          ...getAuthHeader(),
        },
      })

      if (response.ok) {
        const data = await response.json()
        // If we got orgs back (even just the user), we have a token
        setHasGitHubToken(!data.error && data.orgs?.length > 0)
      }
    } catch {
      setHasGitHubToken(false)
    } finally {
      setTokenChecked(true)
      setCloneStatus('ready')
    }
  }, [sessionReady, getAuthHeader, fetchWorkingDir])

  // Fetch GitHub organizations
  const fetchOrgs = useCallback(async (): Promise<GitHubOrg[]> => {
    try {
      const response = await fetch('/api/github/orgs', {
        headers: {
          ...getAuthHeader(),
        },
      })

      if (!response.ok) return []

      const data = await response.json()
      return data.orgs ?? []
    } catch {
      return []
    }
  }, [getAuthHeader])

  // Fetch GitHub repositories for an owner
  const fetchRepos = useCallback(async (owner: string, query?: string): Promise<GitHubRepo[]> => {
    try {
      const params = new URLSearchParams({ owner })
      if (query) params.set('query', query)

      const response = await fetch(`/api/github/repos?${params.toString()}`, {
        headers: {
          ...getAuthHeader(),
        },
      })

      if (!response.ok) return []

      const data = await response.json()
      return data.repos ?? []
    } catch {
      return []
    }
  }, [getAuthHeader])

  // Fetch GitHub branches for a repo
  const fetchBranches = useCallback(async (owner: string, repo: string, query?: string): Promise<{ branches: GitHubBranch[]; totalCount: number; hasMore: boolean }> => {
    try {
      const params = new URLSearchParams({ owner, repo })
      if (query) params.set('query', query)

      const response = await fetch(`/api/github/branches?${params.toString()}`, {
        headers: {
          ...getAuthHeader(),
        },
      })

      if (!response.ok) return { branches: [], totalCount: 0, hasMore: false }

      const data = await response.json()
      return {
        branches: data.branches ?? [],
        totalCount: data.totalCount ?? 0,
        hasMore: data.hasMore ?? false,
      }
    } catch {
      return { branches: [], totalCount: 0, hasMore: false }
    }
  }, [getAuthHeader])

  // Process SSE stream from clone endpoint
  const processSSEStream = useCallback(async (response: Response) => {
    const reader = response.body?.getReader()
    const decoder = new TextDecoder()

    if (!reader) {
      throw new Error('No response body')
    }

    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // Process complete SSE messages (separated by \n\n)
      const messages = buffer.split('\n\n')
      buffer = messages.pop() || ''

      for (const message of messages) {
        if (!message.trim()) continue

        const lines = message.split('\n')
        let eventType = ''
        let eventData = ''

        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventType = line.slice(6).trim()
          } else if (line.startsWith('data:')) {
            eventData = line.slice(5).trim()
          }
        }

        if (!eventType || !eventData) continue

        try {
          const data = JSON.parse(eventData)

          if (eventType === 'log') {
            const parsed = LogEventSchema.safeParse(data)
            if (parsed.success) {
              const newEntry = createLogEntry(parsed.data.line, parsed.data.timestamp)
              setLogs(prev => {
                if (parsed.data.replace && prev.length > 0) {
                  return [...prev.slice(0, -1), newEntry]
                }
                return [...prev, newEntry]
              })
            }
          } else if (eventType === 'status') {
            const parsed = StatusEventSchema.safeParse(data)
            if (parsed.success) {
              if (parsed.data.status === 'success') {
                setCloneStatus('success')
              } else {
                setCloneStatus('fail')
              }
            }
          } else if (eventType === 'clone_result') {
            const parsed = CloneResultEventSchema.safeParse(data)
            if (parsed.success) {
              setCloneResult(parsed.data)
            }
          } else if (eventType === 'outputs') {
            const parsed = OutputsEventSchema.safeParse(data)
            if (parsed.success) {
              registerOutputs(id, parsed.data.outputs)
            }
          } else if (eventType === 'error') {
            setErrorMessage(data.message || 'Clone failed')
            setCloneStatus('fail')
          }
        } catch {
          // JSON parse error
          setLogs(prev => [...prev, createLogEntry(`[Malformed server response: ${eventType}]`)])
        }
      }
    }
  }, [id, registerOutputs])

  // Execute the clone operation. Returns 'directory_exists' if the destination
  // already exists and force was not set, so the caller can prompt the user.
  const clone = useCallback(async (url: string, ref: string, repoPath: string, localPath: string, usePty?: boolean, force?: boolean): Promise<'directory_exists' | void> => {
    setCloneStatus('running')
    setLogs([])
    setCloneResult(null)
    setErrorMessage(null)

    const controller = new AbortController()
    abortControllerRef.current = controller

    try {
      const body: Record<string, unknown> = { url }
      if (ref) body.ref = ref
      if (repoPath) body.repo_path = repoPath
      if (localPath) body.local_path = localPath
      if (usePty !== undefined) body.use_pty = usePty
      if (force) body.force = true

      const response = await fetch('/api/git/clone', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeader(),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => null)

        // Directory already exists — signal caller to prompt
        if (response.status === 409 && errorData?.error === 'directory_exists') {
          setCloneStatus('ready')
          return 'directory_exists'
        }

        const msg = errorData?.message || errorData?.error || `Server error (${response.status})`
        setErrorMessage(msg)
        setCloneStatus('fail')
        setLogs(prev => [...prev, createLogEntry(`Error: ${msg}`)])
        return
      }

      await processSSEStream(response)
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        setLogs(prev => [...prev, createLogEntry('Clone cancelled by user')])
        setCloneStatus('ready')
        return
      }

      const msg = error instanceof Error ? error.message : 'An unexpected error occurred'
      setErrorMessage(msg)
      setCloneStatus('fail')
      setLogs(prev => [...prev, createLogEntry(`Error: ${msg}`)])
    } finally {
      abortControllerRef.current = null
    }
  }, [getAuthHeader, processSSEStream])

  // Cancel an in-progress clone
  const cancel = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
  }, [])

  // Reset the block to ready state
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
    sessionReady,
    workingDir,

    // Actions
    clone,
    cancel,
    reset,
    checkGitHubToken,
    fetchOrgs,
    fetchRepos,
    fetchBranches,
  }
}
