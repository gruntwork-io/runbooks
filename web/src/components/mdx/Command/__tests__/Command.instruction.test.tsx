import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { TestWrapper } from '@/test/test-utils'
import Command from '../Command'

// Control the shared execution hook so we drive rawScriptContent + context.
const baseExecution = {
  sourceCode: '',
  rawScriptContent: 'echo hello',
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

function renderCommand(props: Partial<React.ComponentProps<typeof Command>> = {}) {
  return render(
    <TestWrapper>
      <Command id="test-cmd" command="echo hello" {...props} />
    </TestWrapper>,
  )
}

describe('Command — instruction mode', () => {
  beforeEach(() => {
    mockExecution = { ...baseExecution }
    mockEnabled = true
  })

  it('renders a copyable command and no Run button when the flag is on', () => {
    mockExecution.rawScriptContent = 'echo hello'
    renderCommand()
    expect(screen.getByText('echo hello')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^run$/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /stop/i })).toBeNull()
  })

  it('resolves input references from the form context', () => {
    mockExecution.rawScriptContent = 'echo {{ .inputs.name }}'
    mockExecution.templateContext = { inputs: { name: 'world' }, outputs: {} }
    renderCommand({ command: 'echo {{ .inputs.name }}' })
    expect(screen.getByText('echo world')).toBeInTheDocument()
    expect(screen.queryByText(/\{\{/)).toBeNull()
  })

  it('auto-detects an output reference as a manual field and resolves once filled', async () => {
    mockExecution.rawScriptContent = 'echo {{ .outputs.create_account.account_id }}'
    renderCommand({ command: 'echo {{ .outputs.create_account.account_id }}' })

    const field = screen.getByPlaceholderText(/paste the account_id value/i)
    expect(field).toBeInTheDocument()
    expect(screen.queryByText(/\{\{/)).toBeNull()

    fireEvent.change(field, { target: { value: '123456789012' } })
    await waitFor(() =>
      expect(screen.getByText('echo 123456789012')).toBeInTheDocument(),
    )
  })

  it('renders the interactive Run button when the flag is off', () => {
    mockEnabled = false
    renderCommand()
    expect(screen.getByRole('button', { name: /^run$/i })).toBeInTheDocument()
  })
})
