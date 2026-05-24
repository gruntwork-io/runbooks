import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TestWrapper } from '@/test/test-utils'
import GitClone from '../GitClone'

vi.mock('@/contexts/useInstructionMode', () => ({
  useInstructionMode: () => ({ enabled: true, setEnabled: vi.fn() }),
}))

const useGitCloneSpy = vi.fn(() => ({ cloneStatus: 'ready', logs: [] }))
vi.mock('../hooks/useGitClone', () => ({
  useGitClone: () => useGitCloneSpy(),
}))

describe('GitClone — instruction mode', () => {
  it('renders a copyable git clone command and never clones', () => {
    render(
      <TestWrapper>
        <GitClone id="clone" prefilledUrl="https://github.com/org/repo.git" prefilledRef="main" />
      </TestWrapper>,
    )
    expect(screen.getByText(/Clone this repository/i)).toBeInTheDocument()
    expect(
      screen.getByText("git clone --branch 'main' 'https://github.com/org/repo.git'"),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^clone$/i })).toBeNull()
    expect(useGitCloneSpy).not.toHaveBeenCalled()
  })

  it('shows a sparse-checkout note when a repo sub-path is set', () => {
    render(
      <TestWrapper>
        <GitClone id="clone" prefilledUrl="https://github.com/org/repo.git" prefilledRepoPath="modules/vpc" />
      </TestWrapper>,
    )
    expect(screen.getByText('modules/vpc')).toBeInTheDocument()
    expect(screen.getByText(/sparse checkout/i)).toBeInTheDocument()
  })
})
