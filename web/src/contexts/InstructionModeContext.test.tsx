import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { InstructionModeProvider } from './InstructionModeContext'
import { useInstructionMode } from './useInstructionMode'
import { INSTRUCTION_MODE_STORAGE_KEY } from './InstructionModeContext.types'

function wrapper({ children }: { children: ReactNode }) {
  return <InstructionModeProvider>{children}</InstructionModeProvider>
}

describe('InstructionModeContext', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('defaults to disabled', () => {
    const { result } = renderHook(() => useInstructionMode(), { wrapper })
    expect(result.current.enabled).toBe(false)
  })

  it('reads a stored "true" preference', () => {
    localStorage.setItem(INSTRUCTION_MODE_STORAGE_KEY, 'true')
    const { result } = renderHook(() => useInstructionMode(), { wrapper })
    expect(result.current.enabled).toBe(true)
  })

  it('treats any non-"true" stored value as disabled', () => {
    localStorage.setItem(INSTRUCTION_MODE_STORAGE_KEY, 'yes')
    const { result } = renderHook(() => useInstructionMode(), { wrapper })
    expect(result.current.enabled).toBe(false)
  })

  it('setEnabled persists to localStorage and flips state', () => {
    const { result } = renderHook(() => useInstructionMode(), { wrapper })

    act(() => result.current.setEnabled(true))
    expect(result.current.enabled).toBe(true)
    expect(localStorage.getItem(INSTRUCTION_MODE_STORAGE_KEY)).toBe('true')

    act(() => result.current.setEnabled(false))
    expect(result.current.enabled).toBe(false)
    expect(localStorage.getItem(INSTRUCTION_MODE_STORAGE_KEY)).toBe('false')
  })

  it('useInstructionMode throws when used outside a provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => renderHook(() => useInstructionMode())).toThrow(
      'useInstructionMode must be used within an InstructionModeProvider',
    )
    spy.mockRestore()
  })
})
