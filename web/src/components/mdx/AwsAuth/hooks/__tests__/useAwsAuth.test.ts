import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useAwsAuth } from '../useAwsAuth'

/**
 * Which tab the block opens on is decided once, at mount, from the author's
 * `defaultTab` prop. Detection is switched off in these tests so no IPC runs —
 * the starting tab is the only behaviour under test.
 */

vi.mock('@/contexts/useRunbook', () => ({
  useRunbookContext: () => ({ registerOutputs: vi.fn(), blockOutputs: {} }),
}))
vi.mock('@/contexts/useSession', () => ({
  useSession: () => ({ isReady: true }),
}))

const originalApi = window.api

afterEach(() => {
  window.api = originalApi
})

const renderAwsAuth = (defaultTab?: string) =>
  renderHook(() =>
    useAwsAuth({
      id: 'aws',
      ssoRegion: 'us-east-1',
      defaultRegion: 'us-east-1',
      detectCredentials: false,
      defaultTab,
    }),
  )

describe('useAwsAuth — defaultTab', () => {
  it('opens on Static Credentials when no defaultTab is set', () => {
    expect(renderAwsAuth().result.current.authMethod).toBe('credentials')
  })

  it('opens on the tab the author asked for', () => {
    expect(renderAwsAuth('sso').result.current.authMethod).toBe('sso')
    expect(renderAwsAuth('profile').result.current.authMethod).toBe('profile')
  })

  it('falls back to Static Credentials for an unrecognized tab name', () => {
    // MDX props are untyped, so a typo must not leave the block formless.
    expect(renderAwsAuth('sso-tab').result.current.authMethod).toBe('credentials')
  })
})
