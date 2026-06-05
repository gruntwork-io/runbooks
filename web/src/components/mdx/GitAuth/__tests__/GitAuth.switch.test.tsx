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
