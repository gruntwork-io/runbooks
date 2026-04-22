import { useCallback, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import { Events } from '@wailsio/runtime'
import { useSession } from '@/contexts/useSession'
import { useGruntbookContext } from '@/contexts/useGruntbook'
import { normalizeBlockId } from '@/lib/utils'
import { isDesktop } from '@/lib/wails'
import type { LogEntry } from '@/hooks/useApiExec'
import type { PRBlockStatus, PRResult, GitHubLabel } from '../types'
import * as GitService from '@/bindings/github.com/gruntwork-io/runbooks/services/gitservice'
import * as GitHubService from '@/bindings/github.com/gruntwork-io/runbooks/services/githubservice'
import {
  CreatePullRequestRequest,
  GitDeleteBranchRequest,
  GitHubListLabelsRequest,
  GitPushRequest,
} from '@/bindings/github.com/gruntwork-io/runbooks/api/models'

// Zod schemas for SSE events
const LogEventSchema = z.object({
  line: z.string(),
  timestamp: z.string(),
  replace: z.boolean().optional(),
})

const StatusEventSchema = z.object({
  status: z.enum(['success', 'warn', 'fail']),
  exitCode: z.number(),
})

const PRResultEventSchema = z.object({
  prUrl: z.string(),
  prNumber: z.number(),
  branchName: z.string(),
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

interface UseGitHubPullRequestOptions {
  id: string
  githubAuthId?: string
}

export function useGitHubPullRequest({ id, githubAuthId }: UseGitHubPullRequestOptions) {
  const { getAuthHeader, isReady: sessionReady } = useSession()
  const { registerOutputs, blockOutputs: allOutputs } = useGruntbookContext()

  // State
  const [status, setStatus] = useState<PRBlockStatus>('pending')
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [prResult, setPRResult] = useState<PRResult | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [conflictBranchName, setConflictBranchName] = useState<string | null>(null)
  const [pushError, setPushError] = useState<string | null>(null)
  const [labels, setLabels] = useState<GitHubLabel[]>([])
  const [labelsLoading, setLabelsLoading] = useState(false)

  // Abort controller (HTTP path)
  const abortControllerRef = useRef<AbortController | null>(null)

  // IPC run tracking for desktop path
  const runIDRef = useRef<string | null>(null)
  const ipcUnsubsRef = useRef<Array<() => void>>([])

  // Check if githubAuthId dependency is met
  const githubAuthMet = useMemo((): boolean => {
    if (!githubAuthId) return true

    const normalizedId = normalizeBlockId(githubAuthId)
    const blockOutputs = allOutputs[normalizedId]

    if (blockOutputs?.values?.GITHUB_TOKEN && blockOutputs.values.GITHUB_TOKEN !== '') {
      return true
    }

    if (blockOutputs?.values?.__AUTHENTICATED === 'true') {
      return true
    }

    return false
  }, [githubAuthId, allOutputs])

  // Fetch labels for a repo
  const fetchLabels = useCallback(async (owner: string, repo: string) => {
    if (!owner || !repo) return
    setLabelsLoading(true)
    try {
      if (isDesktop()) {
        const req = GitHubListLabelsRequest.createFrom({ owner, repo })
        const resp = await GitHubService.ListLabels(req)
        setLabels((resp?.labels ?? []) as GitHubLabel[])
      } else {
        const params = new URLSearchParams({ owner, repo })
        const response = await fetch(`/api/github/labels?${params.toString()}`, {
          headers: { ...getAuthHeader() },
        })
        if (response.ok) {
          const data = await response.json()
          setLabels(data.labels ?? [])
        }
      }
    } catch {
      // Non-critical
    } finally {
      setLabelsLoading(false)
    }
  }, [getAuthHeader])

  // Process SSE stream
  const processSSEStream = useCallback(async (response: Response, onSuccess?: () => void) => {
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
            eventData += (eventData ? '\n' : '') + line.slice(5).trim()
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
                onSuccess?.()
              } else {
                setStatus('fail')
              }
            }
          } else if (eventType === 'pr_result') {
            const parsed = PRResultEventSchema.safeParse(data)
            if (parsed.success) {
              setPRResult(parsed.data)
            }
          } else if (eventType === 'outputs') {
            const parsed = OutputsEventSchema.safeParse(data)
            if (parsed.success) {
              registerOutputs(id, parsed.data.outputs)
            }
          } else if (eventType === 'error') {
            setErrorMessage(data.message || 'Operation failed')
            setErrorCode(data.code || null)
            if (data.code === 'branch_exists' && data.branchName) {
              setConflictBranchName(data.branchName)
            }
            setStatus('fail')
          }
        } catch {
          setLogs(prev => [...prev, createLogEntry(`[Malformed server response: ${eventType}]`)])
        }
      }
    }
  }, [id, registerOutputs])

  // Subscribe to `git:<runID>:*` topics for the desktop streaming path.
  // Mirrors processSSEStream's state transitions. Resolves when the
  // terminal `done` event fires so the caller can clear refs.
  const subscribeGitEvents = useCallback((runID: string, onSuccess: () => void, errorStatus: PRBlockStatus): Promise<void> => {
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
            onSuccess()
          } else {
            setStatus(errorStatus)
          }
        }),
      )

      unsubs.push(
        Events.On(topic('pr_result'), (ev) => {
          const parsed = PRResultEventSchema.safeParse(ev.data)
          if (parsed.success) setPRResult(parsed.data)
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
          const data = (ev.data ?? {}) as { message?: string; code?: string; branchName?: string }
          setErrorMessage(data.message || 'Operation failed')
          setErrorCode(data.code || null)
          if (data.code === 'branch_exists' && data.branchName) {
            setConflictBranchName(data.branchName)
          }
          setStatus(errorStatus)
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

  // Shared helper for SSE-streamed POST requests (HTTP fallback)
  const executeSSERequest = useCallback(async (opts: {
    url: string
    body: unknown
    onError: (msg: string) => void
    errorStatus: PRBlockStatus
    abortStatus: PRBlockStatus
    abortMessage: string
    errorPrefix: string
  }) => {
    const controller = new AbortController()
    abortControllerRef.current = controller

    try {
      const response = await fetch(opts.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
        body: JSON.stringify(opts.body),
        signal: controller.signal,
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => null)
        const msg = errorData?.message || errorData?.error || `Server error (${response.status})`
        opts.onError(msg)
        setStatus(opts.errorStatus)
        setLogs(prev => [...prev, createLogEntry(`${opts.errorPrefix}: ${msg}`)])
        return
      }

      await processSSEStream(response, () => {
        setStatus('success')
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        setLogs(prev => [...prev, createLogEntry(opts.abortMessage)])
        setStatus(opts.abortStatus)
        return
      }

      const msg = error instanceof Error ? error.message : `${opts.errorPrefix} failed`
      opts.onError(msg)
      setStatus(opts.errorStatus)
      setLogs(prev => [...prev, createLogEntry(`${opts.errorPrefix}: ${msg}`)])
    } finally {
      abortControllerRef.current = null
    }
  }, [getAuthHeader, processSSEStream])

  // Create pull request
  const createPullRequest = useCallback(async (params: {
    title: string
    description: string
    labels: string[]
    branchName: string
    commitMessage: string
    localPath: string
    repoUrl: string
  }) => {
    setStatus('creating')
    setLogs([])
    setPRResult(null)
    setErrorMessage(null)
    setErrorCode(null)
    setConflictBranchName(null)
    setPushError(null)

    if (isDesktop()) {
      try {
        const req = CreatePullRequestRequest.createFrom({
          title: params.title,
          description: params.description,
          labels: params.labels,
          branchName: params.branchName,
          commitMessage: params.commitMessage,
          localPath: params.localPath,
          repoUrl: params.repoUrl,
        })
        const result = await GitService.PullRequest(req)

        if (!result) {
          setErrorMessage('Failed to create pull request')
          setStatus('fail')
          setLogs(prev => [...prev, createLogEntry('Error: PullRequest returned null')])
          return
        }

        if (result.error) {
          const msg = result.error.message || 'Failed to create pull request'
          setErrorMessage(msg)
          setErrorCode(result.error.code || null)
          setStatus('fail')
          setLogs(prev => [...prev, createLogEntry(`Error: ${msg}`)])
          return
        }

        if (!result.runId) {
          setErrorMessage('Failed to start pull request flow')
          setStatus('fail')
          return
        }

        runIDRef.current = result.runId
        await subscribeGitEvents(result.runId, () => setStatus('success'), 'fail')
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unexpected error'
        setErrorMessage(msg)
        setStatus('fail')
        setLogs(prev => [...prev, createLogEntry(`Error: ${msg}`)])
      }
      return
    }

    await executeSSERequest({
      url: '/api/git/pull-request',
      body: params,
      onError: setErrorMessage,
      errorStatus: 'fail',
      abortStatus: 'ready',
      abortMessage: 'Operation cancelled by user',
      errorPrefix: 'Error',
    })
  }, [executeSSERequest, subscribeGitEvents])

  // Push additional changes
  const pushChanges = useCallback(async (localPath: string, branchName: string) => {
    setStatus('pushing')
    setPushError(null)
    setLogs(prev => [...prev, createLogEntry('─────────────────────────────────')])

    if (isDesktop()) {
      try {
        const req = GitPushRequest.createFrom({ localPath, branchName })
        const result = await GitService.Push(req)

        if (!result) {
          setPushError('Push failed: no response from backend')
          setStatus('success') // inline error, stay in success state
          return
        }

        if (result.error) {
          const msg = result.error.message || 'Push failed'
          setPushError(msg)
          setStatus('success')
          setLogs(prev => [...prev, createLogEntry(`Push error: ${msg}`)])
          return
        }

        if (!result.runId) {
          setPushError('Push failed to start')
          setStatus('success')
          return
        }

        runIDRef.current = result.runId
        await subscribeGitEvents(result.runId, () => setStatus('success'), 'success')
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Push failed'
        setPushError(msg)
        setStatus('success')
        setLogs(prev => [...prev, createLogEntry(`Push error: ${msg}`)])
      }
      return
    }

    await executeSSERequest({
      url: '/api/git/push',
      body: { localPath, branchName },
      onError: setPushError,
      errorStatus: 'success',  // Stay in success state with inline error
      abortStatus: 'success',
      abortMessage: 'Push cancelled',
      errorPrefix: 'Push error',
    })
  }, [executeSSERequest, subscribeGitEvents])

  // Cancel operation
  const cancel = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }

    if (ipcUnsubsRef.current.length > 0) {
      for (const u of ipcUnsubsRef.current) u()
      ipcUnsubsRef.current = []
    }
    if (runIDRef.current) {
      const rid = runIDRef.current
      runIDRef.current = null
      GitService.Cancel(rid).catch((err) => {
        console.error('[useGitHubPullRequest] IPC cancel failed:', err)
      })
    }
  }, [])

  // Delete a local branch and reset to ready state
  const deleteBranch = useCallback(async (localPath: string, branchName: string) => {
    if (isDesktop()) {
      try {
        const req = GitDeleteBranchRequest.createFrom({ localPath, branchName })
        const resp = await GitService.DeleteBranch(req)
        if (!resp || resp.error) {
          setErrorMessage(resp?.error || 'Failed to delete branch')
          setErrorCode(resp?.code || null)
          setConflictBranchName(null)
          return
        }
        setErrorMessage(null)
        setErrorCode(null)
        setConflictBranchName(null)
        setStatus('ready')
        setLogs([])
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Failed to delete branch'
        setErrorMessage(msg)
        setErrorCode(null)
        setConflictBranchName(null)
      }
      return
    }

    const response = await fetch('/api/git/branch', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
      body: JSON.stringify({ localPath, branchName }),
    })

    if (!response.ok) {
      const data = await response.json().catch(() => null)
      setErrorMessage(data?.error || `Failed to delete branch (${response.status})`)
      setErrorCode(null)
      setConflictBranchName(null)
      return
    }

    setErrorMessage(null)
    setErrorCode(null)
    setConflictBranchName(null)
    setStatus('ready')
    setLogs([])
  }, [getAuthHeader])

  // Reset to ready state
  const reset = useCallback(() => {
    setStatus('ready')
    setLogs([])
    setPRResult(null)
    setErrorMessage(null)
    setErrorCode(null)
    setConflictBranchName(null)
    setPushError(null)
  }, [])

  return {
    // State
    status,
    logs,
    prResult,
    errorMessage,
    errorCode,
    conflictBranchName,
    pushError,
    labels,
    labelsLoading,
    githubAuthMet,
    sessionReady,

    // Actions
    createPullRequest,
    pushChanges,
    deleteBranch,
    fetchLabels,
    cancel,
    reset,
  }
}
