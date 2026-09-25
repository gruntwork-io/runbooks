import { describe, it, expect } from 'vitest'
import { deriveProviderFromAuth, deriveProviderFromRepoUrl, hostFromRepoUrl, repoWebUrl } from './gitProvider'
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

describe('hostFromRepoUrl', () => {
  it('returns undefined for empty input', () => {
    expect(hostFromRepoUrl(undefined)).toBeUndefined()
    expect(hostFromRepoUrl('')).toBeUndefined()
  })

  it('reads the host from an HTTPS clone URL', () => {
    expect(hostFromRepoUrl('https://gitlab.example.com/group/sub/project.git')).toBe(
      'gitlab.example.com',
    )
    expect(hostFromRepoUrl('gitlab.example.com/group/project')).toBe('gitlab.example.com')
  })

  it('preserves a non-standard port (self-hosted on a custom port)', () => {
    expect(hostFromRepoUrl('https://gitlab.example.com:8443/group/project.git')).toBe(
      'gitlab.example.com:8443',
    )
  })

  it('reads the host from an SSH/SCP remote with any username', () => {
    expect(hostFromRepoUrl('git@gitlab.example.com:group/project.git')).toBe('gitlab.example.com')
    expect(hostFromRepoUrl('deploy@gitlab.example.com:group/project.git')).toBe(
      'gitlab.example.com',
    )
  })
})

describe('repoWebUrl', () => {
  it.each([
    ['an HTTPS clone URL', 'https://github.com/o/r.git', 'o', 'r', 'https://github.com/o/r'],
    ['a bare host/path', 'github.com/o/r', 'o', 'r', 'https://github.com/o/r'],
    ['an SCP-style SSH remote', 'git@github.com:o/r.git', 'o', 'r', 'https://github.com/o/r'],
    ['an SCP-style remote with another user', 'deploy@gl.example.com:g/r.git', 'g', 'r', 'https://gl.example.com/g/r'],
    ['an ssh:// URL, dropping the SSH port', 'ssh://git@gl.example.com:2222/g/sub/r.git', 'g/sub', 'r', 'https://gl.example.com/g/sub/r'],
    ['an HTTPS URL on a custom web port', 'https://gl.example.com:8443/g/r', 'g', 'r', 'https://gl.example.com:8443/g/r'],
    ['an HTTPS URL with embedded credentials', 'https://user:tok@github.com/o/r.git', 'o', 'r', 'https://github.com/o/r'],
  ])('links %s', (_label, repoUrl, owner, name, expected) => {
    expect(repoWebUrl(repoUrl, owner, name)).toBe(expected)
  })

  it('returns undefined when the repo has no remote or no owner', () => {
    expect(repoWebUrl('', 'o', 'r')).toBeUndefined()
    expect(repoWebUrl(undefined, 'o', 'r')).toBeUndefined()
    expect(repoWebUrl('https://github.com/o/r.git', '', 'r')).toBeUndefined()
  })

  it('returns undefined for a remote with no web host', () => {
    expect(repoWebUrl('file:///srv/git/o/r.git', 'o', 'r')).toBeUndefined()
    expect(repoWebUrl('https://', 'o', 'r')).toBeUndefined()
  })
})
