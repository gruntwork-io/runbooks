import { describe, it, expect, vi, afterEach } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderHook, act, waitFor } from '@testing-library/react'
import { ApiProvider, type RunbooksAPI } from '@/contexts/ApiContext'
import { RunbookContextProvider } from '@/contexts/RunbookContext'
import { useRunbookContext } from '@/contexts/useRunbook'
import { normalizeBlockId } from '@/lib/utils'
import { PR_PROVIDERS, type PRProviderConfig } from '../../providers'
import { useGitPullRequest } from '../useGitPullRequest'

/**
 * `useGitPullRequest` under test with the IPC surface as the only fake. The
 * hook runs inside the real ApiProvider and RunbookContextProvider, so output
 * registration is observed through the real `blockOutputs`.
 *
 * The fake main process mirrors electron/main/ipc/git.ts: it sends the
 * streamed events (git:log, git:pr-result, git:outputs, git:error,
 * git:status) BEFORE the invoke resolves, which is the order that decides how
 * the hook reconciles the events with the invoke result.
 */

type Listener = (data: unknown) => void

/** Channels whose invoke stays pending until a test settles it. */
const OPERATION_CHANNELS = new Set(['git:pull-request', 'git:merge-request', 'git:push'])

function createEmittingApi() {
  const listeners = new Map<string, Set<Listener>>()
  const pending: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = []

  const invoke = vi.fn((channel: string, _body?: unknown) => {
    if (!OPERATION_CHANNELS.has(channel)) return Promise.resolve({})
    return new Promise<unknown>((resolve, reject) => {
      pending.push({ resolve, reject })
    })
  })

  const api = {
    invoke,
    on: (channel: string, callback: Listener) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set())
      listeners.get(channel)!.add(callback)
      return () => {
        listeners.get(channel)?.delete(callback)
      }
    },
    once: () => {},
  } as unknown as RunbooksAPI

  const emit = (channel: string, data: unknown) => {
    for (const callback of listeners.get(channel) ?? []) callback(data)
  }

  return {
    api,
    invoke,
    emit,
    /** Settle the nth operation invoke (0-based, in call order). */
    resolve: (n: number, value: unknown) => pending[n].resolve(value),
    reject: (n: number, error: Error) => pending[n].reject(error),
    /** Total subscribed listeners across every channel. */
    listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),

    // The main process's responses, in git.ts's order.

    /** respondToGitPrExit on success: pr-result, outputs, status, then return. */
    createSucceeds(n: number, pr: TestPR) {
      emit('git:log', { line: `Opened ${pr.url}`, timestamp: '2026-01-01T00:00:00Z' })
      emit('git:pr-result', { prUrl: pr.url, prNumber: pr.number, branchName: pr.branch })
      emit('git:outputs', { outputs: pr.outputs })
      emit('git:status', { status: 'success', exitCode: 0 })
      pending[n].resolve({ url: pr.url, number: pr.number })
    },
    /** respondToGitPrExit on failure: error (with any code), status, then return. */
    createFails(n: number, message: string, code?: { code: string; branchName: string }) {
      emit('git:error', { message, ...code })
      emit('git:status', { status: 'fail', exitCode: 1 })
      pending[n].resolve({ error: message })
    },
    /** The git:push handler on success: status, then return. */
    pushSucceeds(n: number) {
      emit('git:log', { line: 'Push complete.', timestamp: '2026-01-01T00:00:01Z' })
      emit('git:status', { status: 'success', exitCode: 0 })
      pending[n].resolve({ ok: true })
    },
    /** The git:push handler on failure: error, status, then return. */
    pushFails(n: number, message: string) {
      emit('git:error', { message })
      emit('git:status', { status: 'fail', exitCode: 1 })
      pending[n].resolve({ error: message })
    },
  }
}

interface TestPR {
  url: string
  number: number
  branch: string
  outputs: Record<string, string>
}

// The hook registers whatever git:outputs carries; the key names are the main
// process's contract, so they are opaque here.
function testPR(number: number, branch: string): TestPR {
  const url = `https://example.com/acme/infra/pull/${number}`
  return { url, number, branch, outputs: { pr_url: url, pr_number: String(number), pr_branch: branch } }
}

const BLOCK_ID = 'open-pr'
const WORKTREE = '/tmp/worktrees/infra'

const CREATE_PARAMS = {
  owner: 'acme',
  repo: 'infra',
  baseBranch: 'main',
  headBranch: 'runbook/add-vpc',
  title: 'Add VPC',
  body: 'Adds a VPC.',
  commitMessage: 'Add VPC',
  labels: ['infra'],
  worktreePath: WORKTREE,
}

const WAITING_LINE = 'Waiting for the canceled operation to finish…'

function renderPR(cfg: PRProviderConfig) {
  const fake = createEmittingApi()
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(ApiProvider, {
      api: fake.api,
      children: createElement(RunbookContextProvider, { runbookName: 'test', children }),
    })
  const view = renderHook(
    () => ({ pr: useGitPullRequest({ id: BLOCK_ID, cfg }), runbook: useRunbookContext() }),
    { wrapper },
  )
  const state = () => view.result.current.pr
  const outputs = () => view.result.current.runbook.blockOutputs[normalizeBlockId(BLOCK_ID)]?.values
  const logLines = () => state().logs.map((entry) => entry.line)
  const operationCalls = () => fake.invoke.mock.calls.filter(([channel]) => OPERATION_CHANNELS.has(channel))

  /** Start a create; returns its promise without waiting on it. */
  const create = (params = CREATE_PARAMS) => {
    let done!: Promise<void>
    act(() => {
      done = state().createPullRequest(params)
    })
    return done
  }
  const push = () => {
    let done!: Promise<void>
    act(() => {
      done = state().pushChanges(WORKTREE, CREATE_PARAMS.headBranch)
    })
    return done
  }

  return { fake, view, state, outputs, logLines, operationCalls, create, push }
}

afterEach(() => {
  vi.useRealTimers()
})

describe.each([PR_PROVIDERS.github, PR_PROVIDERS.gitlab])('useGitPullRequest ($label)', (cfg) => {
  describe('create', () => {
    it('streams the result, registers outputs and ends in success', async () => {
      const { fake, state, outputs, logLines, create } = renderPR(cfg)
      const pr = testPR(42, CREATE_PARAMS.headBranch)

      const done = create()
      expect(state().status).toBe('creating')
      expect(fake.invoke).toHaveBeenCalledWith(cfg.channels.create, CREATE_PARAMS)

      await act(async () => {
        fake.createSucceeds(0, pr)
        await done
      })

      expect(state().status).toBe('success')
      expect(state().prResult).toEqual({ prUrl: pr.url, prNumber: 42, branchName: pr.branch })
      expect(state().errorMessage).toBeNull()
      expect(outputs()).toEqual(pr.outputs)
      expect(logLines()).toEqual([`Opened ${pr.url}`])
    })

    it('surfaces branch_exists and the conflicting branch from the git:error event', async () => {
      const { fake, state, create } = renderPR(cfg)

      const done = create()
      await act(async () => {
        fake.createFails(0, 'remote branch conflicts', { code: 'branch_exists', branchName: 'runbook/other' })
        await done
      })

      expect(state().status).toBe('fail')
      expect(state().errorMessage).toBe('remote branch conflicts')
      expect(state().errorCode).toBe('branch_exists')
      expect(state().conflictBranchName).toBe('runbook/other')
      expect(state().prResult).toBeNull()
    })

    it('falls back to the head branch when only the invoke result says "already exists"', async () => {
      const { fake, state, create } = renderPR(cfg)
      const message = "fatal: a branch named 'runbook/add-vpc' already exists"

      const done = create()
      await act(async () => {
        fake.resolve(0, { error: message })
        await done
      })

      expect(state().status).toBe('fail')
      expect(state().errorMessage).toBe(message)
      expect(state().errorCode).toBe('branch_exists')
      expect(state().conflictBranchName).toBe(CREATE_PARAMS.headBranch)
    })

    it('fails with a logged error when the invoke rejects, and stops listening', async () => {
      const { fake, state, logLines, create } = renderPR(cfg)

      const done = create()
      await act(async () => {
        fake.reject(0, new Error('IPC channel closed'))
        await done
      })

      expect(state().status).toBe('fail')
      expect(state().errorMessage).toBe('IPC channel closed')
      expect(logLines()).toEqual(['Error: IPC channel closed'])
      expect(fake.listenerCount()).toBe(0)
    })
  })

  describe('push', () => {
    async function renderCreated() {
      const harness = renderPR(cfg)
      const pr = testPR(7, CREATE_PARAMS.headBranch)
      const done = harness.create()
      await act(async () => {
        harness.fake.createSucceeds(0, pr)
        await done
      })
      return { ...harness, pr }
    }

    it('pushes on the provider-aware channel and returns to success', async () => {
      const { fake, state, logLines, push } = await renderCreated()

      const done = push()
      expect(state().status).toBe('pushing')
      expect(fake.invoke).toHaveBeenLastCalledWith('git:push', {
        worktreePath: WORKTREE,
        branchName: CREATE_PARAMS.headBranch,
        provider: cfg.id,
      })

      await act(async () => {
        fake.pushSucceeds(1)
        await done
      })

      expect(state().status).toBe('success')
      expect(state().pushError).toBeNull()
      expect(logLines()).toContain('Push complete.')
    })

    it('keeps the created PR on screen and reports a failed push inline', async () => {
      const { fake, state, pr, push } = await renderCreated()
      const message = 'rejected: non-fast-forward'

      const done = push()
      await act(async () => {
        fake.pushFails(1, message)
        await done
      })

      expect(state().status).toBe('success')
      expect(state().pushError).toBe(message)
      expect(state().errorMessage).toBeNull()
      expect(state().prResult?.prUrl).toBe(pr.url)
    })

    it('keeps a failed push inline when its events arrive after the invoke resolves', async () => {
      vi.useFakeTimers()
      const { fake, state, push } = await renderCreated()
      const message = 'token expired'

      const done = push()
      await act(async () => {
        fake.resolve(1, { error: message })
        await done
      })
      // Still inside the 500 ms listener window, so the late events are heard.
      expect(fake.listenerCount()).toBe(5)
      act(() => {
        fake.emit('git:error', { message })
        fake.emit('git:status', { status: 'fail', exitCode: 1 })
      })

      expect(state().status).toBe('success')
      expect(state().pushError).toBe(message)
      expect(state().errorMessage).toBeNull()
    })

    it('reports a rejected push invoke inline', async () => {
      const { fake, state, logLines, push } = await renderCreated()

      const done = push()
      await act(async () => {
        fake.reject(1, new Error('IPC channel closed'))
        await done
      })

      expect(state().status).toBe('success')
      expect(state().pushError).toBe('IPC channel closed')
      expect(state().errorMessage).toBeNull()
      expect(logLines()).toContain('Push error: IPC channel closed')
    })
  })

  describe('cancel', () => {
    it('ignores the canceled run when it finishes late', async () => {
      const { fake, state, outputs, logLines, create } = renderPR(cfg)

      const done = create()
      act(() => {
        fake.emit('git:log', { line: 'Creating branch…', timestamp: '2026-01-01T00:00:00Z' })
        state().cancel()
      })
      expect(state().status).toBe('ready')
      expect(fake.listenerCount()).toBe(0)

      await act(async () => {
        fake.createSucceeds(0, testPR(1, CREATE_PARAMS.headBranch))
        await done
      })

      expect(state().status).toBe('ready')
      expect(state().prResult).toBeNull()
      expect(outputs()).toBeUndefined()
      expect(logLines()).toEqual(['Creating branch…', 'Canceled.'])
    })

    it('runs a retry only after the canceled run finishes, and keeps its result out of the retry', async () => {
      const { fake, state, outputs, logLines, operationCalls, create } = renderPR(cfg)
      const stale = testPR(1, CREATE_PARAMS.headBranch)
      const fresh = testPR(2, 'runbook/add-vpc-2')

      const first = create()
      act(() => state().cancel())
      const second = create({ ...CREATE_PARAMS, headBranch: fresh.branch })

      // The retry waits: the canceled run still owns the worktree.
      expect(operationCalls()).toHaveLength(1)
      expect(state().status).toBe('creating')
      expect(logLines()).toEqual([WAITING_LINE])

      // The canceled run finishes; nothing of it reaches the retry.
      await act(async () => {
        fake.createSucceeds(0, stale)
        await first
      })
      expect(operationCalls()).toHaveLength(2)
      expect(state().status).toBe('creating')
      expect(state().prResult).toBeNull()
      expect(outputs()).toBeUndefined()

      await act(async () => {
        fake.createSucceeds(1, fresh)
        await second
      })
      expect(state().status).toBe('success')
      expect(state().prResult?.prUrl).toBe(fresh.url)
      expect(outputs()).toEqual(fresh.outputs)
    })

    it('abandons a retry that is canceled while it waits', async () => {
      const { fake, state, operationCalls, create } = renderPR(cfg)

      const first = create()
      act(() => state().cancel())
      let secondSettled = false
      void create().then(() => {
        secondSettled = true
      })
      act(() => state().cancel())

      await act(async () => {
        fake.createSucceeds(0, testPR(1, CREATE_PARAMS.headBranch))
        await first
      })

      await waitFor(() => expect(secondSettled).toBe(true))
      expect(operationCalls()).toHaveLength(1)
      expect(state().status).toBe('ready')
      expect(state().prResult).toBeNull()
      expect(fake.listenerCount()).toBe(0)
    })

    it("still unsubscribes a retry after the canceled run's cleanup timer fires", async () => {
      vi.useFakeTimers()
      const { fake, state, create } = renderPR(cfg)

      const first = create()
      act(() => state().cancel())
      const second = create()
      await act(async () => {
        fake.createFails(0, 'canceled run failed')
        await first
      })
      expect(fake.listenerCount()).toBe(5)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
      act(() => state().cancel())
      expect(fake.listenerCount()).toBe(0)

      await act(async () => {
        fake.createSucceeds(1, testPR(2, CREATE_PARAMS.headBranch))
        await second
      })
      expect(state().status).toBe('ready')
      expect(state().prResult).toBeNull()
    })

    it("still unsubscribes a retry after the canceled run's invoke rejects", async () => {
      const { fake, state, create } = renderPR(cfg)

      const first = create()
      act(() => state().cancel())
      const second = create()
      await act(async () => {
        fake.reject(0, new Error('canceled run crashed'))
        await first
      })
      // The retry subscribed before the canceled run's catch cleaned up.
      expect(fake.listenerCount()).toBe(5)

      act(() => state().cancel())
      expect(fake.listenerCount()).toBe(0)

      await act(async () => {
        fake.createSucceeds(1, testPR(2, CREATE_PARAMS.headBranch))
        await second
      })
      expect(state().status).toBe('ready')
      expect(state().prResult).toBeNull()
    })
  })

  describe('listener window', () => {
    it('applies a git:pr-result that arrives within 500 ms of the invoke resolving, then unsubscribes', async () => {
      vi.useFakeTimers()
      const { fake, state, outputs, create } = renderPR(cfg)
      const pr = testPR(9, CREATE_PARAMS.headBranch)

      const done = create()
      await act(async () => {
        fake.emit('git:status', { status: 'success', exitCode: 0 })
        fake.resolve(0, { url: pr.url, number: pr.number })
        await done
      })
      expect(state().status).toBe('success')
      expect(state().prResult).toBeNull()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(499)
      })
      act(() => {
        fake.emit('git:pr-result', { prUrl: pr.url, prNumber: pr.number, branchName: pr.branch })
        fake.emit('git:outputs', { outputs: pr.outputs })
      })
      expect(state().prResult?.prUrl).toBe(pr.url)
      expect(outputs()).toEqual(pr.outputs)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1)
      })
      expect(fake.listenerCount()).toBe(0)
    })

    it("keeps a push's listeners when the create's 500 ms cleanup fires mid-push", async () => {
      vi.useFakeTimers()
      const { fake, view, create, push } = renderPR(cfg)

      const created = create()
      await act(async () => {
        fake.createSucceeds(0, testPR(3, CREATE_PARAMS.headBranch))
        await created
      })
      push()
      expect(fake.listenerCount()).toBe(5)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
      expect(fake.listenerCount()).toBe(5)

      view.unmount()
      expect(fake.listenerCount()).toBe(0)
    })
  })
})
