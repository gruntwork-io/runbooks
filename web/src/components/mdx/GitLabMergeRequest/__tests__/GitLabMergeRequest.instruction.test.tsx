import { describe, it, expect, vi } from 'vitest'
import { useEffect } from 'react'
import { render, screen } from '@testing-library/react'
import { TestWrapper } from '@/test/test-utils'
import { useRunbookContext } from '@/contexts/useRunbook'

vi.mock('@/contexts/useInstructionMode', () => ({
  useInstructionMode: () => ({ enabled: true, setEnabled: vi.fn() }),
}))

import GitLabMergeRequest from '../GitLabMergeRequest'

function Seed({ id, values }: { id: string; values: Record<string, string> }) {
  const { registerOutputs } = useRunbookContext()
  useEffect(() => {
    registerOutputs(id, values)
  }, [id, values, registerOutputs])
  return null
}

describe('GitLabMergeRequest — instruction mode', () => {
  it('renders a copyable glab mr create command using --description (not --body)', () => {
    render(
      <TestWrapper>
        <GitLabMergeRequest
          id="mr"
          prefilledPullRequestTitle="Add VPC"
          prefilledPullRequestDescription="Creates a VPC"
          prefilledPullRequestLabels={['infra']}
        />
      </TestWrapper>,
    )
    expect(screen.getByText('Open a merge request:')).toBeInTheDocument()
    const code = screen.getByText(/glab mr create/)
    expect(code.textContent).toContain("--title 'Add VPC'")
    expect(code.textContent).toContain("--description 'Creates a VPC'")
    expect(code.textContent).not.toContain('--body')
    expect(code.textContent).toContain("--label 'infra'")
  })

  it('renders the wrong-provider error instead of a command when linked to a GitHub auth block', async () => {
    render(
      <TestWrapper>
        <Seed id="auth" values={{ GIT_PROVIDER: 'github', GITHUB_TOKEN: 'tok' }} />
        <GitLabMergeRequest id="mr" gitAuthId="auth" prefilledPullRequestTitle="Add VPC" />
      </TestWrapper>,
    )
    expect(await screen.findByText('Wrong authentication provider')).toBeInTheDocument()
    expect(screen.queryByText(/glab mr create/)).toBeNull()
  })
})
