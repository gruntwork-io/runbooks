import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TestWrapper } from '@/test/test-utils'
import { GitAuth } from '../GitAuth'

vi.mock('@/contexts/useInstructionMode', () => ({
  useInstructionMode: () => ({ enabled: true, setEnabled: vi.fn() }),
}))

const useGitAuthSpy = vi.fn(() => ({ authStatus: 'pending' }))
vi.mock('../hooks/useGitAuth', () => ({
  useGitAuth: () => useGitAuthSpy(),
}))

describe('GitAuth — instruction mode', () => {
  it('renders "Log into GitLab" with scopes and a glab auth login hint', () => {
    render(
      <TestWrapper>
        <GitAuth id="git" provider="gitlab" />
      </TestWrapper>,
    )
    expect(screen.getByText('Log into GitLab')).toBeInTheDocument()
    // Default GitLab instruction scopes.
    expect(screen.getByText('read_repository')).toBeInTheDocument()
    expect(screen.getByText('write_repository')).toBeInTheDocument()
    expect(screen.getByText('glab auth login')).toBeInTheDocument()
    // The interactive hook never runs in instruction mode.
    expect(useGitAuthSpy).not.toHaveBeenCalled()
  })

  it('renders "Log into GitHub" with no CLI hint for the GitHub provider', () => {
    render(
      <TestWrapper>
        <GitAuth id="git" provider="github" oauthScopes={['repo', 'workflow']} />
      </TestWrapper>,
    )
    expect(screen.getByText('Log into GitHub')).toBeInTheDocument()
    expect(screen.getByText('repo')).toBeInTheDocument()
    expect(screen.getByText('workflow')).toBeInTheDocument()
    expect(screen.queryByText('gh auth login')).toBeNull()
  })
})
