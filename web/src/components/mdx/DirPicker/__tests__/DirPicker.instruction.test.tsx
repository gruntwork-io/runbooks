import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TestWrapper } from '@/test/test-utils'
import DirPicker from '../DirPicker'

vi.mock('@/contexts/useInstructionMode', () => ({
  useInstructionMode: () => ({ enabled: true, setEnabled: vi.fn() }),
}))

const useDirPickerSpy = vi.fn(() => ({ levels: [], manualPath: '', isWorkspaceReady: false }))
vi.mock('../hooks/useDirPicker', () => ({
  useDirPicker: () => useDirPickerSpy(),
}))

describe('DirPicker — instruction mode', () => {
  it('renders an instruction with a path field and never browses the filesystem', () => {
    render(
      <TestWrapper>
        <DirPicker id="dir" rootDir="/repo" title="Pick a directory" pathLabel="Target Path" />
      </TestWrapper>,
    )
    expect(screen.getByText('Pick a directory')).toBeInTheDocument()
    const input = screen.getByPlaceholderText(/production\/us-east-1/i)
    expect(input).toBeInTheDocument()
    fireEvent.change(input, { target: { value: 'prod/us-east-1' } })
    expect((input as HTMLInputElement).value).toBe('prod/us-east-1')
    expect(useDirPickerSpy).not.toHaveBeenCalled()
  })
})
