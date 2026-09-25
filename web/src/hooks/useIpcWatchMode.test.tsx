import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { ApiProvider, type RunbooksAPI } from '@/contexts/ApiContext'
import { useIpcWatchMode } from './useIpcWatchMode'

// Mock boundary: the preload API. Tracks live watch:file-change listeners so
// tests can fire the event and count subscriptions.
function createWatchApi() {
  const listeners = new Set<(...args: unknown[]) => void>()
  const on = vi.fn((channel: string, callback: (...args: unknown[]) => void) => {
    if (channel === 'watch:file-change') listeners.add(callback)
    return () => {
      listeners.delete(callback)
    }
  })
  const api = { invoke: vi.fn(), on, once: vi.fn() } as unknown as RunbooksAPI
  return {
    api,
    on,
    listeners,
    fileChanged: () => listeners.forEach((cb) => cb({ type: 'reload' })),
  }
}

function renderWatchHook(api: RunbooksAPI, initial: { onFileChange: () => void; isWatchMode: boolean }) {
  const wrapper = ({ children }: { children: ReactNode }) => <ApiProvider api={api}>{children}</ApiProvider>
  return renderHook(
    ({ onFileChange, isWatchMode }) => useIpcWatchMode(onFileChange, isWatchMode),
    { wrapper, initialProps: initial },
  )
}

describe('useIpcWatchMode', () => {
  it('does not listen when watch mode is off', () => {
    const watch = createWatchApi()
    renderWatchHook(watch.api, { onFileChange: vi.fn(), isWatchMode: false })

    expect(watch.on).not.toHaveBeenCalled()
  })

  it('subscribes once across re-renders with a new callback and calls the latest one', () => {
    const watch = createWatchApi()
    const first = vi.fn()
    const { rerender } = renderWatchHook(watch.api, { onFileChange: first, isWatchMode: true })

    // A parent that passes a fresh callback identity on every render.
    const latest = vi.fn()
    rerender({ onFileChange: vi.fn(), isWatchMode: true })
    rerender({ onFileChange: latest, isWatchMode: true })

    expect(watch.on).toHaveBeenCalledTimes(1)
    expect(watch.listeners.size).toBe(1)

    watch.fileChanged()
    expect(latest).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })

  it('unsubscribes when watch mode turns off and on unmount', () => {
    const watch = createWatchApi()
    const { rerender, unmount } = renderWatchHook(watch.api, { onFileChange: vi.fn(), isWatchMode: true })
    expect(watch.listeners.size).toBe(1)

    rerender({ onFileChange: vi.fn(), isWatchMode: false })
    expect(watch.listeners.size).toBe(0)

    rerender({ onFileChange: vi.fn(), isWatchMode: true })
    expect(watch.listeners.size).toBe(1)

    unmount()
    expect(watch.listeners.size).toBe(0)
  })
})
