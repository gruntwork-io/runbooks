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

    expect(invoke).toHaveBeenCalledWith('gitlab:validate', {
      token: 'glpat-abc',
      host: 'gitlab.com',
      registerSession: true,
    })
    // GIT_PROVIDER + __AUTHENTICATED are registered as block outputs so
    // downstream blocks can derive the linked instance / chain via session.
    expect(registerOutputs).toHaveBeenCalledWith('git', {
      GITLAB_TOKEN: 'glpat-abc',
      GITLAB_USER: 'tanuki',
      GIT_PROVIDER: 'gitlab',
      __AUTHENTICATED: 'true',
    })
    expect(invoke).not.toHaveBeenCalledWith('session:set-env', expect.anything())
    expect(result.current.authStatus).toBe('authenticated')
    // No scopes returned (introspection unavailable) → no claim about missing scopes.
    expect(result.current.scopeWarning).toBeNull()
  })

  it('sends a self-hosted instanceUrl to gitlab:validate when supplying a token', async () => {
    const invoke = installApi(async (channel) => {
      if (channel === 'gitlab:validate') {
        return { valid: true, user: { login: 'tanuki' }, tokenType: 'pat' }
      }
      if (channel === 'session:set-env') return { ok: true }
      return { found: false }
    })

    const { result } = renderHook(() =>
      useGitAuth({
        id: 'git',
        provider: PROVIDERS.gitlab,
        instanceUrl: 'https://gitlab.acme.com',
        detectCredentials: false,
      }),
    )

    act(() => result.current.setPatToken('glpat-abc'))
    await act(async () => {
      await result.current.handlePatSubmit()
    })

    expect(invoke).toHaveBeenCalledWith('gitlab:validate', {
      token: 'glpat-abc',
      registerSession: true,
      instanceUrl: 'https://gitlab.acme.com',
    })
  })

  it('pairs the PAT with the entered instance host (not the default) in the banner and validate call', async () => {
    // Regression for the token<->host mismatch: when a self-managed instance URL
    // is supplied, the validate call (whose handler writes GITLAB_HOST into the
    // session env main-side, §8) and the success banner must match that
    // instance — not the picker's gitlab.com default.
    const invoke = installApi(async (channel) => {
      if (channel === 'gitlab:validate') {
        return { valid: true, user: { login: 'tanuki' }, tokenType: 'pat' }
      }
      if (channel === 'session:set-env') return { ok: true }
      return { found: false }
    })

    const { result } = renderHook(() =>
      useGitAuth({
        id: 'git',
        provider: PROVIDERS.gitlab,
        instanceUrl: 'https://gitlab.acme.com',
        detectCredentials: false,
      }),
    )

    act(() => result.current.setPatToken('glpat-abc'))
    await act(async () => {
      await result.current.handlePatSubmit()
    })

    expect(invoke).toHaveBeenCalledWith('gitlab:validate', {
      token: 'glpat-abc',
      registerSession: true,
      instanceUrl: 'https://gitlab.acme.com',
    })
    expect(invoke).not.toHaveBeenCalledWith('session:set-env', expect.anything())
    expect(result.current.selectedHost).toBe('gitlab.acme.com')
  })

  it('a runtime instance-URL edit overrides the seeded prop on validate', async () => {
    const invoke = installApi(async (channel) => {
      if (channel === 'gitlab:validate') {
        return { valid: true, user: { login: 'tanuki' }, tokenType: 'pat' }
      }
      if (channel === 'session:set-env') return { ok: true }
      return { found: false }
    })

    const { result } = renderHook(() =>
      useGitAuth({
        id: 'git',
        provider: PROVIDERS.gitlab,
        instanceUrl: 'https://seed.example.com',
        detectCredentials: false,
      }),
    )

    act(() => {
      result.current.setGitlabInstanceUrl('https://edited.example.com')
      result.current.setPatToken('glpat-abc')
    })
    await act(async () => {
      await result.current.handlePatSubmit()
    })

    expect(invoke).toHaveBeenCalledWith('gitlab:validate', {
      token: 'glpat-abc',
      registerSession: true,
      instanceUrl: 'https://edited.example.com',
    })
  })

  it('threads the instanceUrl through env/cli credential detection', async () => {
    const invoke = installApi(async (channel) => {
      if (channel === 'gitlab:env-credentials') return { found: false }
      if (channel === 'gitlab:cli-credentials') return { found: false }
      return {}
    })

    renderHook(() =>
      useGitAuth({
        id: 'git',
        provider: PROVIDERS.gitlab,
        instanceUrl: 'https://gitlab.acme.com',
      }),
    )

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'gitlab:env-credentials',
        expect.objectContaining({ instanceUrl: 'https://gitlab.acme.com' }),
      )
      expect(invoke).toHaveBeenCalledWith(
        'gitlab:cli-credentials',
        expect.objectContaining({ instanceUrl: 'https://gitlab.acme.com' }),
      )
    })
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
        return { hosts: [{ host: 'gitlab.com', sources: ['glab'], hasCredential: true }, { host: 'gitlab.gruntwork.io', sources: ['glab'], hasCredential: true }], defaultHost: 'gitlab.gruntwork.io' }
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
    expect(result.current.availableHosts.map((h) => h.host)).toEqual(['gitlab.com', 'gitlab.gruntwork.io'])
    expect(result.current.selectedHost).toBe('gitlab.gruntwork.io')
    // Detection targeted the self-managed default host, not gitlab.com.
    expect(invoke).toHaveBeenCalledWith('gitlab:cli-credentials', { host: 'gitlab.gruntwork.io' })
  })

  it('changeHost re-runs detection against the newly selected host', async () => {
    const invoke = installApi(async (channel, args) => {
      if (channel === 'gitlab:enumerate-hosts') {
        return { hosts: [{ host: 'gitlab.com', sources: ['glab'], hasCredential: true }, { host: 'gitlab.gruntwork.io', sources: ['glab'], hasCredential: true }], defaultHost: 'gitlab.com' }
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
      if (channel === 'gitlab:enumerate-hosts') return { hosts: [{ host: 'gitlab.com', sources: ['glab'], hasCredential: true }], defaultHost: 'gitlab.com' }
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

    expect(invoke).toHaveBeenCalledWith('github:validate', { token: 'ghp_abc', registerSession: true })
    expect(result.current.authStatus).toBe('authenticated')
    expect(result.current.scopeWarning).toContain('repo')
    expect(registerOutputs).toHaveBeenCalledWith('gh', {
      GITHUB_TOKEN: 'ghp_abc',
      GITHUB_USER: 'octocat',
      GIT_PROVIDER: 'github',
      __AUTHENTICATED: 'true',
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

describe('useGitAuth — tri-state unreachable (vcs-auth-v2 §2.0)', () => {
  it("an 'unreachable' env outcome stops the chain without consuming later sources", async () => {
    const invoke = installApi(async (channel) => {
      if (channel === 'gitlab:env-credentials') {
        return {
          found: true,
          valid: false,
          outcome: 'unreachable',
          errorKind: 'tls',
          coldReadOk: true,
          error: 'TypeError: fetch failed',
          host: 'gitlab.corp.example',
        }
      }
      return { found: false }
    })

    const { result } = renderHook(() => useGitAuth({ id: 'git', provider: PROVIDERS.gitlab }))

    await waitFor(() => expect(result.current.detectionStatus).toBe('done'))

    // The chain stopped: the CLI source was never consulted.
    const channelsCalled = invoke.mock.calls.map((c) => c[0] as string)
    expect(channelsCalled).not.toContain('gitlab:cli-credentials')

    // The card data is set, and it is NOT an invalid-credentials warning.
    expect(result.current.unreachableInfo).toEqual({
      errorKind: 'tls',
      host: 'gitlab.corp.example',
      coldReadOk: true,
    })
    expect(result.current.detectionWarning).toBeNull()
    expect(result.current.authStatus).toBe('pending')
  })

  it("an 'invalid' (401) outcome warns and CONTINUES the chain", async () => {
    const invoke = installApi(async (channel) => {
      if (channel === 'gitlab:env-credentials') {
        return { found: true, valid: false, outcome: 'invalid', status: 401, error: '401 Unauthorized' }
      }
      if (channel === 'gitlab:cli-credentials') return { found: false }
      return { found: false }
    })

    const { result } = renderHook(() => useGitAuth({ id: 'git', provider: PROVIDERS.gitlab }))

    await waitFor(() => expect(result.current.detectionStatus).toBe('done'))

    const channelsCalled = invoke.mock.calls.map((c) => c[0] as string)
    expect(channelsCalled).toContain('gitlab:cli-credentials')
    expect(result.current.detectionWarning).toContain('GITLAB_TOKEN')
    expect(result.current.unreachableInfo).toBeNull()
  })

  it('a PAT submission hitting a TLS wall renders the card, never an auth failure', async () => {
    installApi(async (channel) => {
      if (channel === 'gitlab:validate') {
        return {
          valid: false,
          outcome: 'unreachable',
          errorKind: 'tls',
          coldReadOk: false,
          error: 'TypeError: fetch failed',
        }
      }
      return { found: false }
    })

    const { result } = renderHook(() =>
      useGitAuth({ id: 'git', provider: PROVIDERS.gitlab, detectCredentials: false }),
    )

    act(() => result.current.setPatToken('glpat-abc'))
    await act(async () => {
      await result.current.handlePatSubmit()
    })

    expect(result.current.authStatus).toBe('pending')
    expect(result.current.errorMessage).toBeNull()
    expect(result.current.unreachableInfo).toEqual({
      errorKind: 'tls',
      host: 'gitlab.com',
      coldReadOk: false,
    })
  })

  it('disables the GitHub OAuth tab while github.com is unreachable, and Retry re-runs detection', async () => {
    let unreachable = true
    const invoke = installApi(async (channel) => {
      if (channel === 'github:env-credentials') {
        if (unreachable) {
          return {
            found: true,
            valid: false,
            outcome: 'unreachable',
            errorKind: 'network',
            error: 'getaddrinfo ENOTFOUND api.github.com',
          }
        }
        return { found: true, valid: true, user: { login: 'octocat' }, tokenType: 'classic_pat' }
      }
      if (channel === 'session:set-env') return { ok: true }
      return { found: false }
    })

    const { result } = renderHook(() => useGitAuth({ id: 'gh', provider: PROVIDERS.github }))

    await waitFor(() => expect(result.current.detectionStatus).toBe('done'))
    expect(result.current.unreachableInfo?.errorKind).toBe('network')
    expect(result.current.unreachableInfo?.host).toBe('github.com')
    expect(result.current.oauthUnavailableReason).toContain('github.com is unreachable')

    // Connectivity restored: Retry clears the card and re-runs the chain.
    unreachable = false
    act(() => result.current.retryUnreachable())
    await waitFor(() => expect(result.current.authStatus).toBe('authenticated'))
    expect(result.current.unreachableInfo).toBeNull()
    expect(result.current.oauthUnavailableReason).toBeNull()
    expect(invoke.mock.calls.filter((c) => c[0] === 'github:env-credentials').length).toBe(2)
  })

  it("a 'server-cert' failure does not disable the OAuth tab (trust changes can't fix it; the device flow may still work)", async () => {
    installApi(async (channel) => {
      if (channel === 'github:env-credentials') {
        return { found: true, valid: false, outcome: 'unreachable', errorKind: 'server-cert', error: 'certificate has expired' }
      }
      return { found: false }
    })

    const { result } = renderHook(() => useGitAuth({ id: 'gh', provider: PROVIDERS.github }))

    await waitFor(() => expect(result.current.detectionStatus).toBe('done'))
    expect(result.current.unreachableInfo?.errorKind).toBe('server-cert')
    expect(result.current.oauthUnavailableReason).toBeNull()
  })
})

describe('useGitAuth — §2/§7 copy contracts (vcs-auth-v2 Step 3)', () => {
  it('renders the main-supplied warning copy VERBATIM for an invalid env token', async () => {
    installApi(async (channel) => {
      if (channel === 'gitlab:env-credentials') {
        return {
          found: true,
          valid: false,
          outcome: 'invalid',
          status: 401,
          error: '401 Unauthorized',
          envVar: 'OAUTH_TOKEN',
          warning: 'OAUTH_TOKEN is not valid for gitlab.com',
        }
      }
      return { found: false }
    })

    const { result } = renderHook(() => useGitAuth({ id: 'git', provider: PROVIDERS.gitlab }))

    await waitFor(() => expect(result.current.detectionStatus).toBe('done'))
    // Exact §2.0 chip copy — never "expired" (a 401 can't prove that).
    expect(result.current.detectionWarning).toBe('OAUTH_TOKEN is not valid for gitlab.com')
  })

  it('surfaces a keyring-blocked hint as a manual-UI hint, not a warning chip', async () => {
    const KEYRING_COPY =
      'glab stores this token in the OS keyring but could not read it — unlock your keyring or paste a token.'
    installApi(async (channel) => {
      if (channel === 'gitlab:cli-credentials') {
        return { found: false, outcome: 'absent', hint: KEYRING_COPY }
      }
      return { found: false }
    })

    const { result } = renderHook(() => useGitAuth({ id: 'git', provider: PROVIDERS.gitlab }))

    await waitFor(() => expect(result.current.detectionStatus).toBe('done'))
    expect(result.current.manualHint).toBe(KEYRING_COPY)
    expect(result.current.detectionWarning).toBeNull()
  })

  it('exposes the both-env-vars-set divergence hint on env-detected success', async () => {
    const DIVERGENCE =
      'GH_TOKEN is also set and differs; Runbooks used GITHUB_TOKEN — gh would use GH_TOKEN.'
    installApi(async (channel) => {
      if (channel === 'github:env-credentials') {
        return {
          found: true,
          valid: true,
          user: { login: 'octocat' },
          tokenType: 'classic_pat',
          envVar: 'GITHUB_TOKEN',
          divergenceHint: DIVERGENCE,
        }
      }
      if (channel === 'session:set-env') return { ok: true }
      return { found: false }
    })

    const { result } = renderHook(() => useGitAuth({ id: 'gh', provider: PROVIDERS.github }))

    await waitFor(() => expect(result.current.authStatus).toBe('authenticated'))
    expect(result.current.divergenceHint).toBe(DIVERGENCE)
  })

  it('drives the no-credentials hint from vcs:cli-status (gh installed vs absent)', async () => {
    installApi(async (channel) => {
      if (channel === 'vcs:cli-status') {
        return {
          gh: { installed: true, version: '2.40.1', meetsFloor: true },
          glab: { installed: false, meetsFloor: false },
        }
      }
      return { found: false }
    })

    const { result } = renderHook(() => useGitAuth({ id: 'gh', provider: PROVIDERS.github }))

    await waitFor(() => expect(result.current.detectionStatus).toBe('done'))
    await waitFor(() =>
      expect(result.current.manualHint).toBe(
        "No existing credentials found. Sign in below, set GITHUB_TOKEN, or run 'gh auth login'.",
      ),
    )
  })
})

describe('useGitAuth — host union UX (vcs-auth-v2 §4/§5)', () => {
  const HOSTS = {
    hosts: [
      { host: 'gitlab.com', sources: ['glab'], hasCredential: true },
      { host: 'git.corp.example', sources: ['recent'], hasCredential: false },
    ],
    defaultHost: 'gitlab.com',
  }

  it("the 'Other instance…' sentinel never changes the host and never runs detection", async () => {
    const invoke = installApi(async (channel) => {
      if (channel === 'gitlab:enumerate-hosts') return HOSTS
      return { found: false }
    })

    const { result } = renderHook(() => useGitAuth({ id: 'git', provider: PROVIDERS.gitlab }))
    await waitFor(() => expect(result.current.detectionStatus).toBe('done'))
    const detectionCallsBefore = invoke.mock.calls.filter((c) => c[0] === 'gitlab:cli-credentials').length

    act(() => result.current.handleHostSelect('__other__'))

    expect(result.current.selectedHost).toBe('gitlab.com')
    expect(result.current.authMethod).toBe('pat')
    // No re-detection fired and no pick was persisted.
    expect(invoke.mock.calls.filter((c) => c[0] === 'gitlab:cli-credentials').length).toBe(detectionCallsBefore)
    expect(invoke.mock.calls.filter((c) => c[0] === 'gitlab:host-picked').length).toBe(0)
  })

  it('an explicit host pick is persisted via gitlab:host-picked', async () => {
    const invoke = installApi(async (channel) => {
      if (channel === 'gitlab:enumerate-hosts') return HOSTS
      if (channel === 'gitlab:host-picked') return { ok: true }
      if (channel === 'vcs:invalidate-cache') return { ok: true }
      return { found: false }
    })

    const { result } = renderHook(() => useGitAuth({ id: 'git', provider: PROVIDERS.gitlab }))
    await waitFor(() => expect(result.current.detectionStatus).toBe('done'))

    act(() => result.current.handleHostSelect('git.corp.example'))

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('gitlab:host-picked', { host: 'git.corp.example' })
    })
    expect(result.current.selectedHost).toBe('git.corp.example')
  })

  it('flags the session as stale when another block authenticates a different host (§4 item 9)', async () => {
    let sessionChangedHandler: ((payload: unknown) => void) | undefined
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'gitlab:enumerate-hosts') return HOSTS
      if (channel === 'gitlab:env-credentials') {
        return { found: true, valid: true, user: { login: 'tanuki' }, host: 'gitlab.com', envVar: 'GITLAB_TOKEN' }
      }
      if (channel === 'session:set-env') return { ok: true }
      return { found: false }
    })
    window.api = {
      invoke,
      on: vi.fn((channel: string, callback: (payload: unknown) => void) => {
        if (channel === 'vcs:session-changed') sessionChangedHandler = callback
        return () => {}
      }),
      once: vi.fn(),
    } as unknown as typeof window.api

    const { result } = renderHook(() => useGitAuth({ id: 'git', provider: PROVIDERS.gitlab }))
    await waitFor(() => expect(result.current.authStatus).toBe('authenticated'))
    expect(result.current.sessionStale).toBe(false)

    // A second block authenticates a DIFFERENT host → this card is stale.
    act(() => sessionChangedHandler?.({ provider: 'gitlab', host: 'git.corp.example', source: 'cli' }))
    expect(result.current.sessionStale).toBe(true)
  })

  it('ignores session changes for the other provider or the same host', async () => {
    let sessionChangedHandler: ((payload: unknown) => void) | undefined
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'gitlab:enumerate-hosts') return HOSTS
      if (channel === 'gitlab:env-credentials') {
        return { found: true, valid: true, user: { login: 'tanuki' }, host: 'gitlab.com', envVar: 'GITLAB_TOKEN' }
      }
      if (channel === 'session:set-env') return { ok: true }
      return { found: false }
    })
    window.api = {
      invoke,
      on: vi.fn((channel: string, callback: (payload: unknown) => void) => {
        if (channel === 'vcs:session-changed') sessionChangedHandler = callback
        return () => {}
      }),
      once: vi.fn(),
    } as unknown as typeof window.api

    const { result } = renderHook(() => useGitAuth({ id: 'git', provider: PROVIDERS.gitlab }))
    await waitFor(() => expect(result.current.authStatus).toBe('authenticated'))

    act(() => sessionChangedHandler?.({ provider: 'github', host: 'github.com' }))
    expect(result.current.sessionStale).toBe(false)
    act(() => sessionChangedHandler?.({ provider: 'gitlab', host: 'gitlab.com' }))
    expect(result.current.sessionStale).toBe(false)
  })
})

describe('useGitAuth — §8 custody (vcs-auth-v2 Step 6)', () => {
  it('chains a referenced GitAuth block via useSessionToken — no token crosses IPC', async () => {
    // The referenced GitAuth block authenticated earlier: metadata-only
    // outputs (no GITHUB_TOKEN), just the __AUTHENTICATED marker.
    blockOutputs['github_auth'] = { values: { __AUTHENTICATED: 'true', GIT_PROVIDER: 'github' } } // normalizeBlockId maps github-auth → github_auth
    const invoke = installApi(async (channel, args) => {
      if (channel === 'github:validate') {
        const params = args as { useSessionToken?: boolean; token?: string }
        if (params.useSessionToken && params.token === undefined) {
          return { valid: true, user: { login: 'octocat' }, tokenType: 'oauth' }
        }
        return { valid: false, error: 'unexpected payload' }
      }
      return { found: false }
    })

    const { result } = renderHook(() =>
      useGitAuth({
        id: 'gh2',
        provider: PROVIDERS.github,
        detectCredentials: [{ block: 'github-auth' }],
      }),
    )

    await waitFor(() => expect(result.current.authStatus).toBe('authenticated'))
    expect(invoke).toHaveBeenCalledWith('github:validate', expect.objectContaining({ useSessionToken: true }))
    // The consuming block's outputs stay metadata-only too.
    expect(registerOutputs).toHaveBeenCalledWith('gh2', expect.objectContaining({ __AUTHENTICATED: 'true' }))
    const outputCalls = registerOutputs.mock.calls.filter((c) => c[0] === 'gh2')
    for (const call of outputCalls) {
      expect(call[1].GITHUB_TOKEN).toBeUndefined()
    }
    delete blockOutputs['github_auth']
  })

  it('OAuth completion is metadata-only: no token in outputs, no renderer session write', async () => {
    vi.useFakeTimers()
    try {
      const invoke = installApi(async (channel) => {
        if (channel === 'github:oauth-start') {
          return { deviceCode: 'dev123', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', interval: 0 }
        }
        if (channel === 'github:oauth-poll') {
          return { status: 'complete', user: { login: 'octocat' }, tokenType: 'oauth', scopes: ['repo'] }
        }
        return { found: false }
      })

      const { result } = renderHook(() =>
        useGitAuth({ id: 'gh', provider: PROVIDERS.github, detectCredentials: false }),
      )

      await act(async () => {
        await result.current.startOAuth()
        await vi.runOnlyPendingTimersAsync()
      })

      await vi.waitFor(() => expect(result.current.authStatus).toBe('authenticated'))
      // Metadata-only outputs; main owns the session env.
      expect(registerOutputs).toHaveBeenCalledWith('gh', {
        GITHUB_USER: 'octocat',
        GIT_PROVIDER: 'github',
        __AUTHENTICATED: 'true',
      })
      expect(invoke).not.toHaveBeenCalledWith('session:set-env', expect.anything())
      // clientId was not sent — main owns the default app id.
      const startCall = invoke.mock.calls.find((c) => c[0] === 'github:oauth-start')
      expect((startCall?.[1] as { clientId?: string })?.clientId).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
