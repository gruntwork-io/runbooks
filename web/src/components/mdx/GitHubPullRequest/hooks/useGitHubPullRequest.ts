import { useCallback, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import { useSession } from '@/contexts/useSession'
import { useRunbookContext } from '@/contexts/useRunbook'
import { normalizeBlockId } from '@/lib/utils'
import type { LogEntry } from '@/hooks/useApiExec'
import type { PRBlockStatus, PRResult, GitHubLabel } from '../types'

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
  const { registerOutputs, blockOutputs: allOutputs } = useRunbookContext()

  // State
  const [status, setStatus] = useState<PRBlockStatus>('pending')
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [prResult, setPRResult] = useState<PRResult | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [pushError, setPushError] = useState<string | null>(null)
  const [labels, setLabels] = useState<GitHubLabel[]>([])
  const [labelsLoading, setLabelsLoading] = useState(false)

  // Abort controller
  const abortControllerRef = useRef<AbortController | null>(null)

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
      const params = new URLSearchParams({ owner, repo })
      const response = await fetch(`/api/github/labels?${params.toString()}`, {
        headers: { ...getAuthHeader() },
      })
      if (response.ok) {
        const data = await response.json()
        setLabels(data.labels ?? [])
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
            setStatus('fail')
          }
        } catch {
          setLogs(prev => [...prev, createLogEntry(`[Malformed server response: ${eventType}]`)])
        }
      }
    }
  }, [id, registerOutputs])

  // Shared helper for SSE-streamed POST requests
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
    setPushError(null)

    await executeSSERequest({
      url: '/api/git/pull-request',
      body: params,
      onError: setErrorMessage,
      errorStatus: 'fail',
      abortStatus: 'ready',
      abortMessage: 'Operation cancelled by user',
      errorPrefix: 'Error',
    })
  }, [executeSSERequest])

  // Push additional changes
  const pushChanges = useCallback(async (localPath: string, branchName: string) => {
    setStatus('pushing')
    setPushError(null)
    setLogs(prev => [...prev, createLogEntry('─────────────────────────────────')])

    await executeSSERequest({
      url: '/api/git/push',
      body: { localPath, branchName },
      onError: setPushError,
      errorStatus: 'success',  // Stay in success state with inline error
      abortStatus: 'success',
      abortMessage: 'Push cancelled',
      errorPrefix: 'Push error',
    })
  }, [executeSSERequest])

  // Cancel operation
  const cancel = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
  }, [])

  // Reset to ready state
  const reset = useCallback(() => {
    setStatus('ready')
    setLogs([])
    setPRResult(null)
    setErrorMessage(null)
    setPushError(null)
  }, [])

  return {
    // State
    status,
    logs,
    prResult,
    errorMessage,
    pushError,
    labels,
    labelsLoading,
    githubAuthMet,
    sessionReady,

    // Actions
    createPullRequest,
    pushChanges,
    fetchLabels,
    cancel,
    reset,
  }
}
