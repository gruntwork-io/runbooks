import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { TestWrapper } from '@/test/test-utils'

// Exercises the REAL useGitAuth hook for GitHub Enterprise host handling.
vi.mock('@/contexts/useSession', () => ({
  useSession: () => ({ isReady: true }),
}))

import { GitAuth } from '../GitAuth'
import { GitHubAuth } from '../../GitHubAuth'

const originalApi = window.api

function installApi(impl: (channel: string, args?: unknown) => unknown) {
  const invoke = vi.fn(async (channel: string, args?: unknown) => impl(channel, args))
  window.api = {
    invoke,
    on: vi.fn(() => () => {}),
    once: vi.fn(),
  } as unknown as typeof window.api
  return invoke
}

afterEach(() => {
  window.api = originalApi
  vi.clearAllMocks()
})

const TWO_HOSTS = {
  hosts: [
    { host: 'github.com', sources: [], hasCredential: false },
    { host: 'ghes.corp', sources: ['gh'], hasCredential: true },
  ],
  defaultHost: 'github.com',
}

describe('GitAuth (GitHub) — host picker', () => {
  it('shows no picker when only github.com is available (unchanged UI)', async () => {
    const invoke = installApi((channel) => {
      if (channel === 'github:enumerate-hosts') {
        return { hosts: [{ host: 'github.com', sources: [], hasCredential: false }], defaultHost: 'github.com' }
      }
      return { found: false }
    })

    render(<TestWrapper><GitAuth id="git" /></TestWrapper>)

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('github:cli-credentials', { host: 'github.com' })
    })
    await screen.findByText(/redirected to authorize/i)
    expect(screen.queryByText(/GitHub host:/)).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('shows a GitHub host picker (without "Other instance…") when gh knows several hosts', async () => {
    const invoke = installApi((channel) => {
      if (channel === 'github:enumerate-hosts') return TWO_HOSTS
      if (channel === 'github:host-picked') return { ok: true }
      return { found: false }
    })

    render(<TestWrapper><GitAuth id="git" /></TestWrapper>)

    const select = await screen.findByLabelText('GitHub host:')
    expect(screen.getByRole('option', { name: 'ghes.corp' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Other instance/ })).toBeNull()

    await waitFor(() => expect(select).not.toBeDisabled())
    fireEvent.change(select, { target: { value: 'ghes.corp' } })

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('github:host-picked', { host: 'ghes.corp' })
      expect(invoke).toHaveBeenCalledWith('github:cli-credentials', { host: 'ghes.corp' })
    })
    // OAuth isn't set up for ghes.corp (no client ID): the tab is disabled
    // with the reason, and the PAT form takes over.
    await screen.findByText(/isn't set up for ghes\.corp/)
    expect(screen.getByRole('button', { name: /Sign in with GitHub/ })).toBeDisabled()
    expect(screen.getByPlaceholderText(/github_pat_/)).toBeInTheDocument()
  })

  it('names the enterprise host on the success card', async () => {
    installApi((channel) => {
      if (channel === 'github:cli-credentials') {
        return { found: true, valid: true, user: { login: 'mona' }, host: 'ghes.corp' }
      }
      return { found: false }
    })

    render(<TestWrapper><GitHubAuth id="gh" host="ghes.corp" /></TestWrapper>)

    await screen.findByText(/Authenticated to GitHub \(ghes\.corp\)/)
  })
})

describe('GitAuth (GitHub) — authored host', () => {
  it('pins the host: no picker, PAT link follows the GHES host', async () => {
    const invoke = installApi(() => ({ found: false }))

    render(<TestWrapper><GitHubAuth id="gh" host="https://ghes.corp/" defaultTab="pat" detectCredentials={false} /></TestWrapper>)

    expect(screen.queryByRole('combobox')).toBeNull()
    fireEvent.click(screen.getByText('How do I create a token?'))
    expect(screen.getByRole('link', { name: /ghes\.corp\/settings\/tokens\/new/ })).toHaveAttribute(
      'href',
      'https://ghes.corp/settings/tokens/new',
    )
    expect(invoke).not.toHaveBeenCalledWith('github:enumerate-hosts', expect.anything())
  })

  it('keeps the OAuth tab for an enterprise host with a client ID from the map', async () => {
    installApi(() => ({ found: false }))

    render(
      <TestWrapper>
        <GitHubAuth id="gh" host="acme.ghe.com" oauthClientId={{ 'acme.ghe.com': 'Iv1.acme' }} detectCredentials={false} />
      </TestWrapper>,
    )

    for (const button of screen.getAllByRole('button', { name: /Sign in with GitHub/ })) {
      expect(button).not.toBeDisabled()
    }
    expect(screen.getByText(/redirected to authorize/i)).toBeInTheDocument()
    // No "custom OAuth app — use the default instead?" prompt on an enterprise host.
    expect(screen.queryByText('Custom OAuth App')).toBeNull()
  })

  it('reports an unparseable host as a configuration error and sends nothing', async () => {
    const invoke = installApi(() => ({ found: false }))

    render(<TestWrapper><GitHubAuth id="gh" host="ftp://ghes.corp" /></TestWrapper>)

    expect(screen.getByText(/invalid 'host' prop/)).toBeInTheDocument()
    expect(invoke.mock.calls.some((c) => (c[0] as string).startsWith('github:'))).toBe(false)
  })
})
