import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import { useApi } from '@/contexts/ApiContext'
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

/** What a create or push invoke resolves with: the PR/MR's url and number
 *  after a create, `error` after a failure. */
type OperationResult = { error?: string; url?: string; number?: number } | undefined

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

/**
 * How long a new operation waits for a canceled one to finish before starting
 * anyway. The main-process git/API work has no timeout, so without a bound a
 * hung canceled run would block every later operation until the runbook is
 * reopened.
 */
export const CANCELED_RUN_WAIT_MS = 30_000

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
  const api = useApi()
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

  // Token of the current operation. Every executeIPCRequest takes a new one and
  // cancel() bumps it, so a superseded run's continuation (and any late events)
  // can't clobber the reset UI state or a newer run's state.
  const opRef = useRef(0)
  // The latest run's pending invoke, if any. Cancel can't abort the
  // main-process work, so a new operation waits (up to CANCELED_RUN_WAIT_MS)
  // for it to settle before subscribing: the events carry no operation id, so
  // overlapping runs' events would be indistinguishable. Only the latest
  // invoke is tracked; see executeIPCRequest for what that leaves open.
  const inFlightRef = useRef<Promise<OperationResult> | null>(null)
  const isMountedRef = useRef(true)
  // Store active event unsubscribers so unmount can clean them up
  const activeUnsubscribersRef = useRef<Array<() => void>>([])

  useEffect(() => {
    // Reset to true on every mount (including Strict Mode's remount cycle, which
    // runs the cleanup below and then re-runs the setup — without this the ref
    // stays false after the Strict Mode unmount and all IPC continuations bail).
    isMountedRef.current = true
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

  // Fetch labels for a repo. `host` targets the repo's own instance (GitLab
  // self-hosted or gitlab.com; GitHub Enterprise or github.com).
  const fetchLabels = useCallback(async (owner: string, repo: string, host?: string) => {
    if (!owner || !repo) return
    setLabelsLoading(true)
    try {
      const data = await api.invoke(cfg.channels.labels, { owner, repo, host })
      setLabels((data.labels ?? []).map(name => ({ name, color: '', description: undefined })))
    } catch {
      // Non-critical
    } finally {
      setLabelsLoading(false)
    }
  }, [api, cfg])

  // Shared helper for IPC-based requests with event streaming
  const executeIPCRequest = useCallback(async (opts: {
    channel: 'git:pull-request' | 'git:merge-request' | 'git:push'
    body: CreateRequestBody | PushRequestBody
    onError: (msg: string) => void
    errorStatus: PRBlockStatus
    errorPrefix: string
  }) => {
    const op = ++opRef.current
    const isCurrent = () => isMountedRef.current && op === opRef.current

    // Clear any stale unsubscribers from a previous run
    for (const unsub of activeUnsubscribersRef.current) unsub()
    activeUnsubscribersRef.current = []
    const unsubscribers: Array<() => void> = []

    // A canceled run may still be working in the main process. Wait for it so
    // its events and result can't land in this run, and so two runs don't
    // touch the worktree at once. Canceling again while waiting still works.
    //
    // Known limit: the wait is bounded. Past CANCELED_RUN_WAIT_MS this run
    // starts anyway and replaces inFlightRef with its own invoke, so the
    // canceled run is no longer tracked: it can run git in the worktree
    // alongside this run, and no later operation waits for it either. Whenever
    // it does return, its git:log, git:pr-result, git:outputs, git:error and
    // git:status events reach whichever operation is listening at that moment
    // (this run, or a later one, such as a Push after this run succeeds). They
    // can switch the displayed PR/MR, replace the block's registered outputs
    // with its own and flip the status. Only its invoke result stays ignored.
    // Closing this needs an operation id on every git:* event.
    const canceledRun = inFlightRef.current
    if (canceledRun) {
      setLogs(prev => [...prev, createLogEntry('Waiting for the canceled operation to finish…')])
      let timer: ReturnType<typeof setTimeout> | undefined
      const finished = await Promise.race([
        canceledRun.then(result => ({ result }), () => ({ result: undefined })),
        new Promise<null>(resolve => {
          timer = setTimeout(() => resolve(null), CANCELED_RUN_WAIT_MS)
        }),
      ])
      clearTimeout(timer)
      if (!isCurrent()) return
      // Its PR/MR and outputs stay out of this run, but the user should know it
      // was opened rather than lose it silently.
      const openedUrl = finished?.result?.url
      if (!finished) {
        setLogs(prev => [...prev, createLogEntry(
          'The canceled operation is still running in the background. Starting anyway; its output may still appear here.',
        )])
      } else if (openedUrl) {
        setLogs(prev => [...prev, createLogEntry(`The canceled operation finished and opened ${openedUrl}`)])
      }
    }

    try {
      // Subscribe to IPC events BEFORE invoking the command
      unsubscribers.push(
        api.on('git:log', (data: unknown) => {
          if (!isCurrent()) return
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
        // A failure maps to the operation's errorStatus: 'fail' for create,
        // but a failed push leaves the created PR/MR on screen ('success').
        api.on('git:status', (data: unknown) => {
          if (!isCurrent()) return
          const parsed = StatusEventSchema.safeParse(data)
          if (parsed.success) {
            setStatus(parsed.data.status === 'success' ? 'success' : opts.errorStatus)
          }
        }),
        api.on('git:pr-result', (data: unknown) => {
          if (!isCurrent()) return
          const parsed = PRResultEventSchema.safeParse(data)
          if (parsed.success) {
            setPRResult(parsed.data)
          }
        }),
        api.on('git:outputs', (data: unknown) => {
          if (!isCurrent()) return
          const parsed = OutputsEventSchema.safeParse(data)
          if (parsed.success) {
            registerOutputs(id, parsed.data.outputs)
          }
        }),
        api.on('git:error', (data: unknown) => {
          if (!isCurrent()) return
          const errorData = data as { message?: string; code?: string; branchName?: string }
          opts.onError(errorData.message || 'Operation failed')
          setErrorCode(errorData.code || null)
          if (errorData.code === 'branch_exists' && errorData.branchName) {
            setConflictBranchName(errorData.branchName)
          }
          setStatus(opts.errorStatus)
        }),
      )
      activeUnsubscribersRef.current = unsubscribers

      // Invoke the IPC command. The channel is one of a fixed set whose params
      // are PullRequestRequest (create) or the push payload; `as never` bridges
      // the union without widening to `any`.
      const invocation = api.invoke(opts.channel, opts.body as never) as Promise<OperationResult>
      inFlightRef.current = invocation
      const result = await invocation.finally(() => {
        if (inFlightRef.current === invocation) inFlightRef.current = null
      })

      // Resolve final status IMMEDIATELY from the invoke return value — the
      // invoke promise is the most reliable completion signal, so the spinner
      // is never permanently stuck. The main handler sends git:status and
      // git:error before returning, so the listeners above have usually applied
      // them already; any that arrive later (within the 500ms listener window
      // below) go through the same operation-aware mapping.
      if (isCurrent()) {
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
      // Leave the ref alone if a newer operation has replaced these listeners.
      setTimeout(() => {
        for (const unsub of unsubscribers) unsub()
        if (activeUnsubscribersRef.current === unsubscribers) activeUnsubscribersRef.current = []
      }, 500)
    } catch (error) {
      if (isCurrent()) {
        const msg = error instanceof Error ? error.message : `${opts.errorPrefix} failed`
        opts.onError(msg)
        setStatus(opts.errorStatus)
        setLogs(prev => [...prev, createLogEntry(`${opts.errorPrefix}: ${msg}`)])
      }
      // Clean up listeners immediately on error (no more events expected)
      for (const unsub of unsubscribers) unsub()
      if (activeUnsubscribersRef.current === unsubscribers) activeUnsubscribersRef.current = []
    }
  }, [api, id, registerOutputs])

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
      // The PR/MR already exists: keep showing it, with the push error inline.
      errorStatus: 'success',
      errorPrefix: 'Push error',
    })
  }, [executeIPCRequest, cfg])

  // Cancel operation.
  //
  // We can't abort the main-process git work over the existing invoke (there's
  // no cancel channel), but we stop listening for its events, ignore its result
  // and return the UI to a usable state so the user is never trapped on a
  // spinner. The next operation waits, for a bounded time, for the canceled
  // one to finish.
  const cancel = useCallback(() => {
    opRef.current++
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
      await api.invoke(cfg.channels.deleteBranch, { worktreePath: localPath, branch: branchName })

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
  }, [api, cfg])

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
