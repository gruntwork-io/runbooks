import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

// useGitClone has no mount effects, so the auth-gate memo can be exercised by
// rendering the hook with controllable block outputs.
let blockOutputs: Record<string, { values: Record<string, string> }> = {}

vi.mock('@/contexts/useRunbook', () => ({
  useRunbookContext: () => ({ registerOutputs: vi.fn(), blockOutputs }),
}))
vi.mock('@/contexts/ApiContext', () => ({
  useApi: () => ({ invoke: vi.fn(async () => ({})), on: vi.fn(() => () => {}) }),
}))

import { useGitClone } from '../useGitClone'

beforeEach(() => {
  blockOutputs = {}
})

describe('useGitClone — auth gate (gitAuthId / githubAuthId)', () => {
  it('is met when there is no auth dependency', () => {
    const { result } = renderHook(() => useGitClone({ id: 'clone' }))
    expect(result.current.gitHubAuthMet).toBe(true)
  })

  it('gitAuthId is met when the referenced block emitted GITLAB_TOKEN', () => {
    blockOutputs = { gitauth: { values: { GITLAB_TOKEN: 'glpat-x', GITLAB_USER: 'tanuki' } } }
    const { result } = renderHook(() => useGitClone({ id: 'clone', gitAuthId: 'gitauth' }))
    expect(result.current.gitHubAuthMet).toBe(true)
  })

  it('gitAuthId is met via __AUTHENTICATED (env-detected GitLab block)', () => {
    // env/cli detection registers only the __AUTHENTICATED marker to block
    // outputs; the token lives in session env.
    blockOutputs = { gitauth: { values: { __AUTHENTICATED: 'true' } } }
    const { result } = renderHook(() => useGitClone({ id: 'clone', gitAuthId: 'gitauth' }))
    expect(result.current.gitHubAuthMet).toBe(true)
  })

  it('gitAuthId is NOT met when the referenced block has no credentials yet', () => {
    blockOutputs = { gitauth: { values: {} } }
    const { result } = renderHook(() => useGitClone({ id: 'clone', gitAuthId: 'gitauth' }))
    expect(result.current.gitHubAuthMet).toBe(false)
  })

  it('githubAuthId still gates on GITHUB_TOKEN (regression)', () => {
    blockOutputs = { ghauth: { values: { GITHUB_TOKEN: 'ghp_x' } } }
    const { result } = renderHook(() => useGitClone({ id: 'clone', githubAuthId: 'ghauth' }))
    expect(result.current.gitHubAuthMet).toBe(true)
  })

  it('githubAuthId is NOT met for an empty referenced block', () => {
    blockOutputs = { ghauth: { values: {} } }
    const { result } = renderHook(() => useGitClone({ id: 'clone', githubAuthId: 'ghauth' }))
    expect(result.current.gitHubAuthMet).toBe(false)
  })
})
