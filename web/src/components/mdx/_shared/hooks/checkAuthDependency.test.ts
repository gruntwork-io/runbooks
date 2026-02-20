import { describe, it, expect } from 'vitest'
import { checkAuthDependency } from './useScriptExecution'

describe('checkAuthDependency', () => {
  const emptyOutputs: Record<string, { values: Record<string, string> }> = {}

  it('returns null when authId is undefined', () => {
    expect(checkAuthDependency(undefined, undefined, emptyOutputs)).toBeNull()
  })

  it('returns null when authId is empty string', () => {
    expect(checkAuthDependency('', undefined, emptyOutputs)).toBeNull()
  })

  it('returns null when envVars has entries (credentials already available)', () => {
    const envVars = { AWS_ACCESS_KEY_ID: 'AKIA...', AWS_SECRET_ACCESS_KEY: 'secret' }
    expect(checkAuthDependency('aws-auth', envVars, emptyOutputs)).toBeNull()
  })

  it('returns null when __AUTHENTICATED marker is set in outputs', () => {
    const outputs = {
      aws_auth: { values: { __AUTHENTICATED: 'true' } },
    }
    expect(checkAuthDependency('aws-auth', undefined, outputs)).toBeNull()
  })

  it('returns unmet dependency when authId set but no env vars or outputs', () => {
    const result = checkAuthDependency('aws-auth', undefined, emptyOutputs)
    expect(result).toEqual({ blockId: 'aws-auth' })
  })

  it('returns unmet dependency when envVars is empty object', () => {
    const result = checkAuthDependency('aws-auth', {}, emptyOutputs)
    expect(result).toEqual({ blockId: 'aws-auth' })
  })

  it('returns unmet dependency when __AUTHENTICATED is not "true"', () => {
    const outputs = {
      aws_auth: { values: { __AUTHENTICATED: 'false' } },
    }
    const result = checkAuthDependency('aws-auth', undefined, outputs)
    expect(result).toEqual({ blockId: 'aws-auth' })
  })

  it('normalizes auth block ID (hyphens to underscores) for output lookup', () => {
    // authId has hyphens, but outputs are stored with underscores
    const outputs = {
      github_auth: { values: { __AUTHENTICATED: 'true' } },
    }
    expect(checkAuthDependency('github-auth', undefined, outputs)).toBeNull()
  })

  it('returns unmet when outputs exist for a different block', () => {
    const outputs = {
      other_block: { values: { __AUTHENTICATED: 'true' } },
    }
    const result = checkAuthDependency('aws-auth', undefined, outputs)
    expect(result).toEqual({ blockId: 'aws-auth' })
  })

  it('env vars take precedence over missing outputs', () => {
    // Even though there are no matching outputs, env vars are sufficient
    const envVars = { GITHUB_TOKEN: 'ghp_...' }
    expect(checkAuthDependency('github-auth', envVars, emptyOutputs)).toBeNull()
  })
})
