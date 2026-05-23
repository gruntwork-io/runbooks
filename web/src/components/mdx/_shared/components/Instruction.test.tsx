import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Instruction } from './Instruction'
import type { TemplateContext } from '@/lib/templateUtils'

function renderInstruction(ui: React.ReactNode) {
  return render(<TooltipProvider>{ui}</TooltipProvider>)
}

describe('Instruction', () => {
  it('renders the title, description, and a copyable command', () => {
    renderInstruction(
      <Instruction
        title="Run this:"
        description="Lists the bucket"
        command="aws s3 ls"
      />,
    )
    expect(screen.getByText('Run this:')).toBeInTheDocument()
    expect(screen.getByText('Lists the bucket')).toBeInTheDocument()
    expect(screen.getByText('aws s3 ls')).toBeInTheDocument()
    // Instruction mode shows no Run button.
    expect(screen.queryByRole('button', { name: /run/i })).toBeNull()
  })

  it('resolves {{ .inputs.* }} from the provided template context', () => {
    const ctx: TemplateContext = { inputs: { bucket: 'my-bucket' }, outputs: {} }
    renderInstruction(
      <Instruction
        title="Run this:"
        command="aws s3 ls s3://{{ .inputs.bucket }}"
        templateContext={ctx}
      />,
    )
    expect(screen.getByText('aws s3 ls s3://my-bucket')).toBeInTheDocument()
  })

  it('surfaces a manual field for an output reference and resolves once filled', async () => {
    renderInstruction(
      <Instruction
        title="Run this:"
        command="echo {{ .outputs.create_account.account_id }}"
      />,
    )
    // A manual field is auto-detected for the output reference.
    const field = screen.getByPlaceholderText(/paste the account_id value/i)
    expect(field).toBeInTheDocument()
    // Until filled, the command shows a <placeholder> — never a raw {{ }}.
    expect(screen.getByText('echo <account_id>')).toBeInTheDocument()
    expect(screen.queryByText(/\{\{/)).toBeNull()

    fireEvent.change(field, { target: { value: '123456789012' } })
    await waitFor(() =>
      expect(screen.getByText('echo 123456789012')).toBeInTheDocument(),
    )
  })

  it('marks a block done via the checkbox, greens it, and persists', () => {
    localStorage.clear()
    const { unmount } = renderInstruction(
      <Instruction id="step-1" title="Run this:" command="echo hi" />,
    )
    const block = screen.getByTestId('instruction-step-1')
    expect(block.getAttribute('data-completed')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /mark step as done/i }))
    expect(block.getAttribute('data-completed')).toBe('true')
    expect(block.className).toContain('bg-success-muted')

    // Persisted: a fresh render restores the done state.
    unmount()
    renderInstruction(<Instruction id="step-1" title="Run this:" command="echo hi" />)
    expect(
      screen.getByTestId('instruction-step-1').getAttribute('data-completed'),
    ).toBe('true')
    localStorage.clear()
  })

  it('renders a source viewer for file-backed scripts', () => {
    renderInstruction(
      <Instruction
        title="Run this script:"
        source={{ content: '#!/bin/bash\necho hi', path: 'scripts/x.sh', language: 'bash' }}
      />,
    )
    expect(screen.getByText('View Source Code')).toBeInTheDocument()
  })
})
