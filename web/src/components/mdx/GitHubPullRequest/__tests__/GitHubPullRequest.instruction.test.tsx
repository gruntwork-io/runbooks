import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TestWrapper } from '@/test/test-utils'
import GitHubPullRequest from '../GitHubPullRequest'

vi.mock('@/contexts/useInstructionMode', () => ({
  useInstructionMode: () => ({ enabled: true, setEnabled: vi.fn() }),
}))

const usePRSpy = vi.fn(() => ({ status: 'ready', logs: [] }))
vi.mock('@/components/mdx/GitPullRequest/hooks/useGitPullRequest', () => ({
  useGitPullRequest: () => usePRSpy(),
}))

describe('GitHubPullRequest — instruction mode', () => {
  it('renders a copyable gh pr create command and never opens a PR', () => {
    render(
      <TestWrapper>
        <GitHubPullRequest
          id="pr"
          prefilledPullRequestTitle="Add VPC"
          prefilledPullRequestDescription="Creates a VPC"
          prefilledPullRequestLabels={['infra']}
        />
      </TestWrapper>,
    )
    expect(screen.getByText('Open a pull request:')).toBeInTheDocument()
    const code = screen.getByText(/gh pr create/)
    expect(code.textContent).toContain("--title 'Add VPC'")
    expect(code.textContent).toContain("--label 'infra'")
    expect(screen.queryByRole('button', { name: /create pull request/i })).toBeNull()
    expect(usePRSpy).not.toHaveBeenCalled()
  })
})
