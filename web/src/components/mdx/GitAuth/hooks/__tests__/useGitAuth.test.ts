import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useGitAuth } from '../useGitAuth'
import { PROVIDERS } from '../../providers'

// The hook depends on the runbook + session contexts; mock them so the test
// can focus on the provider-aware IPC behavior.
const registerOutputs = vi.fn()
const blockOutputs: Record<string, { values: Record<string, string> }> = {}

vi.mock('@/contexts/useRunbook', () => ({
  useRunbookContext: () => ({ registerOutputs, blockOutputs }),
}))
vi.mock('@/contexts/useSession', () => ({
  useSession: () => ({ isReady: true }),
}))

type InvokeImpl = (channel: string, args?: unknown) => Promise<unknown>

function installApi(impl: InvokeImpl) {
  const invoke = vi.fn(impl)
  window.api = {
    invoke,
    on: vi.fn(() => () => {}),
    once: vi.fn(),
  } as unknown as typeof window.api
  return invoke
}

const originalApi = window.api

afterEach(() => {
  window.api = originalApi
  vi.clearAllMocks()
})

beforeEach(() => {
  registerOutputs.mockClear()
})

describe('useGitAuth — GitLab provider', () => {
  it('runs detection against gitlab:* channels only (never github:* or oauth)', async () => {
    const invoke = installApi(async (channel) => {
      if (channel === 'gitlab:env-credentials') return { found: false }
      if (channel === 'gitlab:cli-credentials') return { found: false }
      return {}
    })

    renderHook(() => useGitAuth({ id: 'git', provider: PROVIDERS.gitlab }))

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('gitlab:env-credentials', expect.anything())
      expect(invoke).toHaveBeenCalledWith('gitlab:cli-credentials', expect.anything())
    })

    const channelsCalled = invoke.mock.calls.map((c) => c[0] as string)
    expect(channelsCalled.some((c) => c.startsWith('github:'))).toBe(false)
    expect(channelsCalled.some((c) => c.includes('oauth'))).toBe(false)
  })

  it('PAT success registers GITLAB_TOKEN/GITLAB_USER and writes session env', async () => {
    const invoke = installApi(async (channel) => {
      if (channel === 'gitlab:validate') {
        return { valid: true, user: { login: 'tanuki', name: 'Tanuki' }, tokenType: 'pat', scopes: undefined }
      }
      if (channel === 'session:set-env') return { ok: true }
      return { found: false }
    })

    const { result } = renderHook(() =>
      useGitAuth({ id: 'git', provider: PROVIDERS.gitlab, detectCredentials: false }),
    )

    act(() => result.current.setPatToken('glpat-abc'))
    await act(async () => {
      await result.current.handlePatSubmit()
    })

    expect(invoke).toHaveBeenCalledWith('gitlab:validate', { token: 'glpat-abc' })
    expect(registerOutputs).toHaveBeenCalledWith('git', {
      GITLAB_TOKEN: 'glpat-abc',
      GITLAB_USER: 'tanuki',
    })
    expect(invoke).toHaveBeenCalledWith('session:set-env', {
      env: { GITLAB_TOKEN: 'glpat-abc', GITLAB_USER: 'tanuki' },
    })
    expect(result.current.authStatus).toBe('authenticated')
    // GitLab never warns about scopes (no scope header exposed).
    expect(result.current.scopeWarning).toBeNull()
  })

  it('detection warnings reference GITLAB_TOKEN / glab, never GITHUB_TOKEN', async () => {
    installApi(async (channel) => {
      if (channel === 'gitlab:env-credentials') {
        return { found: true, valid: false, error: 'bad token' }
      }
      if (channel === 'gitlab:cli-credentials') return { found: false }
      return {}
    })

    const { result } = renderHook(() => useGitAuth({ id: 'git', provider: PROVIDERS.gitlab }))

    await waitFor(() => {
      expect(result.current.detectionWarning).toContain('GITLAB_TOKEN')
    })
    expect(result.current.detectionWarning).not.toContain('GITHUB_TOKEN')
  })
})

describe('useGitAuth — GitHub provider (regression)', () => {
  it('warns about a missing "repo" scope and uses GITHUB_TOKEN wording', async () => {
    const invoke = installApi(async (channel) => {
      if (channel === 'github:validate') {
        return { valid: true, user: { login: 'octocat' }, tokenType: 'classic_pat', scopes: ['read:org'] }
      }
      if (channel === 'session:set-env') return { ok: true }
      return { found: false }
    })

    const { result } = renderHook(() =>
      useGitAuth({ id: 'gh', provider: PROVIDERS.github, detectCredentials: false }),
    )

    act(() => result.current.setPatToken('ghp_abc'))
    await act(async () => {
      await result.current.handlePatSubmit()
    })

    expect(invoke).toHaveBeenCalledWith('github:validate', { token: 'ghp_abc' })
    expect(result.current.authStatus).toBe('authenticated')
    expect(result.current.scopeWarning).toContain('repo')
    expect(registerOutputs).toHaveBeenCalledWith('gh', {
      GITHUB_TOKEN: 'ghp_abc',
      GITHUB_USER: 'octocat',
    })
  })
})
