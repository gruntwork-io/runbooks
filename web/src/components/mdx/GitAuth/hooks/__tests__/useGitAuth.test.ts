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

    // Validation targets the selected host (gitlab.com by default).
    expect(invoke).toHaveBeenCalledWith('gitlab:validate', { token: 'glpat-abc', host: 'gitlab.com' })
    // GIT_PROVIDER is registered as a block output so downstream PR/MR blocks can
    // derive the linked instance...
    expect(registerOutputs).toHaveBeenCalledWith('git', {
      GITLAB_TOKEN: 'glpat-abc',
      GITLAB_USER: 'tanuki',
      GIT_PROVIDER: 'gitlab',
    })
    // ...but it is NOT written to the session env (it's metadata, not a credential).
    // The credential is paired with GITLAB_HOST so git/API ops target the right instance.
    expect(invoke).toHaveBeenCalledWith('session:set-env', {
      env: { GITLAB_TOKEN: 'glpat-abc', GITLAB_USER: 'tanuki', GITLAB_HOST: 'gitlab.com' },
    })
    expect(result.current.authStatus).toBe('authenticated')
    // No scopes returned (introspection unavailable) → no claim about missing scopes.
    expect(result.current.scopeWarning).toBeNull()
  })

  it('shows introspected scopes and does not warn when write_repository is present', async () => {
    installApi(async (channel) => {
      if (channel === 'gitlab:validate') {
        return {
          valid: true,
          user: { login: 'tanuki' },
          tokenType: 'pat',
          scopes: ['read_user', 'write_repository'],
        }
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

    expect(result.current.detectedScopes).toEqual(['read_user', 'write_repository'])
    expect(result.current.scopeWarning).toBeNull()
  })

  it('does not warn when the token has the api superset scope', async () => {
    installApi(async (channel) => {
      if (channel === 'gitlab:validate') {
        return { valid: true, user: { login: 'tanuki' }, tokenType: 'pat', scopes: ['api'] }
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

    expect(result.current.detectedScopes).toEqual(['api'])
    expect(result.current.scopeWarning).toBeNull()
  })

  it('warns when the token grants no repository write access', async () => {
    installApi(async (channel) => {
      if (channel === 'gitlab:validate') {
        return {
          valid: true,
          user: { login: 'tanuki' },
          tokenType: 'pat',
          scopes: ['read_user', 'read_repository'],
        }
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

    expect(result.current.detectedScopes).toEqual(['read_user', 'read_repository'])
    expect(result.current.scopeWarning).toContain('write_repository')
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

  it('enumerates glab hosts and detects against glab\'s default host', async () => {
    const invoke = installApi(async (channel, args) => {
      if (channel === 'gitlab:enumerate-hosts') {
        return { hosts: ['gitlab.com', 'gitlab.gruntwork.io'], defaultHost: 'gitlab.gruntwork.io' }
      }
      if (channel === 'gitlab:env-credentials') return { found: false }
      if (channel === 'gitlab:cli-credentials') {
        const host = (args as { host?: string }).host
        return host === 'gitlab.gruntwork.io'
          ? { found: true, user: { login: 'root' }, scopes: ['api'], host }
          : { found: false }
      }
      if (channel === 'session:set-env') return { ok: true }
      return {}
    })

    const { result } = renderHook(() => useGitAuth({ id: 'git', provider: PROVIDERS.gitlab }))

    await waitFor(() => expect(result.current.authStatus).toBe('authenticated'))
    expect(result.current.availableHosts).toEqual(['gitlab.com', 'gitlab.gruntwork.io'])
    expect(result.current.selectedHost).toBe('gitlab.gruntwork.io')
    // Detection targeted the self-managed default host, not gitlab.com.
    expect(invoke).toHaveBeenCalledWith('gitlab:cli-credentials', { host: 'gitlab.gruntwork.io' })
  })

  it('changeHost re-runs detection against the newly selected host', async () => {
    const invoke = installApi(async (channel, args) => {
      if (channel === 'gitlab:enumerate-hosts') {
        return { hosts: ['gitlab.com', 'gitlab.gruntwork.io'], defaultHost: 'gitlab.com' }
      }
      if (channel === 'gitlab:env-credentials') return { found: false }
      if (channel === 'gitlab:cli-credentials') {
        const host = (args as { host?: string }).host
        return host === 'gitlab.gruntwork.io'
          ? { found: true, user: { login: 'root' }, host }
          : { found: false }
      }
      if (channel === 'session:set-env') return { ok: true }
      return {}
    })

    const { result } = renderHook(() => useGitAuth({ id: 'git', provider: PROVIDERS.gitlab }))

    // Initial detection targets glab's default (gitlab.com) and finds nothing.
    await waitFor(() => expect(result.current.detectionStatus).toBe('done'))
    expect(result.current.authStatus).not.toBe('authenticated')

    await act(async () => {
      result.current.changeHost('gitlab.gruntwork.io')
    })

    await waitFor(() => expect(result.current.authStatus).toBe('authenticated'))
    expect(invoke).toHaveBeenCalledWith('gitlab:cli-credentials', { host: 'gitlab.gruntwork.io' })
  })

  it('flags a found-but-invalid CLI token even when the error is a bare 401', async () => {
    // Regression for the silent-failure bug: an expired OAuth token validates as
    // "401 Unauthorized" (no "invalid"/"expired" keyword), so detection must rely
    // on `found`/`status` to surface it instead of looking like "no credentials".
    installApi(async (channel) => {
      if (channel === 'gitlab:enumerate-hosts') return { hosts: ['gitlab.com'], defaultHost: 'gitlab.com' }
      if (channel === 'gitlab:env-credentials') return { found: false }
      if (channel === 'gitlab:cli-credentials') {
        return { found: true, error: '401 Unauthorized', status: 401, host: 'gitlab.com' }
      }
      return {}
    })

    const { result } = renderHook(() => useGitAuth({ id: 'git', provider: PROVIDERS.gitlab }))

    await waitFor(() => expect(result.current.detectionStatus).toBe('done'))
    expect(result.current.authStatus).not.toBe('authenticated')
    expect(result.current.detectionWarning).toContain('glab CLI')
    expect(result.current.detectionWarning).toContain('gitlab.com')
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
      GIT_PROVIDER: 'github',
    })
  })

  it('does not warn for a CLI-detected token with no readable scopes (e.g. fine-grained PAT)', async () => {
    // gh auth token can surface a fine-grained PAT whose X-OAuth-Scopes is empty;
    // we can't claim "repo" is missing when scopes are unknown, so no warning.
    installApi(async (channel) => {
      if (channel === 'github:env-credentials') return { found: false }
      if (channel === 'github:cli-credentials') {
        return { found: true, user: { login: 'octocat' }, tokenType: 'fine_grained_pat', scopes: undefined }
      }
      if (channel === 'session:set-env') return { ok: true }
      return { found: false }
    })

    const { result } = renderHook(() => useGitAuth({ id: 'gh', provider: PROVIDERS.github }))

    await waitFor(() => expect(result.current.authStatus).toBe('authenticated'))
    expect(result.current.scopeWarning).toBeNull()
  })
})
