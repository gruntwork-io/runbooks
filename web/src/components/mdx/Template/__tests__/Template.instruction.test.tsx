import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TestWrapper } from '@/test/test-utils'
import Template from '../Template'

vi.mock('@/contexts/useInstructionMode', () => ({
  useInstructionMode: () => ({ enabled: true, setEnabled: vi.fn() }),
}))

// Config drives the form; resolves immediately so the invocation renders.
vi.mock('@/hooks/useApiGetBoilerplateConfig', () => ({
  useApiGetBoilerplateConfig: () => ({
    data: {
      variables: [
        { name: 'region', type: 'string', default: 'us-east-1' },
      ],
      outputDependencies: [],
    },
    isLoading: false,
    error: null,
  }),
}))

// If the interactive path were taken this would run a render-to-disk; assert it
// is never called in instruction mode.
const renderSpy = vi.fn(() => ({ data: null, isLoading: false, error: null, isAutoRendering: false, autoRender: vi.fn() }))
vi.mock('@/hooks/useApiBoilerplateRender', () => ({
  useApiBoilerplateRender: () => renderSpy(),
}))

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
})
