import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// useGitClone has no mount effects, so the auth-gate memo can be exercised by
// rendering the hook with controllable block outputs.
let blockOutputs: Record<string, { values: Record<string, string> }> = {}

vi.mock('@/contexts/useRunbook', () => ({
  useRunbookContext: () => ({ registerOutputs: vi.fn(), blockOutputs }),
}))
const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({})),
}))
vi.mock('@/contexts/ApiContext', () => ({
  useApi: () => ({ invoke, on: vi.fn(() => () => {}) }),
}))

import { useGitClone } from '../useGitClone'

beforeEach(() => {
  blockOutputs = {}
  invoke.mockClear()
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

describe('useGitClone — GitHub host of the linked auth block', () => {
  it('defaults to github.com and passes it on every github:* query', async () => {
    const { result } = renderHook(() => useGitClone({ id: 'clone' }))
    expect(result.current.githubHost).toBe('github.com')
    await act(async () => {
      await result.current.fetchOrgs()
      await result.current.fetchRepos('acme')
      await result.current.fetchRefs('acme', 'infra')
    })
    expect(invoke).toHaveBeenCalledWith('github:orgs', { host: 'github.com' })
    expect(invoke).toHaveBeenCalledWith('github:repos', { org: 'acme', host: 'github.com' })
    expect(invoke).toHaveBeenCalledWith('github:refs', { owner: 'acme', repo: 'infra', host: 'github.com' })
  })

  it("follows the auth block's GITHUB_HOST output (GitHub Enterprise)", async () => {
    blockOutputs = { gitauth: { values: { __AUTHENTICATED: 'true', GIT_PROVIDER: 'github', GITHUB_HOST: 'GHES.corp' } } }
    const { result } = renderHook(() => useGitClone({ id: 'clone', gitAuthId: 'gitauth' }))
    expect(result.current.githubHost).toBe('ghes.corp')
    await act(async () => {
      await result.current.checkGitHubToken()
      await result.current.fetchRepos('acme')
    })
    expect(invoke).toHaveBeenCalledWith('github:orgs', { host: 'ghes.corp' })
    expect(invoke).toHaveBeenCalledWith('github:repos', { org: 'acme', host: 'ghes.corp' })
  })

  it('ignores an unparseable GITHUB_HOST output (falls back to github.com)', () => {
    blockOutputs = { ghauth: { values: { __AUTHENTICATED: 'true', GITHUB_HOST: 'ftp://nope' } } }
    const { result } = renderHook(() => useGitClone({ id: 'clone', githubAuthId: 'ghauth' }))
    expect(result.current.githubHost).toBe('github.com')
  })
})
