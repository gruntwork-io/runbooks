import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderHook, act, waitFor } from '@testing-library/react'
import { ApiProvider, type RunbooksAPI } from '@/contexts/ApiContext'
import { useGitAuth } from '../useGitAuth'
import { PROVIDERS } from '../../providers'

// The hook depends on the runbook + session contexts; mock them so the test
// can focus on the provider-aware IPC behavior. Reassign `blockOutputs` (and
// rerender) to simulate another block registering outputs: the hook watches
// the map by identity, as it does the real context's state. IPC is the one
// faked boundary, injected through the real ApiProvider.
const registerOutputs = vi.fn()
let blockOutputs: Record<string, { values: Record<string, string> }> = {}

vi.mock('@/contexts/useRunbook', () => ({
  useRunbookContext: () => ({ registerOutputs, blockOutputs }),
}))
vi.mock('@/contexts/useSession', () => ({
  useSession: () => ({ isReady: true }),
}))

type InvokeImpl = (channel: string, args?: unknown) => Promise<unknown>
type OnImpl = (channel: string, callback: (payload: unknown) => void) => () => void

let currentApi: RunbooksAPI

/** Install a fake IPC surface. Returns the invoke spy so channels/params can be asserted. */
function installApi(impl: InvokeImpl, on: OnImpl = () => () => {}) {
  const invoke = vi.fn(impl)
  currentApi = { invoke, on: vi.fn(on), once: vi.fn() } as unknown as RunbooksAPI
  return invoke
}

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(ApiProvider, { api: currentApi, children })

type Options = Parameters<typeof useGitAuth>[0]

const renderGitAuth = (options: Options) => renderHook(() => useGitAuth(options), { wrapper })

afterEach(() => {
  blockOutputs = {}
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

    renderGitAuth({ id: 'git', provider: PROVIDERS.gitlab })

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

    const { result } = renderGitAuth({ id: 'git', provider: PROVIDERS.gitlab, detectCredentials: false })

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
    expect(result.current.missingScope).toBe(false)
  })

  it('sends a self-hosted instanceUrl to gitlab:validate when supplying a token', async () => {
    const invoke = installApi(async (channel) => {
      if (channel === 'gitlab:validate') {
        return { valid: true, user: { login: 'tanuki' }, tokenType: 'pat' }
      }
      if (channel === 'session:set-env') return { ok: true }
      return { found: false }
    })

    const { result } = renderGitAuth({
      id: 'git',
      provider: PROVIDERS.gitlab,
      instanceUrl: 'https://gitlab.acme.com',
      detectCredentials: false,
    })

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
    // session env main-side) and the success banner must match that
    // instance — not the picker's gitlab.com default.
    const invoke = installApi(async (channel) => {
      if (channel === 'gitlab:validate') {
        return { valid: true, user: { login: 'tanuki' }, tokenType: 'pat' }
      }
      if (channel === 'session:set-env') return { ok: true }
      return { found: false }
    })

    const { result } = renderGitAuth({
      id: 'git',
      provider: PROVIDERS.gitlab,
      instanceUrl: 'https://gitlab.acme.com',
      detectCredentials: false,
    })

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

    const { result } = renderGitAuth({
      id: 'git',
      provider: PROVIDERS.gitlab,
      instanceUrl: 'https://seed.example.com',
      detectCredentials: false,
    })

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

    renderGitAuth({
      id: 'git',
      provider: PROVIDERS.gitlab,
      instanceUrl: 'https://gitlab.acme.com',
    })

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

    const { result } = renderGitAuth({ id: 'git', provider: PROVIDERS.gitlab, detectCredentials: false })

    act(() => result.current.setPatToken('glpat-abc'))
    await act(async () => {
      await result.current.handlePatSubmit()
    })

    expect(result.current.detectedScopes).toEqual(['read_user', 'write_repository'])
    expect(result.current.missingScope).toBe(false)
  })

  it('does not warn when the token has the api superset scope', async () => {
    installApi(async (channel) => {
      if (channel === 'gitlab:validate') {
        return { valid: true, user: { login: 'tanuki' }, tokenType: 'pat', scopes: ['api'] }
      }
      if (channel === 'session:set-env') return { ok: true }
      return { found: false }
    })

    const { result } = renderGitAuth({ id: 'git', provider: PROVIDERS.gitlab, detectCredentials: false })

    act(() => result.current.setPatToken('glpat-abc'))
    await act(async () => {
      await result.current.handlePatSubmit()
    })

    expect(result.current.detectedScopes).toEqual(['api'])
    expect(result.current.missingScope).toBe(false)
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

    const { result } = renderGitAuth({ id: 'git', provider: PROVIDERS.gitlab, detectCredentials: false })

    act(() => result.current.setPatToken('glpat-abc'))
    await act(async () => {
      await result.current.handlePatSubmit()
    })

    expect(result.current.detectedScopes).toEqual(['read_user', 'read_repository'])
    expect(result.current.missingScope).toBe(true)
  })

  it('detection warnings reference GITLAB_TOKEN / glab, never GITHUB_TOKEN', async () => {
    installApi(async (channel) => {
      if (channel === 'gitlab:env-credentials') {
        return { found: true, valid: false, error: 'bad token' }
      }
      if (channel === 'gitlab:cli-credentials') return { found: false }
      return {}
    })

    const { result } = renderGitAuth({ id: 'git', provider: PROVIDERS.gitlab })

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

    const { result } = renderGitAuth({ id: 'git', provider: PROVIDERS.gitlab })

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

    const { result } = renderGitAuth({ id: 'git', provider: PROVIDERS.gitlab })

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
    // "401 Unauthorized" (no "invalid"/"expired" keyword). Main classifies it
    // authoritatively as outcome 'invalid', so detection surfaces it from that
    // typed signal instead of looking like "no credentials" — never from
    // error-string matching.
    installApi(async (channel) => {
      if (channel === 'gitlab:enumerate-hosts') return { hosts: [{ host: 'gitlab.com', sources: ['glab'], hasCredential: true }], defaultHost: 'gitlab.com' }
      if (channel === 'gitlab:env-credentials') return { found: false }
      if (channel === 'gitlab:cli-credentials') {
        return { found: true, valid: false, outcome: 'invalid', error: '401 Unauthorized', status: 401, host: 'gitlab.com' }
      }
      return {}
    })

    const { result } = renderGitAuth({ id: 'git', provider: PROVIDERS.gitlab })

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

    const { result } = renderGitAuth({ id: 'gh', provider: PROVIDERS.github, detectCredentials: false })

    act(() => result.current.setPatToken('ghp_abc'))
    await act(async () => {
      await result.current.handlePatSubmit()
    })

    expect(invoke).toHaveBeenCalledWith('github:validate', { token: 'ghp_abc', registerSession: true })
    expect(result.current.authStatus).toBe('authenticated')
    expect(result.current.missingScope).toBe(true)
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

    const { result } = renderGitAuth({ id: 'gh', provider: PROVIDERS.github })

    await waitFor(() => expect(result.current.authStatus).toBe('authenticated'))
    expect(result.current.missingScope).toBe(false)
  })
})

describe('useGitAuth — tri-state unreachable', () => {
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

    const { result } = renderGitAuth({ id: 'git', provider: PROVIDERS.gitlab })

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

    const { result } = renderGitAuth({ id: 'git', provider: PROVIDERS.gitlab })

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

    const { result } = renderGitAuth({ id: 'git', provider: PROVIDERS.gitlab, detectCredentials: false })

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

    const { result } = renderGitAuth({ id: 'gh', provider: PROVIDERS.github })

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

    const { result } = renderGitAuth({ id: 'gh', provider: PROVIDERS.github })

    await waitFor(() => expect(result.current.detectionStatus).toBe('done'))
    expect(result.current.unreachableInfo?.errorKind).toBe('server-cert')
    expect(result.current.oauthUnavailableReason).toBeNull()
  })
})

describe('useGitAuth — copy contracts', () => {
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

    const { result } = renderGitAuth({ id: 'git', provider: PROVIDERS.gitlab })

    await waitFor(() => expect(result.current.detectionStatus).toBe('done'))
    // Exact chip copy — never "expired" (a 401 can't prove that).
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

    const { result } = renderGitAuth({ id: 'git', provider: PROVIDERS.gitlab })

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

    const { result } = renderGitAuth({ id: 'gh', provider: PROVIDERS.github })

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

    const { result } = renderGitAuth({ id: 'gh', provider: PROVIDERS.github })

    await waitFor(() => expect(result.current.detectionStatus).toBe('done'))
    await waitFor(() =>
      expect(result.current.manualHint).toBe(
        "No existing credentials found. Sign in below, set GITHUB_TOKEN, or run 'gh auth login'.",
      ),
    )
  })
})

describe('useGitAuth — host union UX', () => {
  const HOSTS = {
    hosts: [
      { host: 'gitlab.com', sources: ['glab'], hasCredential: true },
      { host: 'git.corp.example', sources: ['recent'], hasCredential: false },
    ],
    defaultHost: 'gitlab.com',
  }

  const detectionCalls = (invoke: ReturnType<typeof installApi>) =>
    invoke.mock.calls.filter((c) => c[0] === 'gitlab:cli-credentials' || c[0] === 'gitlab:env-credentials').length

  it("the 'Other instance…' sentinel leaves the success card without changing the host or running detection", async () => {
    const invoke = installApi(async (channel) => {
      if (channel === 'gitlab:enumerate-hosts') return HOSTS
      if (channel === 'gitlab:env-credentials') {
        return { found: true, valid: true, user: { login: 'tanuki' }, host: 'gitlab.com', envVar: 'GITLAB_TOKEN' }
      }
      return { found: false }
    })

    const { result } = renderGitAuth({ id: 'git', provider: PROVIDERS.gitlab })
    await waitFor(() => expect(result.current.authStatus).toBe('authenticated'))
    const detectionCallsBefore = detectionCalls(invoke)

    act(() => result.current.handleHostSelect('__other__'))

    // The card gives way to the PAT form, whose instance-URL field is asked for,
    // and takes the old instance's credential out of the outputs with it.
    expect(result.current.authStatus).toBe('pending')
    expect(result.current.userInfo).toBeNull()
    expect(registerOutputs).toHaveBeenLastCalledWith('git', { GIT_PROVIDER: 'gitlab' })
    expect(result.current.instanceFieldFocusNonce).toBe(1)
    expect(result.current.selectedHost).toBe('gitlab.com')
    // No re-detection fired and no pick was persisted.
    expect(detectionCalls(invoke)).toBe(detectionCallsBefore)
    expect(invoke.mock.calls.filter((c) => c[0] === 'gitlab:host-picked').length).toBe(0)
  })

  it("the 'Other instance…' sentinel keeps an unauthenticated form's typed token", async () => {
    installApi(async (channel) => {
      if (channel === 'gitlab:enumerate-hosts') return HOSTS
      return { found: false }
    })

    const { result } = renderGitAuth({ id: 'git', provider: PROVIDERS.gitlab })
    await waitFor(() => expect(result.current.detectionStatus).toBe('done'))
    act(() => result.current.setPatToken('glpat-abc'))

    act(() => result.current.handleHostSelect('__other__'))

    expect(result.current.patToken).toBe('glpat-abc')
    expect(result.current.instanceFieldFocusNonce).toBe(1)
  })

  it('a host pick replaces an entered instance URL, even the previously picked host', async () => {
    const invoke = installApi(async (channel) => {
      if (channel === 'gitlab:enumerate-hosts') return HOSTS
      return { found: false }
    })

    const { result } = renderGitAuth({ id: 'git', provider: PROVIDERS.gitlab })
    await waitFor(() => expect(result.current.detectionStatus).toBe('done'))

    act(() => result.current.handleHostSelect('__other__'))
    act(() => result.current.setGitlabInstanceUrl('https://gitlab.new.example'))
    expect(result.current.selectedHost).toBe('gitlab.new.example')

    // gitlab.com is still the internal pick; going back to it must not be a no-op.
    const callsBefore = invoke.mock.calls.length
    act(() => result.current.handleHostSelect('gitlab.com'))

    expect(result.current.selectedHost).toBe('gitlab.com')
    expect(result.current.gitlabInstanceUrl).toBe('')
    await waitFor(() => {
      expect(invoke.mock.calls.slice(callsBefore)).toContainEqual(['gitlab:cli-credentials', { host: 'gitlab.com' }])
    })
    expect(invoke).toHaveBeenCalledWith('gitlab:host-picked', { host: 'gitlab.com' })
  })

  it('a host pick overrides the instanceUrl prop for detection', async () => {
    const invoke = installApi(async (channel) => {
      if (channel === 'gitlab:enumerate-hosts') return HOSTS
      return { found: false }
    })

    const { result } = renderGitAuth({ id: 'git', provider: PROVIDERS.gitlab, instanceUrl: 'https://gitlab.acme.com' })
    await waitFor(() => expect(result.current.detectionStatus).toBe('done'))
    expect(result.current.selectedHost).toBe('gitlab.acme.com')

    const callsBefore = invoke.mock.calls.length
    act(() => result.current.handleHostSelect('git.corp.example'))

    expect(result.current.selectedHost).toBe('git.corp.example')
    await waitFor(() => expect(result.current.detectionStatus).toBe('done'))
    const redetection = invoke.mock.calls
      .slice(callsBefore)
      .filter((c) => c[0] === 'gitlab:cli-credentials' || c[0] === 'gitlab:env-credentials')
    expect(redetection.length).toBe(2)
    for (const [, args] of redetection) {
      expect(args).toEqual(expect.objectContaining({ host: 'git.corp.example' }))
      expect(args).not.toHaveProperty('instanceUrl')
    }
  })

  it('an explicit host pick is persisted via gitlab:host-picked', async () => {
    const invoke = installApi(async (channel) => {
      if (channel === 'gitlab:enumerate-hosts') return HOSTS
      if (channel === 'gitlab:host-picked') return { ok: true }
      if (channel === 'vcs:invalidate-cache') return { ok: true }
      return { found: false }
    })

    const { result } = renderGitAuth({ id: 'git', provider: PROVIDERS.gitlab })
    await waitFor(() => expect(result.current.detectionStatus).toBe('done'))

    act(() => result.current.handleHostSelect('git.corp.example'))

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('gitlab:host-picked', { host: 'git.corp.example' })
    })
    expect(result.current.selectedHost).toBe('git.corp.example')
  })

  it('flags the session as stale when another block authenticates a different host', async () => {
    let sessionChangedHandler: ((payload: unknown) => void) | undefined
    installApi(
      async (channel) => {
        if (channel === 'gitlab:enumerate-hosts') return HOSTS
        if (channel === 'gitlab:env-credentials') {
          return { found: true, valid: true, user: { login: 'tanuki' }, host: 'gitlab.com', envVar: 'GITLAB_TOKEN' }
        }
        if (channel === 'session:set-env') return { ok: true }
        return { found: false }
      },
      (channel, callback) => {
        if (channel === 'vcs:session-changed') sessionChangedHandler = callback
        return () => {}
      },
    )

    const { result } = renderGitAuth({ id: 'git', provider: PROVIDERS.gitlab })
    await waitFor(() => expect(result.current.authStatus).toBe('authenticated'))
    expect(result.current.sessionStale).toBe(false)

    // A second block authenticates a DIFFERENT host → this card is stale.
    act(() => sessionChangedHandler?.({ provider: 'gitlab', host: 'git.corp.example', source: 'cli' }))
    expect(result.current.sessionStale).toBe(true)
  })

  it('ignores session changes for the other provider or the same host', async () => {
    let sessionChangedHandler: ((payload: unknown) => void) | undefined
    installApi(
      async (channel) => {
        if (channel === 'gitlab:enumerate-hosts') return HOSTS
        if (channel === 'gitlab:env-credentials') {
          return { found: true, valid: true, user: { login: 'tanuki' }, host: 'gitlab.com', envVar: 'GITLAB_TOKEN' }
        }
        if (channel === 'session:set-env') return { ok: true }
        return { found: false }
      },
      (channel, callback) => {
        if (channel === 'vcs:session-changed') sessionChangedHandler = callback
        return () => {}
      },
    )

    const { result } = renderGitAuth({ id: 'git', provider: PROVIDERS.gitlab })
    await waitFor(() => expect(result.current.authStatus).toBe('authenticated'))

    act(() => sessionChangedHandler?.({ provider: 'github', host: 'github.com' }))
    expect(result.current.sessionStale).toBe(false)
    act(() => sessionChangedHandler?.({ provider: 'gitlab', host: 'gitlab.com' }))
    expect(result.current.sessionStale).toBe(false)
  })
})

describe('useGitAuth — custody', () => {
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

    const { result } = renderGitAuth({
      id: 'gh2',
      provider: PROVIDERS.github,
      detectCredentials: [{ block: 'github-auth' }],
    })

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

      const { result } = renderGitAuth({ id: 'gh', provider: PROVIDERS.github, detectCredentials: false })

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

describe('useGitAuth — OAuth device-code polling', () => {
  const DEVICE_CODE = { deviceCode: 'dev123', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', interval: 5 }

  function installOAuthApi(start: Record<string, unknown>, nextPoll: () => unknown) {
    return installApi(async (channel) => {
      if (channel === 'github:oauth-start') return start
      if (channel === 'github:oauth-poll') return nextPoll()
      return { found: false }
    })
  }

  const pollCount = (invoke: ReturnType<typeof installApi>) =>
    invoke.mock.calls.filter((c) => c[0] === 'github:oauth-poll').length

  const renderOAuthHook = () =>
    renderGitAuth({ id: 'gh', provider: PROVIDERS.github, detectCredentials: false })

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps polling past 2 minutes while the device code is still valid', async () => {
    const invoke = installOAuthApi({ ...DEVICE_CODE, expiresIn: 900 }, () => ({ status: 'pending' }))
    const { result } = renderOAuthHook()

    await act(async () => {
      await result.current.startOAuth()
      await vi.advanceTimersByTimeAsync(3 * 60_000)
    })

    expect(result.current.authStatus).toBe('authenticating')
    expect(result.current.errorMessage).toBeNull()
    expect(pollCount(invoke)).toBeGreaterThan(24)
  })

  it('reports an expired code, not "Authorization failed", once the code outlives its expiry', async () => {
    const invoke = installOAuthApi({ ...DEVICE_CODE, expiresIn: 60 }, () => ({ status: 'pending' }))
    const { result } = renderOAuthHook()

    await act(async () => {
      await result.current.startOAuth()
      await vi.advanceTimersByTimeAsync(65_000)
    })

    expect(result.current.authStatus).toBe('failed')
    expect(result.current.errorMessage).toBe('Authorization request expired. Please try again.')
    // Polling stopped at the deadline.
    const polls = pollCount(invoke)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(pollCount(invoke)).toBe(polls)
  })

  it('backs off to the interval GitHub sends with slow_down, for every later poll', async () => {
    let polls = 0
    const invoke = installOAuthApi({ ...DEVICE_CODE, expiresIn: 900 }, () =>
      ++polls === 1 ? { status: 'pending', slowDown: true, interval: 15 } : { status: 'pending' },
    )
    const { result } = renderOAuthHook()

    await act(async () => {
      await result.current.startOAuth()
    })
    expect(pollCount(invoke)).toBe(1)

    // GitHub's 15s beats the 5s + 5s increment.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_999)
    })
    expect(pollCount(invoke)).toBe(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(pollCount(invoke)).toBe(2)

    // The slower interval sticks after GitHub stops sending slow_down.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_999)
    })
    expect(pollCount(invoke)).toBe(2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(pollCount(invoke)).toBe(3)
  })

  it('a poll in flight when the flow is cancelled and reset never publishes its result', async () => {
    let resolvePoll: (value: unknown) => void = () => {}
    const invoke = installApi(async (channel) => {
      if (channel === 'github:oauth-start') return { ...DEVICE_CODE, expiresIn: 900 }
      if (channel === 'github:oauth-poll') return new Promise((resolve) => { resolvePoll = resolve })
      return { found: false }
    })
    const { result } = renderOAuthHook()

    await act(async () => {
      await result.current.startOAuth()
    })
    expect(pollCount(invoke)).toBe(1)

    // GitAuth's provider switch, while GitHub is still answering the poll.
    act(() => {
      result.current.cancelOAuth()
      result.current.resetAuth()
    })
    await act(async () => {
      resolvePoll({ status: 'complete', user: { login: 'octocat' }, tokenType: 'oauth', scopes: ['repo'] })
    })

    expect(result.current.authStatus).toBe('pending')
    expect(result.current.userInfo).toBeNull()
    expect(registerOutputs).not.toHaveBeenCalled()
  })

  it('cancel then restart polls only the new device code', async () => {
    let starts = 0
    let resolveFirstPoll: (value: unknown) => void = () => {}
    const invoke = installApi(async (channel, args) => {
      if (channel === 'github:oauth-start') {
        starts += 1
        return { ...DEVICE_CODE, deviceCode: `dev-${starts}`, userCode: `CODE-${starts}`, expiresIn: 900 }
      }
      if (channel === 'github:oauth-poll') {
        if ((args as { deviceCode: string }).deviceCode === 'dev-1') {
          return new Promise((resolve) => { resolveFirstPoll = resolve })
        }
        return { status: 'pending' }
      }
      return { found: false }
    })
    const polledCodes = () =>
      invoke.mock.calls
        .filter((c) => c[0] === 'github:oauth-poll')
        .map((c) => (c[1] as { deviceCode: string }).deviceCode)
    const { result } = renderOAuthHook()

    await act(async () => {
      await result.current.startOAuth()
    })
    // Cancel while dev-1's first poll is in flight, then start over.
    act(() => result.current.cancelOAuth())
    await act(async () => {
      await result.current.startOAuth()
    })
    await act(async () => {
      resolveFirstPoll({ status: 'pending' })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })

    expect(polledCodes()[0]).toBe('dev-1')
    expect(polledCodes().slice(1).length).toBeGreaterThan(1)
    expect(polledCodes().slice(1).every((code) => code === 'dev-2')).toBe(true)
    expect(result.current.oauthUserCode).toBe('CODE-2')
    expect(result.current.authStatus).toBe('authenticating')
  })
})

describe('useGitAuth — Re-authenticate', () => {
  const envCalls = (invoke: ReturnType<typeof installApi>) =>
    invoke.mock.calls.filter((c) => c[0] === 'github:env-credentials').length

  const focusWindow = async () => {
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    // Give a re-detection every chance to start and settle.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }

  it('withdraws the credential from the outputs and keeps GIT_PROVIDER', async () => {
    installApi(async (channel) => {
      if (channel === 'github:validate') return { valid: true, user: { login: 'octocat' }, tokenType: 'classic_pat', scopes: ['repo'] }
      return { found: false }
    })
    const { result } = renderGitAuth({ id: 'gh', provider: PROVIDERS.github, detectCredentials: false })

    act(() => result.current.setPatToken('ghp_abc'))
    await act(async () => {
      await result.current.handlePatSubmit()
    })
    expect(registerOutputs).toHaveBeenLastCalledWith('gh', expect.objectContaining({ GITHUB_TOKEN: 'ghp_abc' }))

    act(() => result.current.reAuthenticate())

    expect(result.current.authStatus).toBe('pending')
    expect(registerOutputs).toHaveBeenLastCalledWith('gh', { GIT_PROVIDER: 'github' })
  })

  it('does not re-detect the ambient credential on window focus', async () => {
    const invoke = installApi(async (channel) => {
      if (channel === 'github:env-credentials') {
        return { found: true, valid: true, user: { login: 'ambient' }, envVar: 'GITHUB_TOKEN' }
      }
      return { found: false }
    })
    const { result } = renderGitAuth({ id: 'gh', provider: PROVIDERS.github })
    await waitFor(() => expect(result.current.authStatus).toBe('authenticated'))

    act(() => result.current.reAuthenticate())
    // The user leaves to create a new token and comes back.
    await focusWindow()

    expect(result.current.authStatus).toBe('pending')
    expect(envCalls(invoke)).toBe(1)

    // An explicit "Check again" still re-detects.
    act(() => result.current.retryUnreachable())
    await waitFor(() => expect(result.current.authStatus).toBe('authenticated'))
    expect(envCalls(invoke)).toBe(2)
  })

  it('still re-detects on window focus when detection found nothing', async () => {
    // The zero-click path: sign in with `gh auth login` in a terminal, come back.
    const invoke = installApi(async () => ({ found: false }))
    const { result } = renderGitAuth({ id: 'gh', provider: PROVIDERS.github })
    await waitFor(() => expect(result.current.detectionStatus).toBe('done'))
    expect(envCalls(invoke)).toBe(1)

    await focusWindow()

    await waitFor(() => expect(envCalls(invoke)).toBe(2))
  })
})

describe('useGitAuth — {block} detection sources', () => {
  it('falls through to the next source when the block ran without a token', async () => {
    // The block ran and registered outputs, just none this provider reads.
    blockOutputs = { mint: { values: { GH_PAT: 'ghp_abc' } } }
    const invoke = installApi(async (channel) => {
      if (channel === 'github:env-credentials') {
        return { found: true, valid: true, user: { login: 'octocat' }, envVar: 'GITHUB_TOKEN' }
      }
      return { found: false }
    })

    const { result } = renderGitAuth({ id: 'gh', provider: PROVIDERS.github, detectCredentials: [{ block: 'mint' }, 'env'] })

    await waitFor(() => expect(result.current.authStatus).toBe('authenticated'))
    expect(result.current.detectionSource).toBe('env')
    expect(result.current.waitingForBlockId).toBeNull()
    expect(invoke).not.toHaveBeenCalledWith('github:validate', expect.anything())
  })

  it('pauses on a block that has not run, then resumes the later sources once it runs empty', async () => {
    const invoke = installApi(async (channel) => {
      if (channel === 'github:env-credentials') {
        return { found: true, valid: true, user: { login: 'octocat' }, envVar: 'GITHUB_TOKEN' }
      }
      return { found: false }
    })

    const { result, rerender } = renderGitAuth({ id: 'gh', provider: PROVIDERS.github, detectCredentials: [{ block: 'mint' }, 'env'] })

    await waitFor(() => expect(result.current.waitingForBlockId).toBe('mint'))
    expect(result.current.detectionStatus).toBe('pending')
    // The author's order is the priority order: env waits behind the block.
    expect(invoke).not.toHaveBeenCalledWith('github:env-credentials', expect.anything())

    // The block finishes without outputs (e.g. its script failed).
    blockOutputs = { mint: { values: {} } }
    rerender()

    await waitFor(() => expect(result.current.authStatus).toBe('authenticated'))
    expect(result.current.detectionSource).toBe('env')
    expect(invoke.mock.calls.filter((c) => c[0] === 'github:env-credentials')).toHaveLength(1)
  })

  it("keeps waiting on a GitAuth block's pre-auth placeholder, then chains its auth", async () => {
    // What an upstream <GitAuth> registers when its provider is switched
    // before it authenticates: GIT_PROVIDER only.
    blockOutputs = { git_auth: { values: { GIT_PROVIDER: 'github' } } }
    const invoke = installApi(async (channel, args) => {
      if (channel === 'github:validate' && (args as { useSessionToken?: boolean }).useSessionToken) {
        return { valid: true, user: { login: 'octocat' }, tokenType: 'oauth' }
      }
      if (channel === 'github:env-credentials') {
        return { found: true, valid: true, user: { login: 'ambient' }, envVar: 'GITHUB_TOKEN' }
      }
      return { found: false }
    })

    const { result, rerender } = renderGitAuth({ id: 'gh2', provider: PROVIDERS.github, detectCredentials: [{ block: 'git-auth' }, 'env'] })

    await waitFor(() => expect(result.current.waitingForBlockId).toBe('git-auth'))
    expect(invoke).not.toHaveBeenCalledWith('github:env-credentials', expect.anything())

    blockOutputs = { git_auth: { values: { GITHUB_USER: 'octocat', GIT_PROVIDER: 'github', __AUTHENTICATED: 'true' } } }
    rerender()

    await waitFor(() => expect(result.current.authStatus).toBe('authenticated'))
    expect(result.current.detectionSource).toBe('block')
    expect(result.current.userInfo?.login).toBe('octocat')
    expect(invoke).not.toHaveBeenCalledWith('github:env-credentials', expect.anything())
  })

  it('shows the unreachable card when the awaited block\'s token hits a TLS wall', async () => {
    const invoke = installApi(async (channel) => {
      if (channel === 'github:validate') {
        return { valid: false, outcome: 'unreachable', errorKind: 'tls', coldReadOk: true, error: 'TypeError: fetch failed' }
      }
      return { found: false }
    })

    const { result, rerender } = renderGitAuth({ id: 'gh', provider: PROVIDERS.github, detectCredentials: [{ block: 'mint' }, 'env'] })
    await waitFor(() => expect(result.current.waitingForBlockId).toBe('mint'))

    blockOutputs = { mint: { values: { GITHUB_TOKEN: 'ghp_abc' } } }
    rerender()

    await waitFor(() => expect(result.current.detectionStatus).toBe('done'))
    expect(result.current.unreachableInfo).toEqual({ errorKind: 'tls', host: 'github.com', coldReadOk: true })
    expect(result.current.authStatus).toBe('pending')
    // Every later source would hit the same wall, so the chain stops.
    expect(invoke).not.toHaveBeenCalledWith('github:env-credentials', expect.anything())
  })

  it('keeps the warnings collected before it paused on a block', async () => {
    const WARNING = 'GITHUB_TOKEN is not valid for github.com'
    installApi(async (channel) => {
      if (channel === 'github:env-credentials') {
        return { found: true, valid: false, outcome: 'invalid', envVar: 'GITHUB_TOKEN', warning: WARNING }
      }
      return { found: false }
    })

    const { result, rerender } = renderGitAuth({ id: 'gh', provider: PROVIDERS.github, detectCredentials: ['env', { block: 'mint' }] })
    await waitFor(() => expect(result.current.waitingForBlockId).toBe('mint'))

    // The block finishes without outputs, which ends the walk.
    blockOutputs = { mint: { values: {} } }
    rerender()

    await waitFor(() => expect(result.current.detectionStatus).toBe('done'))
    expect(result.current.detectionWarning).toBe(WARNING)
  })

  it('warns about a block token that lacks the repo scope', async () => {
    blockOutputs = { mint: { values: { GITHUB_TOKEN: 'ghp_abc' } } }
    installApi(async (channel) => {
      if (channel === 'github:validate') {
        return { valid: true, user: { login: 'octocat' }, tokenType: 'classic_pat', scopes: ['read:org'], validatedVia: 'direct' }
      }
      return { found: false }
    })

    const { result } = renderGitAuth({ id: 'gh', provider: PROVIDERS.github, detectCredentials: [{ block: 'mint' }] })

    await waitFor(() => expect(result.current.authStatus).toBe('authenticated'))
    expect(result.current.detectionSource).toBe('block')
    expect(result.current.detectedScopes).toEqual(['read:org'])
    expect(result.current.detectedTokenType).toBe('classic_pat')
    expect(result.current.successMeta).toEqual({ validatedVia: 'direct' })
    expect(result.current.missingScope).toBe(true)
  })
})

// A GitHub → GitLab switch while a GitHub token is still being validated. The
// stale validation must not sign the GitLab card in or publish GitHub outputs
// over the GIT_PROVIDER the switch wrote: an `*AuthId` step would run with
// the GitHub token.
describe('useGitAuth — provider switch mid-validation', () => {
  const GITHUB_USER = { valid: true, user: { login: 'octocat' }, tokenType: 'classic_pat', scopes: ['repo'] }

  function renderSwitchable(options: Options) {
    return renderHook((props: Options) => useGitAuth(props), { wrapper, initialProps: options })
  }

  /** GitAuth.tsx's handleSelectProvider, at the hook level. */
  function switchToGitLab(
    { result, rerender }: ReturnType<typeof renderSwitchable>,
    options: Options,
  ) {
    act(() => {
      result.current.cancelOAuth()
      result.current.clearRegisteredOutputs('gitlab')
      result.current.resetAuth()
      result.current.resetDetectionState()
    })
    rerender({ ...options, provider: PROVIDERS.gitlab })
  }

  function installDeferredValidate() {
    const pending: { resolve: (value: unknown) => void } = { resolve: () => {} }
    const invoke = installApi(async (channel) => {
      if (channel === 'github:validate') return new Promise((resolve) => { pending.resolve = resolve })
      return { found: false }
    })
    return { invoke, pending }
  }

  const expectSignedOutOnGitLab = (result: ReturnType<typeof renderSwitchable>['result']) => {
    expect(result.current.authStatus).toBe('pending')
    expect(result.current.userInfo).toBeNull()
    expect(result.current.detectionSource).toBeNull()
    // The switch's GIT_PROVIDER is the only output ever published.
    expect(registerOutputs.mock.calls).toEqual([['gh', { GIT_PROVIDER: 'gitlab' }]])
  }

  it('drops a {block} token validated by the detection walk', async () => {
    blockOutputs = { mint: { values: { GITHUB_TOKEN: 'ghp_abc' } } }
    const { invoke, pending } = installDeferredValidate()
    const options: Options = { id: 'gh', provider: PROVIDERS.github, detectCredentials: [{ block: 'mint' }] }
    const hook = renderSwitchable(options)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('github:validate', expect.anything()))

    switchToGitLab(hook, options)
    await waitFor(() => expect(hook.result.current.detectionStatus).toBe('done'))
    await act(async () => {
      pending.resolve(GITHUB_USER)
    })

    expectSignedOutOnGitLab(hook.result)
  })

  it('drops a {block} token validated after the walk resumed', async () => {
    const { invoke, pending } = installDeferredValidate()
    const options: Options = { id: 'gh', provider: PROVIDERS.github, detectCredentials: [{ block: 'mint' }] }
    const hook = renderSwitchable(options)
    await waitFor(() => expect(hook.result.current.waitingForBlockId).toBe('mint'))

    blockOutputs = { mint: { values: { GITHUB_TOKEN: 'ghp_abc' } } }
    hook.rerender(options)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('github:validate', expect.anything()))

    switchToGitLab(hook, options)
    await waitFor(() => expect(hook.result.current.detectionStatus).toBe('done'))
    await act(async () => {
      pending.resolve(GITHUB_USER)
    })

    expectSignedOutOnGitLab(hook.result)
  })

  it('drops a PAT validated after the switch', async () => {
    const { invoke, pending } = installDeferredValidate()
    const options: Options = { id: 'gh', provider: PROVIDERS.github, detectCredentials: false }
    const hook = renderSwitchable(options)

    act(() => hook.result.current.setPatToken('ghp_abc'))
    let submitted: Promise<void> = Promise.resolve()
    act(() => {
      submitted = hook.result.current.handlePatSubmit()
    })
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('github:validate', expect.anything()))

    switchToGitLab(hook, options)
    await act(async () => {
      pending.resolve(GITHUB_USER)
      await submitted
    })

    expectSignedOutOnGitLab(hook.result)
  })
})

// A host pick, Reload or Check again sends the card back through detection.
// Whatever the card held or was signing in with belongs to what it just left,
// so none of it may stay published or land afterwards: an `*AuthId` step
// would run with the wrong instance's credential.
describe('useGitAuth — re-detection drops the previous credential', () => {
  const HOSTS = {
    hosts: [
      { host: 'gitlab.com', sources: ['glab'], hasCredential: true },
      { host: 'git.corp.example', sources: ['recent'], hasCredential: false },
    ],
    defaultHost: 'gitlab.com',
  }
  const TANUKI = { found: true, valid: true, user: { login: 'tanuki' }, host: 'gitlab.com', envVar: 'GITLAB_TOKEN' }

  it('a host pick on an authenticated card withdraws its outputs, and nothing is found on the new host', async () => {
    installApi(async (channel, args) => {
      if (channel === 'gitlab:enumerate-hosts') return HOSTS
      if (channel === 'gitlab:env-credentials') {
        return (args as { host?: string }).host === 'gitlab.com' ? TANUKI : { found: false }
      }
      return { found: false }
    })
    const { result } = renderGitAuth({ id: 'git', provider: PROVIDERS.gitlab })
    await waitFor(() => expect(result.current.authStatus).toBe('authenticated'))
    expect(registerOutputs).toHaveBeenLastCalledWith('git', expect.objectContaining({ __AUTHENTICATED: 'true' }))
    registerOutputs.mockClear()

    act(() => result.current.handleHostSelect('git.corp.example'))

    // Withdrawn before detection on the new host starts ("Checking…").
    expect(result.current.detectionStatus).toBe('pending')
    expect(registerOutputs).toHaveBeenLastCalledWith('git', { GIT_PROVIDER: 'gitlab' })

    await waitFor(() => expect(result.current.detectionStatus).toBe('done'))
    expect(result.current.authStatus).toBe('pending')
    expect(result.current.selectedHost).toBe('git.corp.example')
    expect(registerOutputs.mock.calls).toEqual([['git', { GIT_PROVIDER: 'gitlab' }]])
  })

  it('Reload on an authenticated card withdraws its outputs until detection signs back in', async () => {
    let envCalls = 0
    const second: { resolve: (value: unknown) => void } = { resolve: () => {} }
    installApi(async (channel) => {
      if (channel === 'gitlab:enumerate-hosts') return HOSTS
      if (channel === 'gitlab:env-credentials') {
        return ++envCalls === 1 ? TANUKI : new Promise((resolve) => { second.resolve = resolve })
      }
      return { found: false }
    })
    const { result } = renderGitAuth({ id: 'git', provider: PROVIDERS.gitlab })
    await waitFor(() => expect(result.current.authStatus).toBe('authenticated'))

    act(() => result.current.reloadDetection())

    expect(registerOutputs).toHaveBeenLastCalledWith('git', { GIT_PROVIDER: 'gitlab' })
    await waitFor(() => expect(envCalls).toBe(2))
    // Still checking: the old credential stays withdrawn.
    expect(result.current.detectionStatus).toBe('pending')
    expect(registerOutputs).toHaveBeenLastCalledWith('git', { GIT_PROVIDER: 'gitlab' })

    await act(async () => {
      second.resolve(TANUKI)
    })

    await waitFor(() => expect(result.current.authStatus).toBe('authenticated'))
    expect(registerOutputs).toHaveBeenLastCalledWith('git', {
      GITLAB_USER: 'tanuki',
      GIT_PROVIDER: 'gitlab',
      __AUTHENTICATED: 'true',
    })
  })

  it.each([
    ['a host pick', (auth: ReturnType<typeof useGitAuth>) => auth.handleHostSelect('git.corp.example')],
    ['Reload', (auth: ReturnType<typeof useGitAuth>) => auth.reloadDetection()],
  ])('drops a PAT validated after %s', async (_label, redetect) => {
    const pending: { resolve: (value: unknown) => void } = { resolve: () => {} }
    const invoke = installApi(async (channel) => {
      if (channel === 'gitlab:enumerate-hosts') return HOSTS
      if (channel === 'gitlab:validate') return new Promise((resolve) => { pending.resolve = resolve })
      return { found: false }
    })
    const { result } = renderGitAuth({ id: 'git', provider: PROVIDERS.gitlab })
    await waitFor(() => expect(result.current.detectionStatus).toBe('done'))

    act(() => result.current.setPatToken('glpat-old'))
    let submitted: Promise<void> = Promise.resolve()
    act(() => {
      submitted = result.current.handlePatSubmit()
    })
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('gitlab:validate', expect.anything()))
    expect(result.current.authStatus).toBe('authenticating')

    act(() => redetect(result.current))
    await waitFor(() => expect(result.current.detectionStatus).toBe('done'))
    await act(async () => {
      pending.resolve({ valid: true, user: { login: 'tanuki' }, tokenType: 'pat' })
      await submitted
    })

    expect(result.current.authStatus).toBe('pending')
    expect(result.current.userInfo).toBeNull()
    expect(registerOutputs).not.toHaveBeenCalled()
  })

  it('Check again ends a device flow in progress', async () => {
    let resolvePoll: (value: unknown) => void = () => {}
    const invoke = installApi(async (channel) => {
      if (channel === 'github:oauth-start') {
        return { deviceCode: 'dev123', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', interval: 5, expiresIn: 900 }
      }
      if (channel === 'github:oauth-poll') return new Promise((resolve) => { resolvePoll = resolve })
      return { found: false }
    })
    const { result } = renderGitAuth({ id: 'gh', provider: PROVIDERS.github })
    await waitFor(() => expect(result.current.detectionStatus).toBe('done'))

    await act(async () => {
      await result.current.startOAuth()
    })
    expect(invoke).toHaveBeenCalledWith('github:oauth-poll', expect.anything())

    act(() => result.current.retryUnreachable())
    await waitFor(() => expect(result.current.detectionStatus).toBe('done'))
    await act(async () => {
      resolvePoll({ status: 'complete', user: { login: 'octocat' }, tokenType: 'oauth', scopes: ['repo'] })
    })

    expect(result.current.authStatus).toBe('pending')
    expect(result.current.userInfo).toBeNull()
    expect(result.current.oauthUserCode).toBeNull()
    expect(registerOutputs).not.toHaveBeenCalled()
  })
})

describe('useGitAuth — success details', () => {
  it('keeps the token type of a CLI-detected token', async () => {
    installApi(async (channel) => {
      if (channel === 'github:cli-credentials') {
        return { found: true, user: { login: 'my-app[bot]' }, tokenType: 'github_app' }
      }
      return { found: false }
    })

    const { result } = renderGitAuth({ id: 'gh', provider: PROVIDERS.github })

    await waitFor(() => expect(result.current.authStatus).toBe('authenticated'))
    expect(result.current.detectionSource).toBe('cli')
    expect(result.current.detectedTokenType).toBe('github_app')
  })

  it('names the variable and the transport of a prefixed env token', async () => {
    const DIVERGENCE = 'PROD_GH_TOKEN is also set and differs; Runbooks used PROD_GITHUB_TOKEN.'
    const invoke = installApi(async (channel) => {
      if (channel === 'github:env-credentials') {
        return {
          found: true,
          valid: true,
          user: { login: 'octocat' },
          tokenType: 'fine_grained_pat',
          envVar: 'PROD_GITHUB_TOKEN',
          validatedVia: 'cli',
          divergenceHint: DIVERGENCE,
        }
      }
      return { found: false }
    })

    const { result } = renderGitAuth({ id: 'gh', provider: PROVIDERS.github, detectCredentials: [{ env: { prefix: 'PROD_' } }] })

    await waitFor(() => expect(result.current.authStatus).toBe('authenticated'))
    expect(invoke).toHaveBeenCalledWith('github:env-credentials', expect.objectContaining({ prefix: 'PROD_' }))
    expect(result.current.successMeta).toEqual({ source: 'env', envVar: 'PROD_GITHUB_TOKEN', validatedVia: 'cli' })
    expect(result.current.divergenceHint).toBe(DIVERGENCE)
    expect(result.current.detectedTokenType).toBe('fine_grained_pat')
  })
})
