import { describe, it, expect, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { TestWrapper } from '@/test/test-utils'
import { useRunbookContext, flattenInputs } from '@/contexts/useRunbook'
import type { RunbookContextType } from '@/contexts/RunbookContext'
import type { BoilerplateConfig } from '@/types/boilerplateConfig'
import Template from '../Template'

vi.mock('@/contexts/useInstructionMode', () => ({
  useInstructionMode: () => ({ enabled: true, setEnabled: vi.fn() }),
}))

// Config drives the form; resolves immediately so the invocation renders.
// Stable across renders, like the real hook's state.
const configReturn = vi.hoisted(() => ({
  data: {
    variables: [
      { name: 'region', type: 'string', default: 'us-east-1' },
    ],
    outputDependencies: [],
  },
  isLoading: false,
  error: null,
}))
vi.mock('@/hooks/useApiGetBoilerplateConfig', () => ({
  useApiGetBoilerplateConfig: () => configReturn,
}))

// If the interactive path were taken this would run a render-to-disk; assert it
// is never called in instruction mode.
const renderSpy = vi.fn(() => ({ data: null, isLoading: false, error: null, isAutoRendering: false, autoRender: vi.fn() }))
vi.mock('@/hooks/useApiBoilerplateRender', () => ({
  useApiBoilerplateRender: () => renderSpy(),
}))

// Captures the live RunbookContext so the test can play the part of an upstream <Inputs> block.
let ctx: RunbookContextType
function CaptureContext() {
  ctx = useRunbookContext()
  return null
}

const upstreamConfig: BoilerplateConfig = {
  variables: [{ name: 'region', type: 'string', description: '' }],
}

describe('Template — instruction mode', () => {
  it('keeps the variable form and shows a boilerplate invocation, no Generate button', () => {
    render(
      <TestWrapper>
        <Template id="vpc" path="templates/vpc" />
      </TestWrapper>,
    )
    expect(screen.getByText(/Generate files with boilerplate/i)).toBeInTheDocument()
    const code = screen.getByText(/boilerplate --template-url/)
    expect(code.textContent).toContain("--template-url 'templates/vpc'")
    expect(code.textContent).toContain("--var 'region=us-east-1'")
    expect(screen.queryByRole('button', { name: /generate/i })).toBeNull()
    expect(renderSpy).not.toHaveBeenCalled()
  })

  it('live-syncs an imported shared var into the command, the form and context', () => {
    const { container } = render(
      <TestWrapper>
        <CaptureContext />
        <Template id="vpc" path="templates/vpc" inputsId="cfg" />
      </TestWrapper>,
    )

    // The upstream Inputs value changes after the Template form has mounted.
    act(() => { ctx.registerInputs('cfg', { region: 'eu-west-1' }, upstreamConfig) })
    act(() => { ctx.registerInputs('cfg', { region: 'ap-south-1' }, upstreamConfig) })

    const code = screen.getByText(/boilerplate --template-url/)
    expect(code.textContent).toContain("--var 'region=ap-south-1'")
    const field = container.querySelector('#vpc-region') as HTMLInputElement
    expect(field.value).toBe('ap-south-1')
    expect(field).toBeDisabled()
    expect(flattenInputs(ctx.getInputs('vpc')).region).toBe('ap-south-1')
    expect(renderSpy).not.toHaveBeenCalled()
  })
})
