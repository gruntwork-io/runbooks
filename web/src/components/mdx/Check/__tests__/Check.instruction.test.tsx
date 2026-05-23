import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TestWrapper } from '@/test/test-utils'
import Check from '../Check'

const baseExecution = {
  sourceCode: '',
  rawScriptContent: 'test -f /etc/hosts',
  language: 'bash',
  fileError: null,
  inputValues: {},
  inputDependencies: [] as string[],
  unmetInputDependencies: [],
  hasAllInputDependencies: true,
  inlineInputsId: null,
  outputDependencies: [],
  unmetOutputDependencies: [],
  hasAllOutputDependencies: true,
  templateContext: { inputs: {}, outputs: {} },
  unmetAwsAuthDependency: null,
  hasAwsAuthDependency: true,
  unmetGitHubAuthDependency: null,
  hasGitHubAuthDependency: true,
  isRendering: false,
  renderError: null,
  status: 'pending' as string,
  logs: [],
  execError: null,
  execute: vi.fn(),
  cancel: vi.fn(),
  outputs: null,
  hasScriptDrift: false,
}

let mockExecution = { ...baseExecution }
vi.mock('@/components/mdx/_shared/hooks/useScriptExecution', () => ({
  useScriptExecution: () => mockExecution,
}))

vi.mock('@/contexts/useLogs', () => ({
  useLogs: () => ({ registerLogs: vi.fn() }),
}))

let mockEnabled = true
vi.mock('@/contexts/useInstructionMode', () => ({
  useInstructionMode: () => ({ enabled: mockEnabled, setEnabled: vi.fn() }),
}))

function renderCheck(props: Partial<React.ComponentProps<typeof Check>> = {}) {
  return render(
    <TestWrapper>
      <Check id="test-check" title="Verify hosts file" command="test -f /etc/hosts" {...props} />
    </TestWrapper>,
  )
}

describe('Check — instruction mode', () => {
  beforeEach(() => {
    mockExecution = { ...baseExecution }
    mockEnabled = true
  })

  it('renders a copyable command and no Check button when the flag is on', () => {
    renderCheck()
    expect(screen.getByText('test -f /etc/hosts')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^check$/i })).toBeNull()
  })

  it('renders the interactive Check button when the flag is off', () => {
    mockEnabled = false
    renderCheck()
    expect(screen.getByRole('button', { name: /^check$/i })).toBeInTheDocument()
  })
})
