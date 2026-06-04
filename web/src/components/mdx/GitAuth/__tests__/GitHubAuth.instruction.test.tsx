import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TestWrapper } from '@/test/test-utils'
import { GitHubAuth } from '../../GitHubAuth'

vi.mock('@/contexts/useInstructionMode', () => ({
  useInstructionMode: () => ({ enabled: true, setEnabled: vi.fn() }),
}))

const useGitAuthSpy = vi.fn(() => ({ authStatus: 'pending' }))
vi.mock('../hooks/useGitAuth', () => ({
  useGitAuth: () => useGitAuthSpy(),
}))

describe('GitHubAuth — instruction mode', () => {
  it('renders a plain "Log into GitHub" instruction noting the declared scopes', () => {
    render(
      <TestWrapper>
        <GitHubAuth id="gh" oauthScopes={['repo', 'workflow']} />
      </TestWrapper>,
    )
    expect(screen.getByText('Log into GitHub')).toBeInTheDocument()
    expect(screen.getByText('repo')).toBeInTheDocument()
    expect(screen.getByText('workflow')).toBeInTheDocument()
    // The GitHub instruction note has no CLI command (byte-identical to the
    // legacy block) — only GitLab appends a `glab auth login` hint.
    expect(screen.queryByText('gh auth login')).toBeNull()
  })

  it('shows no auth capture UI and never calls useGitAuth', () => {
    render(
      <TestWrapper>
        <GitHubAuth id="gh" />
      </TestWrapper>,
    )
    expect(screen.getByText('Log into GitHub')).toBeInTheDocument()
    // Default scope is repo.
    expect(screen.getByText('repo')).toBeInTheDocument()
    expect(useGitAuthSpy).not.toHaveBeenCalled()
  })
})
