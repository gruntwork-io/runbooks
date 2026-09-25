import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'

// useGitClone has no mount effects, so the auth-gate memo can be exercised by
// rendering the hook with controllable block outputs.
let blockOutputs: Record<string, { values: Record<string, string> }> = {}
const registerOutputs = vi.fn()

// The IPC boundary: invoke is scripted per test, and `on` keeps real
// listeners so tests can deliver git:clone-progress events to them.
const invoke = vi.fn()
const listeners = new Map<string, Set<(payload: unknown) => void>>()
const on = vi.fn((channel: string, callback: (payload: unknown) => void) => {
  if (!listeners.has(channel)) listeners.set(channel, new Set())
  listeners.get(channel)!.add(callback)
  return () => { listeners.get(channel)?.delete(callback) }
})
const emit = (channel: string, payload: unknown) => {
  for (const callback of listeners.get(channel) ?? []) callback(payload)
}
const api = { invoke, on }

vi.mock('@/contexts/useRunbook', () => ({
  useRunbookContext: () => ({ registerOutputs, blockOutputs }),
}))
vi.mock('@/contexts/ApiContext', () => ({
  useApi: () => api,
}))

import { useGitClone } from '../useGitClone'

beforeEach(() => {
  blockOutputs = {}
  registerOutputs.mockReset()
  invoke.mockReset()
  invoke.mockImplementation(async () => ({}))
  on.mockClear()
  listeners.clear()
})

/** A promise the test settles by hand, standing in for a slow IPC call. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

type CloneReply = { status: string; error?: string; outputs?: Record<string, string>; hasCommits?: boolean; absolutePath?: string }

/**
 * Script git:clone so each call returns the next pending promise, and record
 * the cloneId each call was made with.
 */
function scriptClones(count: number) {
  const pending = Array.from({ length: count }, () => deferred<CloneReply>())
  const cloneIds: string[] = []
  invoke.mockImplementation(async (channel: string, params?: { cloneId?: string }) => {
    if (channel === 'git:clone') {
      cloneIds.push(params!.cloneId!)
      return pending[cloneIds.length - 1].promise
    }
    return {}
  })
  return { pending, cloneIds }
}

const SUCCESS: CloneReply = {
  status: 'success',
  absolutePath: '/work/infra',
  hasCommits: true,
  outputs: { clone_path: '/work/infra' },
}

describe('useGitClone — auth gate (gitAuthId / githubAuthId)', () => {
  it('is met when there is no auth dependency', () => {
    const { result } = renderHook(() => useGitClone({ id: 'clone' }))
    expect(result.current.gitHubAuthMet).toBe(true)
  })

  it('gitAuthId is met when the referenced block emitted GITLAB_TOKEN', () => {
    blockOutputs = { gitauth: { values: { GITLAB_TOKEN: 'glpat-x', GITLAB_USER: 'tanuki' } } }
    const { result } = renderHook(() => useGitClone({ id: 'clone', gitAuthId: 'gitauth' }))
    expect(result.current.gitHubAuthMet).toBe(true)
  })

  it('gitAuthId is met via __AUTHENTICATED (env-detected GitLab block)', () => {
    // env/cli detection registers only the __AUTHENTICATED marker to block
    // outputs; the token lives in session env.
    blockOutputs = { gitauth: { values: { __AUTHENTICATED: 'true' } } }
    const { result } = renderHook(() => useGitClone({ id: 'clone', gitAuthId: 'gitauth' }))
    expect(result.current.gitHubAuthMet).toBe(true)
  })

  it('gitAuthId is NOT met when the referenced block has no credentials yet', () => {
    blockOutputs = { gitauth: { values: {} } }
    const { result } = renderHook(() => useGitClone({ id: 'clone', gitAuthId: 'gitauth' }))
    expect(result.current.gitHubAuthMet).toBe(false)
  })

  it('githubAuthId still gates on GITHUB_TOKEN (regression)', () => {
    blockOutputs = { ghauth: { values: { GITHUB_TOKEN: 'ghp_x' } } }
    const { result } = renderHook(() => useGitClone({ id: 'clone', githubAuthId: 'ghauth' }))
    expect(result.current.gitHubAuthMet).toBe(true)
  })

  it('githubAuthId is NOT met for an empty referenced block', () => {
    blockOutputs = { ghauth: { values: {} } }
    const { result } = renderHook(() => useGitClone({ id: 'clone', githubAuthId: 'ghauth' }))
    expect(result.current.gitHubAuthMet).toBe(false)
  })
})

describe('useGitClone — cancel', () => {
  it('stops git in main and ignores the cancelled clone\'s late result', async () => {
    const { pending, cloneIds } = scriptClones(1)
    const { result } = renderHook(() => useGitClone({ id: 'clone' }))

    act(() => { void result.current.clone('https://github.com/acme/infra.git', '', '', '') })
    expect(result.current.cloneStatus).toBe('running')

    act(() => result.current.cancel())
    expect(invoke).toHaveBeenCalledWith('git:clone-cancel', { cloneId: cloneIds[0] })
    expect(result.current.cloneStatus).toBe('ready')

    // The clone finishes anyway (it got past git before the cancel landed).
    await act(async () => { pending[0].resolve(SUCCESS) })

    expect(result.current.cloneStatus).toBe('ready')
    expect(result.current.cloneResult).toBeNull()
    expect(registerOutputs).not.toHaveBeenCalled()
  })

  it('does not turn a cancelled clone into a failure when its call rejects', async () => {
    const { pending } = scriptClones(1)
    const { result } = renderHook(() => useGitClone({ id: 'clone' }))

    act(() => { void result.current.clone('https://github.com/acme/infra.git', '', '', '') })
    act(() => result.current.cancel())
    await act(async () => { pending[0].reject(new Error('interrupted')) })

    expect(result.current.cloneStatus).toBe('ready')
    expect(result.current.errorMessage).toBeNull()
  })

  it('keeps a retry intact while the cancelled clone\'s events and result arrive', async () => {
    const { pending, cloneIds } = scriptClones(2)
    const { result } = renderHook(() => useGitClone({ id: 'clone' }))

    act(() => { void result.current.clone('https://github.com/acme/infra.git', '', '', '') })
    act(() => result.current.cancel())
    act(() => { void result.current.clone('https://github.com/acme/infra.git', '', '', '', undefined, true) })
    const [first, retry] = cloneIds
    expect(retry).not.toBe(first)

    // Progress from the cancelled git is dropped; the retry's own is kept.
    act(() => {
      emit('git:clone-progress', { line: 'from the cancelled clone', timestamp: 't', cloneId: first })
      emit('git:clone-progress', { line: 'from the retry', timestamp: 't', cloneId: retry })
    })
    expect(result.current.logs.map(l => l.line)).toEqual(['from the retry'])

    // The cancelled clone then fails (its directory was deleted by the retry's
    // "Delete & Clone"). That is not the retry's failure.
    await act(async () => { pending[0].resolve({ status: 'fail', error: 'destination vanished' }) })
    expect(result.current.cloneStatus).toBe('running')
    expect(result.current.errorMessage).toBeNull()

    // Cancel still reaches the retry: the stale run didn't drop its handles.
    act(() => result.current.cancel())
    expect(invoke).toHaveBeenLastCalledWith('git:clone-cancel', { cloneId: retry })
    act(() => { emit('git:clone-progress', { line: 'after cancel', timestamp: 't', cloneId: retry }) })
    expect(result.current.logs.map(l => l.line)).not.toContain('after cancel')
  })
})

describe('useGitClone — token check', () => {
  it('moves a fresh block from pending to ready', async () => {
    invoke.mockImplementation(async (channel: string) => (channel === 'github:orgs' ? [] : {}))
    const { result } = renderHook(() => useGitClone({ id: 'clone' }))
    expect(result.current.cloneStatus).toBe('pending')

    await act(async () => { await result.current.checkGitHubToken() })
    expect(result.current.cloneStatus).toBe('ready')
  })

  it('leaves a clone that started while it ran in the running state', async () => {
    const orgs = deferred<unknown[]>()
    const clone = deferred<CloneReply>()
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'github:orgs') return orgs.promise
      if (channel === 'git:clone') return clone.promise
      return {}
    })
    const { result } = renderHook(() => useGitClone({ id: 'clone' }))

    act(() => { void result.current.checkGitHubToken() })
    act(() => { void result.current.clone('https://github.com/acme/infra.git', '', '', '') })
    await act(async () => { orgs.resolve([{ login: 'acme' }]) })

    expect(result.current.cloneStatus).toBe('running')
    expect(result.current.tokenChecked).toBe(true)

    await act(async () => { clone.resolve(SUCCESS) })
    expect(result.current.cloneStatus).toBe('success')
  })

  it('leaves a clone that already finished in the success state', async () => {
    const orgs = deferred<unknown[]>()
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'github:orgs') return orgs.promise
      if (channel === 'git:clone') return SUCCESS
      return {}
    })
    const { result } = renderHook(() => useGitClone({ id: 'clone' }))

    act(() => { void result.current.checkGitHubToken() })
    await act(async () => { await result.current.clone('https://github.com/acme/infra.git', '', '', '') })
    await act(async () => { orgs.resolve([]) })

    expect(result.current.cloneStatus).toBe('success')
  })
})

describe('useGitClone — reset', () => {
  it('withdraws the outputs a previous clone published', async () => {
    invoke.mockImplementation(async (channel: string) => (channel === 'git:clone' ? SUCCESS : {}))
    const { result } = renderHook(() => useGitClone({ id: 'clone' }))

    await act(async () => { await result.current.clone('https://github.com/acme/infra.git', '', '', '') })
    expect(registerOutputs).toHaveBeenLastCalledWith('clone', SUCCESS.outputs)

    act(() => result.current.reset())
    expect(registerOutputs).toHaveBeenLastCalledWith('clone', {})
    expect(result.current.cloneStatus).toBe('ready')
  })
})
