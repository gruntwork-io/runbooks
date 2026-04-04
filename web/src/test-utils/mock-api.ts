import type { RunbooksAPI } from '@/contexts/ApiContext'

/**
 * Create a mock IPC API for component tests.
 * Provide a map of channel names to response values.
 *
 * Usage:
 *   const api = createMockApi({ 'runbook:get': { path: '...', content: '...' } })
 *   <ApiProvider api={api}><MyComponent /></ApiProvider>
 */
export function createMockApi(responses: Record<string, unknown> = {}): RunbooksAPI {
  return {
    invoke: async <T>(channel: string): Promise<T> => {
      if (channel in responses) {
        return responses[channel] as T
      }
      throw new Error(`No mock response for channel: ${channel}`)
    },
    on: () => () => {},
    once: () => {},
  }
}
