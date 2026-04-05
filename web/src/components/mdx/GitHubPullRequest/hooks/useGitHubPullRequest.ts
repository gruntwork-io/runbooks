import { useCallback, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import { useRunbookContext } from '@/contexts/useRunbook'
import { normalizeBlockId } from '@/lib/utils'
import type { LogEntry } from '@/hooks/useApiExec'
import type { PRBlockStatus, PRResult, GitHubLabel } from '../types'

// Zod schemas for IPC events
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
  const { registerOutputs, blockOutputs: allOutputs } = useRunbookContext()

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

  // Track whether an operation is in progress for cancellation
  const isRunningRef = useRef(false)

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
      const data = await window.api.invoke('github:labels', { owner, repo })
      setLabels(data.labels ?? [])
    } catch {
      // Non-critical
    } finally {
      setLabelsLoading(false)
    }
  }, [])

  // Shared helper for IPC-based requests with event streaming
  const executeIPCRequest = useCallback(async (opts: {
    channel: string
    body: unknown
    onError: (msg: string) => void
    errorStatus: PRBlockStatus
    errorPrefix: string
  }) => {
    const unsubscribers: Array<() => void> = []
    isRunningRef.current = true

    try {
      // Subscribe to IPC events BEFORE invoking the command
      unsubscribers.push(
        window.api.on('git:log', (data: unknown) => {
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
        }),
        window.api.on('git:status', (data: unknown) => {
          const parsed = StatusEventSchema.safeParse(data)
          if (parsed.success) {
            if (parsed.data.status === 'success') {
              setStatus('success')
            } else {
              setStatus('fail')
            }
          }
        }),
        window.api.on('git:pr-result', (data: unknown) => {
          const parsed = PRResultEventSchema.safeParse(data)
          if (parsed.success) {
            setPRResult(parsed.data)
          }
        }),
        window.api.on('git:outputs', (data: unknown) => {
          const parsed = OutputsEventSchema.safeParse(data)
          if (parsed.success) {
            registerOutputs(id, parsed.data.outputs)
          }
        }),
        window.api.on('git:error', (data: unknown) => {
          const errorData = data as { message?: string; code?: string; branchName?: string }
          setErrorMessage(errorData.message || 'Operation failed')
          setErrorCode(errorData.code || null)
          if (errorData.code === 'branch_exists' && errorData.branchName) {
            setConflictBranchName(errorData.branchName)
          }
          setStatus('fail')
        }),
      )

      // Invoke the IPC command
      await window.api.invoke(opts.channel, opts.body)
    } catch (error) {
      const msg = error instanceof Error ? error.message : `${opts.errorPrefix} failed`
      opts.onError(msg)
      setStatus(opts.errorStatus)
      setLogs(prev => [...prev, createLogEntry(`${opts.errorPrefix}: ${msg}`)])
    } finally {
      // Unsubscribe from all events
      for (const unsub of unsubscribers) {
        unsub()
      }
      isRunningRef.current = false
    }
  }, [id, registerOutputs])

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

    await executeIPCRequest({
      channel: 'git:pull-request',
      body: params,
      onError: setErrorMessage,
      errorStatus: 'fail',
      errorPrefix: 'Error',
    })
  }, [executeIPCRequest])

  // Push additional changes
  const pushChanges = useCallback(async (localPath: string, branchName: string) => {
    setStatus('pushing')
    setPushError(null)
    setLogs(prev => [...prev, createLogEntry('─────────────────────────────────')])

    await executeIPCRequest({
      channel: 'git:push',
      body: { localPath, branchName },
      onError: setPushError,
      errorStatus: 'success',  // Stay in success state with inline error
      errorPrefix: 'Push error',
    })
  }, [executeIPCRequest])

  // Cancel operation
  const cancel = useCallback(() => {
    if (isRunningRef.current) {
      isRunningRef.current = false
    }
  }, [])

  // Delete a local branch and reset to ready state
  const deleteBranch = useCallback(async (localPath: string, branchName: string) => {
    try {
      await window.api.invoke('git:delete-branch', { localPath, branchName })

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
  }, [])

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

    // Actions
    createPullRequest,
    pushChanges,
    deleteBranch,
    fetchLabels,
    cancel,
    reset,
  }
}
