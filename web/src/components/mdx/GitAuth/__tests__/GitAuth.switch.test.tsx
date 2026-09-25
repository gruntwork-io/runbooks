import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { TestWrapper } from '@/test/test-utils'
import { useErrorReporting } from '@/contexts/useErrorReporting'

// Integration test that exercises the REAL useGitAuth hook (not mocked) across a
// runtime provider switch. detectCredentials={false} disables auto-detection so
// the manual auth forms render immediately without any IPC.
vi.mock('@/contexts/useSession', () => ({
  useSession: () => ({ isReady: true }),
}))

import { GitAuth } from '../GitAuth'

const originalApi = window.api

beforeEach(() => {
  window.api = {
    invoke: vi.fn(async () => ({})),
    on: vi.fn(() => () => {}),
    once: vi.fn(),
  } as unknown as typeof window.api
})

afterEach(() => {
  window.api = originalApi
  vi.clearAllMocks()
})

describe('GitAuth — provider switch (real hook)', () => {
  it('GitHub→GitLab switch renders the GitLab PAT form (not an empty form region)', async () => {
    render(
      <TestWrapper>
        <GitAuth id="git" detectCredentials={false} />
      </TestWrapper>,
    )

    // Starts on GitHub with the OAuth device flow visible.
    expect(screen.getByText(/redirected to authorize/i)).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/GitLab access token/i)).toBeNull()

    // Switch to GitLab via the provider picker.
    fireEvent.click(screen.getByRole('tab', { name: /GitLab/ }))

    // Regression guard: the GitLab PAT form must appear. Before the fix, the
    // auth method stayed 'oauth' and GitLab (which has no OAuth) rendered
    // nothing in the form region.
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/GitLab access token/i)).toBeInTheDocument()
    })
    expect(screen.queryByText(/redirected to authorize/i)).toBeNull()
  })

  it('keeps the host switcher visible after auto-authenticating, so you can move to a self-managed host', async () => {
    // Reproduces the reported issue: auto-detection lands on glab's default host
    // (gitlab.com), and the user still needs to reach their private instance.
    const invoke = vi.fn(async (channel: string, args?: { host?: string }) => {
      if (channel === 'gitlab:enumerate-hosts') {
        return { hosts: [{ host: 'gitlab.com', sources: ['glab'], hasCredential: true }, { host: 'gitlab.gruntwork.io', sources: ['glab'], hasCredential: true }], defaultHost: 'gitlab.com' }
      }
      if (channel === 'gitlab:env-credentials') return { found: false }
      if (channel === 'gitlab:cli-credentials') {
        const host = args?.host
        return {
          found: true,
          user: { login: host === 'gitlab.gruntwork.io' ? 'root' : 'odgrim' },
          host,
        }
      }
      if (channel === 'session:set-env') return { ok: true }
      return {}
    })
    window.api = {
      invoke,
      on: vi.fn(() => () => {}),
      once: vi.fn(),
    } as unknown as typeof window.api

    render(
      <TestWrapper>
        <GitAuth id="git" provider="gitlab" />
      </TestWrapper>,
    )

    // Auto-detects against glab's default host first.
    await waitFor(() => {
      expect(screen.getByText(/Authenticated to GitLab \(gitlab\.com\)/i)).toBeInTheDocument()
    })

    // The host switcher must still be on screen (it was previously hidden once
    // authenticated), offering the private instance.
    const select = screen.getByRole('combobox')
    expect(screen.getByRole('option', { name: 'gitlab.gruntwork.io' })).toBeInTheDocument()

    // Switching hosts re-detects against the chosen instance.
    fireEvent.change(select, { target: { value: 'gitlab.gruntwork.io' } })

    await waitFor(() => {
      expect(screen.getByText(/Authenticated to GitLab \(gitlab\.gruntwork\.io\)/i)).toBeInTheDocument()
    })
    expect(invoke).toHaveBeenCalledWith('gitlab:cli-credentials', { host: 'gitlab.gruntwork.io' })
  })

  it('GitHub→GitLab switch detects only once the GitLab hosts are known', async () => {
    // The glab default (or the persisted pick) is a self-managed host. Nothing
    // may be detected against the gitlab.com default before the enumeration
    // says so — a gitlab.com env hit would authenticate the wrong instance.
    let resolveHosts: (value: unknown) => void = () => {}
    const invoke = vi.fn(async (channel: string, args?: { host?: string }) => {
      if (channel === 'gitlab:enumerate-hosts') {
        return new Promise((resolve) => {
          resolveHosts = resolve
        })
      }
      if (channel === 'gitlab:env-credentials') {
        return args?.host === 'gitlab.com'
          ? { found: true, valid: true, user: { login: 'tanuki' }, envVar: 'GITLAB_TOKEN', host: 'gitlab.com' }
          : { found: false }
      }
      if (channel.endsWith('-credentials')) return { found: false }
      return {}
    })
    window.api = {
      invoke,
      on: vi.fn(() => () => {}),
      once: vi.fn(),
    } as unknown as typeof window.api

    render(
      <TestWrapper>
        <GitAuth id="git" />
      </TestWrapper>,
    )

    // GitHub detection finds nothing, so the manual UI renders.
    await waitFor(() => {
      expect(screen.getByText(/redirected to authorize/i)).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('tab', { name: /GitLab/ }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('gitlab:enumerate-hosts', {}))
    const gitlabDetectionCalls = () =>
      invoke.mock.calls.filter((c) => c[0] === 'gitlab:env-credentials' || c[0] === 'gitlab:cli-credentials')
    expect(gitlabDetectionCalls()).toEqual([])

    await act(async () => {
      resolveHosts({
        hosts: [{ host: 'gitlab.corp', sources: ['glab'], hasCredential: true }],
        defaultHost: 'gitlab.corp',
      })
    })

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('gitlab:cli-credentials', { host: 'gitlab.corp' }))
    expect(invoke).toHaveBeenCalledWith('gitlab:env-credentials', expect.objectContaining({ host: 'gitlab.corp' }))
    expect(gitlabDetectionCalls().every((c) => (c[1] as { host?: string }).host === 'gitlab.corp')).toBe(true)
    expect(screen.queryByText(/Authenticated to GitLab/i)).toBeNull()
  })

  it('GitLab→GitHub switch restores the GitHub OAuth flow', async () => {
    render(
      <TestWrapper>
        <GitAuth id="git" provider="gitlab" detectCredentials={false} />
      </TestWrapper>,
    )

    expect(screen.getByPlaceholderText(/GitLab access token/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /GitHub/ }))

    await waitFor(() => {
      expect(screen.getByText(/redirected to authorize/i)).toBeInTheDocument()
    })
  })
})

describe('GitAuth — defaultTab (real hook)', () => {
  it('opens on the PAT form when the author asks for it', () => {
    render(
      <TestWrapper>
        <GitAuth id="git" defaultTab="pat" detectCredentials={false} />
      </TestWrapper>,
    )

    expect(screen.getByPlaceholderText(/github_pat_/i)).toBeInTheDocument()
    expect(screen.queryByText(/redirected to authorize/i)).toBeNull()
  })

  it('re-applies defaultTab after a provider switch', async () => {
    render(
      <TestWrapper>
        <GitAuth id="git" provider="gitlab" defaultTab="pat" detectCredentials={false} />
      </TestWrapper>,
    )

    expect(screen.getByPlaceholderText(/GitLab access token/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /GitHub/ }))

    // GitHub defaults to OAuth, but the author pinned the PAT tab.
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/github_pat_/i)).toBeInTheDocument()
    })
    expect(screen.queryByText(/redirected to authorize/i)).toBeNull()
  })

  it('ignores a tab the provider does not offer', () => {
    // GitLab has no OAuth device flow — the PAT form must still render.
    render(
      <TestWrapper>
        <GitAuth id="git" provider="gitlab" defaultTab="oauth" detectCredentials={false} />
      </TestWrapper>,
    )

    expect(screen.getByPlaceholderText(/GitLab access token/i)).toBeInTheDocument()
  })
})

describe('GitAuth — configuration errors (real hook)', () => {
  function ReportedErrors() {
    const { errors } = useErrorReporting()
    return <div data-testid="reported-errors">{errors.map((e) => e.message).join('|')}</div>
  }

  it('reports an unknown provider instead of crashing the runbook, and detects nothing', async () => {
    const invoke = vi.fn(async () => ({ found: false }))
    window.api = {
      invoke,
      on: vi.fn(() => () => {}),
      once: vi.fn(),
    } as unknown as typeof window.api

    render(
      <TestWrapper>
        {/* A case typo an author can easily make in MDX. */}
        <GitAuth id="git" provider={'GitLab' as never} />
        <p>The next step</p>
        <ReportedErrors />
      </TestWrapper>,
    )

    expect(screen.getByTestId('component-error')).toHaveTextContent(`invalid 'provider' prop: "GitLab"`)
    // The rest of the runbook still renders.
    expect(screen.getByText('The next step')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByTestId('reported-errors').textContent).toContain("invalid 'provider' prop")
    })
    const channels = invoke.mock.calls.map((c) => (c as unknown[])[0] as string)
    expect(channels.filter((c) => c.endsWith('-credentials') || c.endsWith(':validate'))).toEqual([])
  })

  it('skips an unrecognized detectCredentials entry and still tries the rest', async () => {
    const invoke = vi.fn(async () => ({ found: false }))
    window.api = {
      invoke,
      on: vi.fn(() => () => {}),
      once: vi.fn(),
    } as unknown as typeof window.api

    render(
      <TestWrapper>
        <GitAuth id="git" detectCredentials={['gh' as never, 'env']} />
      </TestWrapper>,
    )

    // Detection finishes (no hung "Checking…" spinner) and the sign-in form renders.
    await waitFor(() => {
      expect(screen.getByText(/redirected to authorize/i)).toBeInTheDocument()
    })
    expect(invoke).toHaveBeenCalledWith('github:env-credentials', expect.anything())
  })
})
