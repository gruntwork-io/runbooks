import { useCallback, useMemo, useRef, useState } from 'react'
import { useApi } from '@/contexts/ApiContext'
import { useRunbookContext } from '@/contexts/useRunbook'
import { normalizeBlockId } from '@/lib/utils'
import type { LogEntry } from '@/hooks/useApiExec'
import type { GitCloneStatus, CloneResult, GitHubOrg, GitHubRepo, GitHubRef } from '../types'

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

  // Fetch GitHub organizations
  const fetchOrgs = useCallback(async (): Promise<GitHubOrg[]> => {
    try {
      const orgs = await api.invoke('github:orgs')
      return orgs ?? []
    } catch {
      return []
    }
  }, [api])

  // Fetch GitHub repositories for an owner
  const fetchRepos = useCallback(async (owner: string, _query?: string): Promise<GitHubRepo[]> => {
    try {
      const repos = await api.invoke('github:repos', { org: owner })
      return repos ?? []
    } catch {
      return []
    }
  }, [api])

  // Fetch GitHub refs (branches + tags) for a repo
  const fetchRefs = useCallback(async (owner: string, repo: string, _query?: string): Promise<{ refs: GitHubRef[]; totalCount: number; hasMore: boolean }> => {
    try {
      const refs = await api.invoke('github:refs', { owner, repo })
      return {
        refs: refs ?? [],
        totalCount: refs?.length ?? 0,
        hasMore: false,
      }
    } catch {
      return { refs: [], totalCount: 0, hasMore: false }
    }
  }, [api])

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

      // Subscribe to streaming events before starting the clone
      const unsubLog = window.api.on('git:clone-progress', (data: { line: string; timestamp?: string; replace?: boolean }) => {
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
      })

      try {
        const result = await window.api.invoke<{
          status: string
          error?: string
          fileCount?: number
          absolutePath?: string
          relativePath?: string
          outputs?: Record<string, string>
        }>('git:clone', body)

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
      } finally {
        unsubLog()
      }
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
    fetchRefs,
  }
}
