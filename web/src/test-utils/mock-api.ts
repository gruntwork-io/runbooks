import type { RunbooksAPI } from '@/contexts/ApiContext'

/**
 * Channels with a sensible default response so tests that render inside
 * providers don't have to stub infrastructure they don't care about.
 */
const DEFAULT_RESPONSES: Record<string, unknown> = {
  // ThemeProvider notifies the main process of the resolved theme on mount.
  'native:set-theme': { ok: true },
}

/**
 * Create a mock IPC API for component tests.
 * Provide a map of channel names to response values.
 *
 * Usage:
 *   const api = createMockApi({ 'runbook:get': { path: '...', content: '...' } })
 *   <ApiProvider api={api}><MyComponent /></ApiProvider>
 */
export function createMockApi(responses: Record<string, unknown> = {}): RunbooksAPI {
  const merged = { ...DEFAULT_RESPONSES, ...responses }
  return {
    invoke: (async (channel: string) => {
      if (channel in merged) {
        return merged[channel]
      }
      throw new Error(`No mock response for channel: ${channel}`)
    }) as RunbooksAPI["invoke"],
    on: (() => () => {}) as RunbooksAPI["on"],
    once: (() => {}) as RunbooksAPI["once"],
  }
}
