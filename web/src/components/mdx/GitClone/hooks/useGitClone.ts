import { useCallback, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import { Events } from '@wailsio/runtime'
import { useSession } from '@/contexts/useSession'
import { useGruntbookContext } from '@/contexts/useGruntbook'
import { normalizeBlockId } from '@/lib/utils'
import { isDesktop } from '@/lib/wails'
import type { LogEntry } from '@/hooks/useApiExec'
import type { GitCloneStatus, CloneResult, GitHubOrg, GitHubRepo, GitHubRef } from '../types'
import * as GitService from '@/bindings/github.com/gruntwork-io/runbooks/services/gitservice'
import * as GitHubService from '@/bindings/github.com/gruntwork-io/runbooks/services/githubservice'
import * as SessionService from '@/bindings/github.com/gruntwork-io/runbooks/services/sessionservice'
import {
  GitCloneRequest,
  GitHubListRefsRequest,
  GitHubListReposRequest,
} from '@/bindings/github.com/gruntwork-io/runbooks/api/models'

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
  const { getAuthHeader, getToken, isReady: sessionReady } = useSession()
  const { registerOutputs, blockOutputs: allOutputs } = useGruntbookContext()

  // State
  const [cloneStatus, setCloneStatus] = useState<GitCloneStatus>('pending')
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [cloneResult, setCloneResult] = useState<CloneResult | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [hasGitHubToken, setHasGitHubToken] = useState(false)
  const [tokenChecked, setTokenChecked] = useState(false)
  const [workingDir, setWorkingDir] = useState<string | null>(null)

  // Abort controller for cancelling HTTP clone
  const abortControllerRef = useRef<AbortController | null>(null)

  // IPC run tracking for desktop path
  const runIDRef = useRef<string | null>(null)
  const ipcUnsubsRef = useRef<Array<() => void>>([])

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
      if (isDesktop()) {
        const token = getToken() ?? ''
        const meta = await SessionService.Get(token)
        if (meta?.workingDir) setWorkingDir(meta.workingDir)
        return
      }
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
  }, [sessionReady, getAuthHeader, getToken])

  // Detect if a GitHub token is available in the session
  const checkGitHubToken = useCallback(async () => {
    if (!sessionReady) return

    // Fetch working dir in parallel
    fetchWorkingDir()

    try {
      if (isDesktop()) {
        const resp = await GitHubService.ListOrgs()
        const orgs = resp?.orgs ?? []
        const err = resp?.error
        setHasGitHubToken(!err && orgs.length > 0)
      } else {
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
      if (isDesktop()) {
        const resp = await GitHubService.ListOrgs()
        return (resp?.orgs ?? []) as GitHubOrg[]
      }

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
      if (isDesktop()) {
        const req = GitHubListReposRequest.createFrom({ owner, query })
        const resp = await GitHubService.ListRepos(req)
        return (resp?.repos ?? []) as GitHubRepo[]
      }

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

  // Fetch GitHub refs (branches + tags) for a repo
  const fetchRefs = useCallback(async (owner: string, repo: string, query?: string): Promise<{ refs: GitHubRef[]; totalCount: number; hasMore: boolean }> => {
    try {
      if (isDesktop()) {
        const req = GitHubListRefsRequest.createFrom({ owner, repo, query })
        const resp = await GitHubService.ListRefs(req)
        return {
          refs: (resp?.refs ?? []) as GitHubRef[],
          totalCount: resp?.totalCount ?? 0,
          hasMore: resp?.hasMore ?? false,
        }
      }

      const params = new URLSearchParams({ owner, repo })
      if (query) params.set('query', query)

      const response = await fetch(`/api/github/refs?${params.toString()}`, {
        headers: {
          ...getAuthHeader(),
        },
      })

      if (!response.ok) return { refs: [], totalCount: 0, hasMore: false }

      const data = await response.json()
      return {
        refs: data.refs ?? [],
        totalCount: data.totalCount ?? 0,
        hasMore: data.hasMore ?? false,
      }
    } catch {
      return { refs: [], totalCount: 0, hasMore: false }
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

  // Subscribe to `git:<runID>:*` topics for the desktop clone path. Mirrors
  // processSSEStream's state transitions so both transports surface the same
  // UX. Resolves when the `done` event fires so the caller can clear refs.
  const subscribeCloneEvents = useCallback((runID: string): Promise<void> => {
    return new Promise((resolve) => {
      const topic = (event: string) => `git:${runID}:${event}`
      const unsubs: Array<() => void> = []

      unsubs.push(
        Events.On(topic('log'), (ev) => {
          const parsed = LogEventSchema.safeParse(ev.data)
          if (!parsed.success) return
          const newEntry = createLogEntry(parsed.data.line, parsed.data.timestamp)
          setLogs(prev => {
            if (parsed.data.replace && prev.length > 0) {
              return [...prev.slice(0, -1), newEntry]
            }
            return [...prev, newEntry]
          })
        }),
      )

      unsubs.push(
        Events.On(topic('status'), (ev) => {
          const parsed = StatusEventSchema.safeParse(ev.data)
          if (!parsed.success) return
          if (parsed.data.status === 'success') {
            setCloneStatus('success')
          } else {
            setCloneStatus('fail')
          }
        }),
      )

      unsubs.push(
        Events.On(topic('clone_result'), (ev) => {
          const parsed = CloneResultEventSchema.safeParse(ev.data)
          if (parsed.success) setCloneResult(parsed.data)
        }),
      )

      unsubs.push(
        Events.On(topic('outputs'), (ev) => {
          const parsed = OutputsEventSchema.safeParse(ev.data)
          if (parsed.success) registerOutputs(id, parsed.data.outputs)
        }),
      )

      unsubs.push(
        Events.On(topic('error'), (ev) => {
          const data = (ev.data ?? {}) as { message?: string }
          setErrorMessage(data.message || 'Clone failed')
          setCloneStatus('fail')
        }),
      )

      unsubs.push(
        Events.On(topic('done'), () => {
          for (const u of ipcUnsubsRef.current) u()
          ipcUnsubsRef.current = []
          runIDRef.current = null
          resolve()
        }),
      )

      ipcUnsubsRef.current = unsubs
    })
  }, [id, registerOutputs])

  // Execute the clone operation. Returns 'directory_exists' if the destination
  // already exists and force was not set, so the caller can prompt the user.
  const clone = useCallback(async (url: string, ref: string, repoPath: string, localPath: string, usePty?: boolean, force?: boolean): Promise<'directory_exists' | void> => {
    setCloneStatus('running')
    setLogs([])
    setCloneResult(null)
    setErrorMessage(null)

    if (isDesktop()) {
      try {
        const req = GitCloneRequest.createFrom({
          url,
          ref: ref || undefined,
          repo_path: repoPath || undefined,
          local_path: localPath || undefined,
          use_pty: usePty,
          force: force || undefined,
        })

        const result = await GitService.Clone(req)

        if (!result) {
          setErrorMessage('Clone failed: no response from backend')
          setCloneStatus('fail')
          setLogs(prev => [...prev, createLogEntry('Error: Clone returned null')])
          return
        }

        // Pre-flight validation failure (shaped error, no runID)
        if (result.cloneError) {
          if (result.cloneError.code === 'directory_exists') {
            setCloneStatus('ready')
            return 'directory_exists'
          }
          const msg = result.cloneError.message || 'Clone failed'
          setErrorMessage(msg)
          setCloneStatus('fail')
          setLogs(prev => [...prev, createLogEntry(`Error: ${msg}`)])
          return
        }

        if (!result.runId) {
          setErrorMessage('Clone failed: no runID returned')
          setCloneStatus('fail')
          return
        }

        runIDRef.current = result.runId
        await subscribeCloneEvents(result.runId)
        return
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'An unexpected error occurred'
        setErrorMessage(msg)
        setCloneStatus('fail')
        setLogs(prev => [...prev, createLogEntry(`Error: ${msg}`)])
        return
      }
    }

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
  }, [getAuthHeader, processSSEStream, subscribeCloneEvents])

  // Cancel an in-progress clone
  const cancel = useCallback(() => {
    // HTTP path
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }

    // IPC path: tear down listeners + ask backend to stop the run.
    if (ipcUnsubsRef.current.length > 0) {
      for (const u of ipcUnsubsRef.current) u()
      ipcUnsubsRef.current = []
    }
    if (runIDRef.current) {
      const rid = runIDRef.current
      runIDRef.current = null
      GitService.Cancel(rid).catch((err) => {
        console.error('[useGitClone] IPC cancel failed:', err)
      })
      setLogs(prev => [...prev, createLogEntry('Clone cancelled by user')])
      setCloneStatus('ready')
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
