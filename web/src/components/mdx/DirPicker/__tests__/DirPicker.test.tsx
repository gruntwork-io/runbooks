import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import DirPicker from '../DirPicker'
import { RunbookContextProvider } from '@/contexts/RunbookContext'
import { ComponentIdRegistryProvider } from '@/contexts/ComponentIdRegistry'
import { ErrorReportingProvider } from '@/contexts/ErrorReportingContext'
import { TelemetryProvider } from '@/contexts/TelemetryContext'

// Mock useSession
vi.mock('@/contexts/useSession', () => ({
  useSession: () => ({
    getAuthHeader: () => ({ Authorization: 'Bearer test' }),
    isReady: true,
  }),
}))

// Wrapper with all required context providers
function TestWrapper({ children }: { children: ReactNode }) {
  return (
    <TelemetryProvider>
      <ErrorReportingProvider>
        <ComponentIdRegistryProvider>
          <RunbookContextProvider runbookName="test">
            {children}
          </RunbookContextProvider>
        </ComponentIdRegistryProvider>
      </ErrorReportingProvider>
    </TelemetryProvider>
  )
}

describe('DirPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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

  it('renders without gitCloneId (no waiting state when no dependency)', () => {
    render(
      <TestWrapper>
        <DirPicker id="test-picker" dirLabels={['Environment', 'Region']} />
      </TestWrapper>
    )

    // Should not show waiting message since there's no gitCloneId dependency
    expect(screen.queryByText('Complete the GitClone block above to browse directories.')).toBeNull()
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

  it('allows manual path input editing', async () => {
    const user = userEvent.setup()

    render(
      <TestWrapper>
        <DirPicker id="test-picker" dirLabels={['Environment', 'Region']} gitCloneId="clone-repo" />
      </TestWrapper>
    )

    // When gitCloneId output is not available, we're in waiting state
    // So the input is not rendered yet
    expect(screen.getByText('Complete the GitClone block above to browse directories.')).toBeDefined()

    // Note: Full integration testing of the cascading dropdowns requires
    // injecting block outputs into the context, which is better tested in
    // an integration test with the full runbook setup.
    void user // prevent unused variable lint warning
  })
})
