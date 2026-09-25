import { describe, it, expect, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { ApiProvider, type RunbooksAPI } from './ApiContext'
import { IpcExecutableRegistryProvider } from './IpcExecutableRegistryContext'
import { useExecutableRegistry } from '@/hooks/useExecutableRegistry'
import type { Executable } from '@/types/executable'

function executable(id: string, componentId: string): Executable {
  return { id, type: 'inline', componentId, componentType: 'command', contentHash: `hash-${id}` }
}

// Mock boundary: the preload API. `registry` is what runbook:executables
// currently returns; `rebuild()` fires the main process's registry:updated.
function createRegistryApi(initial: Record<string, Executable>) {
  let registry = initial
  const listeners = new Set<() => void>()
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'runbook:executables') return { executables: registry, warnings: [] }
    throw new Error(`unexpected channel: ${channel}`)
  })
  const on = vi.fn((channel: string, callback: () => void) => {
    if (channel === 'registry:updated') listeners.add(callback)
    return () => {
      listeners.delete(callback)
    }
  })
  const api = { invoke, on, once: vi.fn() } as unknown as RunbooksAPI
  return {
    api,
    invoke,
    rebuild(next: Record<string, Executable>) {
      registry = next
      listeners.forEach((cb) => cb())
    },
  }
}

function renderRegistry(api: RunbooksAPI) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ApiProvider api={api}>
      <IpcExecutableRegistryProvider>{children}</IpcExecutableRegistryProvider>
    </ApiProvider>
  )
  return renderHook(() => useExecutableRegistry(), { wrapper })
}

describe('IpcExecutableRegistryProvider', () => {
  it('loads the registry on mount without probing runbook:get', async () => {
    const registryApi = createRegistryApi({ e1: executable('e1', 'greet') })
    const { result } = renderRegistry(registryApi.api)

    await waitFor(() => expect(result.current.getExecutableByComponentId('greet')?.id).toBe('e1'))
    expect(registryApi.invoke.mock.calls.map(([channel]) => channel)).toEqual(['runbook:executables'])
  })

  it('re-fetches when the main process rebuilds the registry', async () => {
    const registryApi = createRegistryApi({ e1: executable('e1', 'greet') })
    const { result } = renderRegistry(registryApi.api)
    await waitFor(() => expect(result.current.getExecutableByComponentId('greet')?.id).toBe('e1'))

    act(() => registryApi.rebuild({ e2: executable('e2', 'greet') }))

    await waitFor(() => expect(result.current.getExecutableByComponentId('greet')?.id).toBe('e2'))
    expect(result.current.getExecutableByComponentId('missing')).toBeNull()
  })
})
