import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { TestWrapper } from '@/test/test-utils'

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
        return { hosts: ['gitlab.com', 'gitlab.gruntwork.io'], defaultHost: 'gitlab.com' }
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
