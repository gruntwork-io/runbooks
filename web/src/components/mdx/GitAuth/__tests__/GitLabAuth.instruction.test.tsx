import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TestWrapper } from '@/test/test-utils'
import { GitLabAuth } from '../../GitLabAuth'

vi.mock('@/contexts/useInstructionMode', () => ({
  useInstructionMode: () => ({ enabled: true, setEnabled: vi.fn() }),
}))

const useGitAuthSpy = vi.fn(() => ({ authStatus: 'pending' }))
vi.mock('../hooks/useGitAuth', () => ({
  useGitAuth: () => useGitAuthSpy(),
}))

describe('GitLabAuth — instruction mode', () => {
  it('renders a plain "Log into GitLab" instruction with the default GitLab scopes and a glab auth login hint', () => {
    render(
      <TestWrapper>
        <GitLabAuth id="gl" />
      </TestWrapper>,
    )
    expect(screen.getByText('Log into GitLab')).toBeInTheDocument()
    expect(screen.getByText('read_repository')).toBeInTheDocument()
    expect(screen.getByText('write_repository')).toBeInTheDocument()
    expect(screen.getByText('glab auth login')).toBeInTheDocument()
    // The interactive hook never runs in instruction mode.
    expect(useGitAuthSpy).not.toHaveBeenCalled()
  })

  it('honors custom oauthScopes for the instruction note', () => {
    render(
      <TestWrapper>
        <GitLabAuth id="gl" oauthScopes={['api']} />
      </TestWrapper>,
    )
    expect(screen.getByText('Log into GitLab')).toBeInTheDocument()
    expect(screen.getByText('api')).toBeInTheDocument()
  })
})
