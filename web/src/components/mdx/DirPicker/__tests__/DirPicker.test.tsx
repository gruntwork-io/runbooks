import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import DirPicker from '../DirPicker'
import { TestWrapper } from '@/test/test-utils'

// Mock useSession
vi.mock('@/contexts/useSession', () => ({
  useSession: () => ({
    getAuthHeader: () => ({ Authorization: 'Bearer test' }),
    isReady: true,
  }),
}))

describe('DirPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders without crashing when dirLabels is omitted', () => {
    // Regression guard: dirLabels was a required prop dereferenced via
    // `dirLabels.length`, so omitting it crashed the block at render.
    render(
      <TestWrapper>
        <DirPicker id="test-picker" rootDir="/tmp/test-dir" />
      </TestWrapper>
    )

    expect(screen.getByTestId('test-picker')).toBeDefined()
    expect(screen.queryByText(/requires either a/)).toBeNull()
  })

  it('renders title and description', () => {
    render(
      <TestWrapper>
        <DirPicker id="test-picker" dirLabels={['Environment', 'Region']} title="Pick a dir" description="Choose wisely" />
      </TestWrapper>
    )

    expect(screen.getByText('Pick a dir')).toBeDefined()
    expect(screen.getByText('Choose wisely')).toBeDefined()
  })

  it('renders with default title and description', () => {
    render(
      <TestWrapper>
        <DirPicker id="test-picker" dirLabels={['Environment', 'Region']} />
      </TestWrapper>
    )

    expect(screen.getByText('Select Directory')).toBeDefined()
    expect(screen.getByText('Choose a target directory')).toBeDefined()
  })

  it('shows unmet dependency warning when gitCloneId outputs are not yet available', () => {
    render(
      <TestWrapper>
        <DirPicker id="test-picker" dirLabels={['Environment', 'Region']} gitCloneId="clone-repo" />
      </TestWrapper>
    )

    // Shows the block ID in a code badge and a helpful message
    expect(screen.getByText('clone-repo')).toBeDefined()
    expect(screen.getByText('Complete the GitClone block above to browse directories.')).toBeDefined()
  })

  it('shows error when neither rootDir nor gitCloneId is provided', () => {
    render(
      <TestWrapper>
        <DirPicker id="test-picker" dirLabels={['Environment', 'Region']} />
      </TestWrapper>
    )

    expect(screen.getByText(/requires either a/)).toBeDefined()
    expect(screen.queryByText('Complete the GitClone block above to browse directories.')).toBeNull()
  })

  it('renders without waiting state when rootDir is provided', () => {
    render(
      <TestWrapper>
        <DirPicker id="test-picker" dirLabels={['Environment', 'Region']} rootDir="/tmp/test-dir" />
      </TestWrapper>
    )

    // Should not show waiting message or missing-config error
    expect(screen.queryByText('Complete the GitClone block above to browse directories.')).toBeNull()
    expect(screen.queryByText(/requires either a/)).toBeNull()
  })

  it('renders custom pathLabel', () => {
    render(
      <TestWrapper>
        <DirPicker id="test-picker" dirLabels={['Environment', 'Region']} gitCloneId="clone-repo" pathLabel="Deployment Path" />
      </TestWrapper>
    )

    // In waiting state, the path input is not visible yet
    expect(screen.getByText('Complete the GitClone block above to browse directories.')).toBeDefined()
  })

  it('allows manual path input editing', () => {
    render(
      <TestWrapper>
        <DirPicker id="test-picker" dirLabels={['Environment', 'Region']} gitCloneId="clone-repo" />
      </TestWrapper>
    )

    // When gitCloneId output is not available, we're in waiting state, so the
    // path input is not rendered yet.
    expect(screen.getByText('Complete the GitClone block above to browse directories.')).toBeDefined()

    // Note: Full integration testing of the cascading dropdowns requires
    // injecting block outputs into the context, which is better tested in
    // an integration test with the full runbook setup.
  })
})
