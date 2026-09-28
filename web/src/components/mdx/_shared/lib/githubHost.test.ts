import { describe, it, expect } from 'vitest'
import {
  githubHostKind,
  githubOAuthUnavailableReason,
  githubTokenCreateUrl,
  githubTokenSettingsUrl,
  githubWebBase,
  isGitHubEnterpriseHost,
  isGitHubRepoHost,
  normalizeGitHubHost,
  resolveGitHubOAuthClientId,
  tryNormalizeGitHubHost,
} from './githubHost'

describe('tryNormalizeGitHubHost', () => {
  it('normalizes bare hosts and URLs to a lowercased host (keeping a port)', () => {
    expect(tryNormalizeGitHubHost('github.com')).toBe('github.com')
    expect(tryNormalizeGitHubHost('  GHES.Example.com ')).toBe('ghes.example.com')
    expect(tryNormalizeGitHubHost('https://ghes.example.com/org/repo')).toBe('ghes.example.com')
    expect(tryNormalizeGitHubHost('http://ghes.example.com:8443/')).toBe('ghes.example.com:8443')
  })

  it('maps API origins back to their web host', () => {
    expect(tryNormalizeGitHubHost('https://api.github.com')).toBe('github.com')
    expect(tryNormalizeGitHubHost('api.acme.ghe.com')).toBe('acme.ghe.com')
  })

  it('is strict: never falls back to github.com', () => {
    expect(tryNormalizeGitHubHost(undefined)).toBeUndefined()
    expect(tryNormalizeGitHubHost('')).toBeUndefined()
    expect(tryNormalizeGitHubHost('ftp://ghes.example.com')).toBeUndefined()
    expect(tryNormalizeGitHubHost('https://user:pw@ghes.example.com')).toBeUndefined()
    expect(tryNormalizeGitHubHost('https://')).toBeUndefined()
    expect(tryNormalizeGitHubHost('not a host')).toBeUndefined()
  })

  it('rejects hosts with characters that are not valid in a DNS name', () => {
    for (const bad of ['a.com;script-src', 'a.com,b.com', "a'b.com", '*.example.com']) {
      expect(tryNormalizeGitHubHost(bad)).toBeUndefined()
    }
  })

  it('normalizeGitHubHost falls back to github.com for display', () => {
    expect(normalizeGitHubHost('')).toBe('github.com')
    expect(normalizeGitHubHost('acme.ghe.com')).toBe('acme.ghe.com')
  })
})

describe('host kinds and URLs', () => {
  it('classifies github.com, ghe.com tenants, and GHES', () => {
    expect(githubHostKind('github.com')).toBe('dotcom')
    expect(githubHostKind('acme.ghe.com')).toBe('ghe-cloud')
    expect(githubHostKind('github.example.com')).toBe('ghes')
    expect(isGitHubEnterpriseHost('github.com')).toBe(false)
    expect(isGitHubEnterpriseHost('acme.ghe.com')).toBe(true)
    expect(isGitHubEnterpriseHost('github.example.com')).toBe(true)
  })

  it('builds web and token settings URLs per host kind', () => {
    expect(githubWebBase('ghes.corp')).toBe('https://ghes.corp')
    expect(githubTokenCreateUrl('github.com')).toBe('https://github.com/settings/personal-access-tokens/new')
    expect(githubTokenCreateUrl('acme.ghe.com')).toBe('https://acme.ghe.com/settings/personal-access-tokens/new')
    expect(githubTokenCreateUrl('ghes.corp')).toBe('https://ghes.corp/settings/tokens/new')
    expect(githubTokenSettingsUrl('github.com')).toBe('https://github.com/settings/personal-access-tokens')
    expect(githubTokenSettingsUrl('acme.ghe.com')).toBe('https://acme.ghe.com/settings/personal-access-tokens')
    expect(githubTokenSettingsUrl('ghes.corp')).toBe('https://ghes.corp/settings/tokens')
  })

  it('isGitHubRepoHost recognizes github.com and *.ghe.com by name only', () => {
    expect(isGitHubRepoHost('github.com')).toBe(true)
    expect(isGitHubRepoHost('Acme.GHE.com')).toBe(true)
    expect(isGitHubRepoHost('github.example.com')).toBe(false)
    expect(isGitHubRepoHost('gitlab.com')).toBe(false)
    expect(isGitHubRepoHost(undefined)).toBe(false)
  })
})

describe('resolveGitHubOAuthClientId', () => {
  it('returns undefined without a prop (main default on github.com)', () => {
    expect(resolveGitHubOAuthClientId(undefined, undefined, 'github.com')).toBeUndefined()
  })

  it('a string applies to github.com only when no host is authored', () => {
    expect(resolveGitHubOAuthClientId('Iv1.abc', undefined, 'github.com')).toBe('Iv1.abc')
    // Never sent to a picked enterprise host.
    expect(resolveGitHubOAuthClientId('Iv1.abc', undefined, 'ghes.corp')).toBeUndefined()
  })

  it("a string applies to the block's authored host", () => {
    expect(resolveGitHubOAuthClientId('Iv1.abc', 'https://GHES.corp/', 'ghes.corp')).toBe('Iv1.abc')
    expect(resolveGitHubOAuthClientId('Iv1.abc', 'ghes.corp', 'github.com')).toBeUndefined()
  })

  it('a map is keyed by normalized host', () => {
    const map = { 'https://GHES.corp': 'Iv1.ghes', 'github.com': 'Iv1.dotcom' }
    expect(resolveGitHubOAuthClientId(map, undefined, 'ghes.corp')).toBe('Iv1.ghes')
    expect(resolveGitHubOAuthClientId(map, undefined, 'github.com')).toBe('Iv1.dotcom')
    expect(resolveGitHubOAuthClientId(map, undefined, 'acme.ghe.com')).toBeUndefined()
  })

  it('explains how to authenticate when OAuth is unavailable', () => {
    const reason = githubOAuthUnavailableReason('ghes.corp')
    expect(reason).toContain('ghes.corp')
    expect(reason).toContain('gh auth login --hostname ghes.corp')
  })
})
