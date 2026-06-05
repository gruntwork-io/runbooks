import { describe, it, expect } from 'vitest'
import { deriveProviderFromAuth, deriveProviderFromRepoUrl } from './gitProvider'
import type { BlockOutputs } from '@/contexts/RunbookContext'

function outputs(id: string, values: Record<string, string>): Record<string, BlockOutputs> {
  return { [id]: { values, timestamp: '' } }
}

describe('deriveProviderFromAuth', () => {
  it('returns undefined when no authId is given', () => {
    expect(deriveProviderFromAuth(undefined, {})).toBeUndefined()
  })

  it('returns undefined when the linked block has no outputs yet', () => {
    expect(deriveProviderFromAuth('auth', {})).toBeUndefined()
  })

  it('prefers the explicit GIT_PROVIDER output (github)', () => {
    expect(deriveProviderFromAuth('auth', outputs('auth', { GIT_PROVIDER: 'github' }))).toBe('github')
  })

  it('prefers the explicit GIT_PROVIDER output (gitlab)', () => {
    expect(deriveProviderFromAuth('auth', outputs('auth', { GIT_PROVIDER: 'gitlab' }))).toBe('gitlab')
  })

  it('falls back to GITHUB_TOKEN presence when GIT_PROVIDER is absent', () => {
    expect(deriveProviderFromAuth('auth', outputs('auth', { GITHUB_TOKEN: 'tok' }))).toBe('github')
  })

  it('falls back to GITLAB_TOKEN presence when GIT_PROVIDER is absent', () => {
    expect(deriveProviderFromAuth('auth', outputs('auth', { GITLAB_TOKEN: 'tok' }))).toBe('gitlab')
  })

  it('returns undefined for an __AUTHENTICATED-only block (provider not derivable)', () => {
    expect(deriveProviderFromAuth('auth', outputs('auth', { __AUTHENTICATED: 'true' }))).toBeUndefined()
  })

  it('normalizes the block id when looking up outputs (hyphens -> underscores)', () => {
    // registerOutputs stores under the normalized id; lookup must match.
    expect(deriveProviderFromAuth('my-auth', outputs('my_auth', { GIT_PROVIDER: 'gitlab' }))).toBe('gitlab')
  })
})

describe('deriveProviderFromRepoUrl', () => {
  it('returns undefined for an empty url', () => {
    expect(deriveProviderFromRepoUrl(undefined)).toBeUndefined()
    expect(deriveProviderFromRepoUrl('')).toBeUndefined()
  })

  it('recognizes github.com (https, bare host, and ssh)', () => {
    expect(deriveProviderFromRepoUrl('https://github.com/org/repo.git')).toBe('github')
    expect(deriveProviderFromRepoUrl('github.com/org/repo')).toBe('github')
    expect(deriveProviderFromRepoUrl('git@github.com:org/repo.git')).toBe('github')
  })

  it('recognizes gitlab.com (https, bare host, and ssh)', () => {
    expect(deriveProviderFromRepoUrl('https://gitlab.com/group/sub/project.git')).toBe('gitlab')
    expect(deriveProviderFromRepoUrl('gitlab.com/group/project')).toBe('gitlab')
    expect(deriveProviderFromRepoUrl('git@gitlab.com:group/project.git')).toBe('gitlab')
  })

  it('returns undefined for self-hosted / enterprise hosts', () => {
    expect(deriveProviderFromRepoUrl('https://gitlab.mycompany.com/g/p.git')).toBeUndefined()
    expect(deriveProviderFromRepoUrl('https://github.acme.internal/o/r.git')).toBeUndefined()
    expect(deriveProviderFromRepoUrl('git@git.example.org:o/r.git')).toBeUndefined()
  })
})
