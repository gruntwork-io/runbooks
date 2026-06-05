import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import { useRunbookContext } from '@/contexts/useRunbook'
import { normalizeBlockId } from '@/lib/utils'
import type { LogEntry } from '@/hooks/useApiExec'
import type { GitProvider } from '@/components/mdx/GitAuth/types'
import type { PRProviderConfig } from '../providers'
import type { PRBlockStatus, PRResult, GitLabel } from '../types'

/** Body for the create channel (git:pull-request / git:merge-request). Matches
 *  the backend PullRequestRequest contract. */
interface CreateRequestBody {
  worktreePath: string
  owner: string
  repo: string
  title: string
  body: string
  baseBranch: string
  headBranch: string
  commitMessage: string
  labels: string[]
}

/** Body for the git:push channel. */
interface PushRequestBody {
  worktreePath: string
  branchName: string
  provider?: GitProvider
}

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

interface UseGitPullRequestOptions {
  id: string
  /** Provider configuration driving channels, token var, and copy. */
  cfg: PRProviderConfig
  /** Linked auth block id (gitAuthId ?? githubAuthId), if any. */
  authId?: string
  /**
   * Provider derived from the linked auth block (auth outputs ONLY). Used to
   * detect a wrong-auth-block link; undefined means "not derivable" and must
   * never trip the wrong-provider guard.
   */
  authDerivedProvider?: GitProvider
}

export function useGitPullRequest({ id, cfg, authId, authDerivedProvider }: UseGitPullRequestOptions) {
  const { registerOutputs, blockOutputs: allOutputs } = useRunbookContext()

  // State
  const [status, setStatus] = useState<PRBlockStatus>('pending')
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [prResult, setPRResult] = useState<PRResult | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [conflictBranchName, setConflictBranchName] = useState<string | null>(null)
  const [pushError, setPushError] = useState<string | null>(null)
  const [labels, setLabels] = useState<GitLabel[]>([])
  const [labelsLoading, setLabelsLoading] = useState(false)

  // Track whether an operation is in progress for cancellation
  const isRunningRef = useRef(false)
  // Set when the user cancels mid-flight so the pending invoke's continuation
  // (and any late events) don't clobber the reset UI state.
  const canceledRef = useRef(false)
  const isMountedRef = useRef(true)
  // Store active event unsubscribers so unmount can clean them up
  const activeUnsubscribersRef = useRef<Array<() => void>>([])

  useEffect(() => {
    return () => {
      isMountedRef.current = false
      for (const unsub of activeUnsubscribersRef.current) unsub()
      activeUnsubscribersRef.current = []
    }
  }, [])

  // Check if the linked auth dependency is met. Met once the referenced block
  // has emitted this provider's token (or an alt) or the __AUTHENTICATED marker
  // (env-prefilled credentials stored server-side). Token var comes from the
  // provider config, never a literal.
  const authMet = useMemo((): boolean => {
    if (!authId) return true

    const values = allOutputs[normalizeBlockId(authId)]?.values
    if (!values) return false
    if (values[cfg.env.tokenVar] && values[cfg.env.tokenVar] !== '') return true
    if (cfg.env.altTokenVars.some((v) => values[v] && values[v] !== '')) return true
    if (values.__AUTHENTICATED === 'true') return true
    return false
  }, [authId, allOutputs, cfg])

  // True only when a linked auth block resolves to a DIFFERENT provider than
  // this block's. Driven exclusively by the auth-derived provider: when the
  // provider isn't derivable (no link, or auth not resolved yet) this is false
  // and the block falls back to its normal "waiting for auth" state.
  const wrongProvider = useMemo(
    (): boolean => !!authId && authDerivedProvider !== undefined && authDerivedProvider !== cfg.id,
    [authId, authDerivedProvider, cfg],
  )

  // Fetch labels for a repo
  const fetchLabels = useCallback(async (owner: string, repo: string) => {
    if (!owner || !repo) return
    setLabelsLoading(true)
    try {
      const data = await window.api.invoke(cfg.channels.labels, { owner, repo })
      setLabels((data.labels ?? []).map(name => ({ name, color: '', description: undefined })))
    } catch {
      // Non-critical
    } finally {
      setLabelsLoading(false)
    }
  }, [cfg])

  // Shared helper for IPC-based requests with event streaming
  const executeIPCRequest = useCallback(async (opts: {
    channel: 'git:pull-request' | 'git:merge-request' | 'git:push'
    body: CreateRequestBody | PushRequestBody
    onError: (msg: string) => void
    errorStatus: PRBlockStatus
    errorPrefix: string
  }) => {
    // Clear any stale unsubscribers from a previous run
    for (const unsub of activeUnsubscribersRef.current) unsub()
    activeUnsubscribersRef.current = []
    const unsubscribers: Array<() => void> = []
    isRunningRef.current = true
    canceledRef.current = false

    try {
      // Subscribe to IPC events BEFORE invoking the command
      unsubscribers.push(
        window.api.on('git:log', (data: unknown) => {
          if (!isMountedRef.current) return
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
          if (!isMountedRef.current) return
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
          if (!isMountedRef.current) return
          const parsed = PRResultEventSchema.safeParse(data)
          if (parsed.success) {
            setPRResult(parsed.data)
          }
        }),
        window.api.on('git:outputs', (data: unknown) => {
          if (!isMountedRef.current) return
          const parsed = OutputsEventSchema.safeParse(data)
          if (parsed.success) {
            registerOutputs(id, parsed.data.outputs)
          }
        }),
        window.api.on('git:error', (data: unknown) => {
          if (!isMountedRef.current) return
          const errorData = data as { message?: string; code?: string; branchName?: string }
          setErrorMessage(errorData.message || 'Operation failed')
          setErrorCode(errorData.code || null)
          if (errorData.code === 'branch_exists' && errorData.branchName) {
            setConflictBranchName(errorData.branchName)
          }
          setStatus('fail')
        }),
      )
      activeUnsubscribersRef.current = unsubscribers

      // Invoke the IPC command. The channel is one of a fixed set whose params
      // are PullRequestRequest (create) or the push payload; `as never` bridges
      // the union without widening to `any`.
      const result = await window.api.invoke(opts.channel, opts.body as never) as
        | { error?: string; url?: string; number?: number }
        | undefined

      isRunningRef.current = false

      // Resolve final status IMMEDIATELY from the invoke return value — the
      // invoke promise is the most reliable completion signal. The git:status
      // and git:error IPC events are sent by the main handler before returning,
      // so they may have already fired (great), or they may arrive within the
      // next few hundred ms (the 500ms listener window below). Either way the
      // status is correct now and the spinner is never permanently stuck.
      if (isMountedRef.current && !canceledRef.current) {
        if (result && 'error' in result && result.error) {
          opts.onError(result.error)
          setStatus(prev =>
            prev === 'creating' || prev === 'pushing' ? opts.errorStatus : prev,
          )
          // Surface branch-exists code if the git:error event didn't arrive yet
          if (/already exists/i.test(result.error)) {
            setErrorCode(prev => prev ?? 'branch_exists')
            if ('headBranch' in opts.body) {
              setConflictBranchName(prev => prev ?? (opts.body as CreateRequestBody).headBranch)
            }
          }
        } else {
          setStatus(prev =>
            prev === 'creating' || prev === 'pushing' ? 'success' : prev,
          )
        }
      }

      // Keep listeners alive briefly so late-arriving git:pr-result and
      // git:outputs events (URL / outputs registration) can still be processed.
      setTimeout(() => {
        for (const unsub of unsubscribers) unsub()
        activeUnsubscribersRef.current = []
      }, 500)
    } catch (error) {
      if (isMountedRef.current && !canceledRef.current) {
        const msg = error instanceof Error ? error.message : `${opts.errorPrefix} failed`
        opts.onError(msg)
        setStatus(opts.errorStatus)
        setLogs(prev => [...prev, createLogEntry(`${opts.errorPrefix}: ${msg}`)])
      }
      // Clean up listeners immediately on error (no more events expected)
      for (const unsub of unsubscribers) unsub()
      activeUnsubscribersRef.current = []
      isRunningRef.current = false
    }
  }, [id, registerOutputs])

  // Create the pull/merge request.
  //
  // The token is intentionally NOT passed: the main process resolves it from
  // the session environment (populated by the auth block) by provider, so it
  // never crosses the IPC boundary. Field names match the create channel
  // contract (PullRequestRequest).
  const createPullRequest = useCallback(async (params: {
    owner: string
    repo: string
    baseBranch: string
    headBranch: string
    title: string
    body: string
    commitMessage: string
    labels: string[]
    worktreePath: string
  }) => {
    setStatus('creating')
    setLogs([])
    setPRResult(null)
    setErrorMessage(null)
    setErrorCode(null)
    setConflictBranchName(null)
    setPushError(null)

    await executeIPCRequest({
      channel: cfg.channels.create,
      body: params,
      onError: setErrorMessage,
      errorStatus: 'fail',
      errorPrefix: 'Error',
    })
  }, [executeIPCRequest, cfg])

  // Push additional changes. The provider is passed so the main process resolves
  // the matching host token (works for self-hosted instances too).
  const pushChanges = useCallback(async (localPath: string, branchName: string) => {
    setStatus('pushing')
    setPushError(null)
    setLogs(prev => [...prev, createLogEntry('─────────────────────────────────')])

    await executeIPCRequest({
      channel: cfg.channels.push,
      body: { worktreePath: localPath, branchName, provider: cfg.id },
      onError: setPushError,
      errorStatus: 'success',  // Stay in success state with inline error
      errorPrefix: 'Push error',
    })
  }, [executeIPCRequest, cfg])

  // Cancel operation.
  //
  // We can't abort the main-process git work over the existing invoke (there's
  // no cancel channel), but we stop listening for its events and return the UI
  // to a usable state so the user is never trapped on a spinner — previously
  // this only flipped a ref and left `status` stuck at 'creating'/'pushing'.
  const cancel = useCallback(() => {
    canceledRef.current = true
    isRunningRef.current = false
    for (const unsub of activeUnsubscribersRef.current) unsub()
    activeUnsubscribersRef.current = []
    setStatus('ready')
    setErrorMessage(null)
    setErrorCode(null)
    setConflictBranchName(null)
    setPushError(null)
    setLogs(prev => prev.length > 0 ? [...prev, createLogEntry('Canceled.')] : prev)
  }, [])

  // Delete a local branch and reset to ready state
  const deleteBranch = useCallback(async (localPath: string, branchName: string) => {
    try {
      await window.api.invoke(cfg.channels.deleteBranch, { worktreePath: localPath, branch: branchName })

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
  }, [cfg])

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
    authMet,
    wrongProvider,

    // Actions
    createPullRequest,
    pushChanges,
    deleteBranch,
    fetchLabels,
    cancel,
    reset,
  }
}
