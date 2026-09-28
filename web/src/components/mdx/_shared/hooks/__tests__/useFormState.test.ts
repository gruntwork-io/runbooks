import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useFormState } from '../useFormState'
import type { BoilerplateConfig } from '@/types/boilerplateConfig'

const config: BoilerplateConfig = {
  variables: [{ name: 'A', type: 'string', description: '', default: 'x' }],
}

function setup(initialConfig: BoilerplateConfig | null, enableAutoRender = true) {
  const onAutoRender = vi.fn()
  const hook = renderHook(
    ({ cfg }: { cfg: BoilerplateConfig | null }) =>
      useFormState(cfg, {}, undefined, onAutoRender, enableAutoRender),
    { initialProps: { cfg: initialConfig } },
  )
  return { onAutoRender, ...hook }
}

describe('useFormState auto-render', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // Start well past the debounce window so the first fire is a leading edge.
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires exactly once with the initial values when the config arrives', () => {
    const { onAutoRender, rerender } = setup(null)
    expect(onAutoRender).not.toHaveBeenCalled()

    rerender({ cfg: config })
    act(() => { vi.advanceTimersByTime(500) })

    expect(onAutoRender).toHaveBeenCalledTimes(1)
    expect(onAutoRender).toHaveBeenCalledWith({ A: 'x' })
  })

  it('fires exactly once per isolated change', () => {
    const { onAutoRender, result } = setup(config)
    act(() => { vi.advanceTimersByTime(500) })
    onAutoRender.mockClear()

    act(() => { result.current.updateField('A', 'y') })
    act(() => { vi.advanceTimersByTime(500) })
    expect(onAutoRender).toHaveBeenCalledTimes(1)
    expect(onAutoRender).toHaveBeenLastCalledWith({ A: 'y' })

    act(() => { result.current.updateField('A', 'z') })
    act(() => { vi.advanceTimersByTime(500) })
    expect(onAutoRender).toHaveBeenCalledTimes(2)
    expect(onAutoRender).toHaveBeenLastCalledWith({ A: 'z' })
  })

  it('fires leading and trailing for a burst inside the debounce window', () => {
    const { onAutoRender, result } = setup(config)
    act(() => { vi.advanceTimersByTime(500) })
    onAutoRender.mockClear()

    act(() => { result.current.updateField('A', 'y1') })
    act(() => { vi.advanceTimersByTime(10) })
    act(() => { result.current.updateField('A', 'y12') })
    act(() => { vi.advanceTimersByTime(10) })
    act(() => { result.current.updateField('A', 'y123') })
    act(() => { vi.advanceTimersByTime(500) })

    expect(onAutoRender.mock.calls.map(([data]) => data)).toEqual([
      { A: 'y1' },
      { A: 'y123' },
    ])
  })

  it('never fires when auto-render is disabled', () => {
    const { onAutoRender, result } = setup(config, false)
    act(() => { result.current.updateField('A', 'y') })
    act(() => { vi.advanceTimersByTime(500) })
    expect(onAutoRender).not.toHaveBeenCalled()
  })
})
