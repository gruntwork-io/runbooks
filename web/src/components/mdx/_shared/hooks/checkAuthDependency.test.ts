import { describe, it, expect } from 'vitest'
import { checkAuthDependency, buildAuthEnvVars, buildGoogleAuthEnvVars, GOOGLE_AUTH_ENV_KEYS } from './useScriptExecution'

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

describe('buildAuthEnvVars — googleAuthId routing', () => {
  const googleBlockOutputs = {
    target_project: {
      values: {
        GOOGLE_APPLICATION_CREDENTIALS: '/tmp/runbooks-gcp-BBB/adc.json',
        GOOGLE_CLOUD_PROJECT: 'target-proj',
        CLOUDSDK_CORE_PROJECT: 'target-proj',
        GOOGLE_PROJECT: 'target-proj',
        CLOUDSDK_CORE_ACCOUNT: 'sa@target.iam.gserviceaccount.com',
        GOOGLE_CLOUD_REGION: 'us-central1',
        CLOUDSDK_COMPUTE_REGION: 'us-central1',
        GOOGLE_REGION: 'us-central1',
        // Empty values are dropped rather than exported blank.
        CLOUDSDK_COMPUTE_ZONE: '',
        GOOGLE_ZONE: '',
        GOOGLE_AUTH_TYPE: 'service_account',
        __AUTHENTICATED: 'true',
      },
    },
  }

  it('collects the Google credential + project vars from the referenced block', () => {
    expect(buildAuthEnvVars('target-project', googleBlockOutputs, GOOGLE_AUTH_ENV_KEYS)).toEqual({
      GOOGLE_APPLICATION_CREDENTIALS: '/tmp/runbooks-gcp-BBB/adc.json',
      GOOGLE_CLOUD_PROJECT: 'target-proj',
      CLOUDSDK_CORE_PROJECT: 'target-proj',
      GOOGLE_PROJECT: 'target-proj',
      CLOUDSDK_CORE_ACCOUNT: 'sa@target.iam.gserviceaccount.com',
      GOOGLE_CLOUD_REGION: 'us-central1',
      CLOUDSDK_COMPUTE_REGION: 'us-central1',
      GOOGLE_REGION: 'us-central1',
    })
  })

  it('never leaks non-Google output keys into the execution env', () => {
    const envVars = buildAuthEnvVars('target-project', googleBlockOutputs, GOOGLE_AUTH_ENV_KEYS)
    expect(envVars).not.toHaveProperty('__AUTHENTICATED')
    expect(envVars).not.toHaveProperty('GOOGLE_AUTH_TYPE')
  })

  it('returns undefined for a GoogleAuth block that has not authenticated', () => {
    expect(buildAuthEnvVars('target-project', {}, GOOGLE_AUTH_ENV_KEYS)).toBeUndefined()
  })

  it('gates the Run button until the referenced GoogleAuth block authenticates', () => {
    expect(checkAuthDependency('target-project', undefined, {})).toEqual({
      blockId: 'target-project',
    })
    expect(
      checkAuthDependency(
        'target-project',
        buildAuthEnvVars('target-project', googleBlockOutputs, GOOGLE_AUTH_ENV_KEYS),
        googleBlockOutputs,
      ),
    ).toBeNull()
  })
})

describe('buildGoogleAuthEnvVars — CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE bridging', () => {
  const fileBackedOutputs = {
    target_project: {
      values: {
        GOOGLE_APPLICATION_CREDENTIALS: '/tmp/runbooks-gcp-BBB/adc.json',
        CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: '/tmp/runbooks-gcp-BBB/adc.json',
        CLOUDSDK_CORE_PROJECT: 'target-proj',
        __AUTHENTICATED: 'true',
      },
    },
  }

  const accessTokenOnlyOutputs = {
    target_project: {
      values: {
        // A bare access-token credential materializes no file: both
        // GOOGLE_APPLICATION_CREDENTIALS and the override are blank.
        GOOGLE_APPLICATION_CREDENTIALS: '',
        CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: '',
        CLOUDSDK_CORE_PROJECT: 'target-proj',
        __AUTHENTICATED: 'true',
      },
    },
  }

  it('returns undefined for a block that has not authenticated', () => {
    expect(buildGoogleAuthEnvVars('target-project', {})).toBeUndefined()
  })

  it('carries the override alongside the credential path', () => {
    expect(buildGoogleAuthEnvVars('target-project', fileBackedOutputs)).toEqual({
      GOOGLE_APPLICATION_CREDENTIALS: '/tmp/runbooks-gcp-BBB/adc.json',
      CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: '/tmp/runbooks-gcp-BBB/adc.json',
      CLOUDSDK_CORE_PROJECT: 'target-proj',
    })
  })

  it('re-emits the override BLANK for an access-token-only credential, rather than dropping it', () => {
    // This is the whole point: buildAuthEnvVars alone would drop an empty
    // value, letting a stale override from a DIFFERENT GoogleAuth block
    // leak through to this execution's env.
    const envVars = buildGoogleAuthEnvVars('target-project', accessTokenOnlyOutputs)
    expect(envVars).toHaveProperty('CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE', '')
  })

  describe('markerOnly — the gate the forced blank override used to jam open', () => {
    const withdrawnOutputs = {
      target_project: { values: { __AUTHENTICATED: 'false' } },
    }

    it('re-closes the gate when the block withdraws its authentication', () => {
      // The regression: buildGoogleAuthEnvVars ALWAYS returns a non-empty object
      // (it force-emits the blank bridge key), so the envVars short-circuit fired
      // unconditionally and __AUTHENTICATED was never read. A GoogleAuth block
      // that re-authenticated — deleting the credential file its previously
      // published outputs still named — could not re-disable the Run button.
      const envVars = buildGoogleAuthEnvVars('target-project', withdrawnOutputs)
      expect(envVars).not.toBeUndefined()
      expect(Object.keys(envVars!).length).toBeGreaterThan(0)

      expect(checkAuthDependency('target-project', envVars, withdrawnOutputs)).toBeNull()
      expect(checkAuthDependency('target-project', envVars, withdrawnOutputs, true)).toEqual({
        blockId: 'target-project',
      })
    })

    it('still opens the gate for a fully authenticated block', () => {
      const envVars = buildGoogleAuthEnvVars('target-project', fileBackedOutputs)
      expect(checkAuthDependency('target-project', envVars, fileBackedOutputs, true)).toBeNull()
    })

    it('opens the gate for an access-token credential, which has no file to name', () => {
      // markerOnly must not become "require GOOGLE_APPLICATION_CREDENTIALS":
      // a bare access-token credential legitimately publishes none.
      const envVars = buildGoogleAuthEnvVars('target-project', accessTokenOnlyOutputs)
      expect(checkAuthDependency('target-project', envVars, accessTokenOnlyOutputs, true)).toBeNull()
    })

    it('leaves the AWS/GitHub short-circuit untouched', () => {
      // Those blocks publish only real credential values, so an env-vars-present
      // check is still a truthful signal for them.
      const awsEnvVars = { AWS_ACCESS_KEY_ID: 'AKIA...', AWS_SECRET_ACCESS_KEY: 'secret' }
      expect(checkAuthDependency('aws-auth', awsEnvVars, {})).toBeNull()
    })
  })
})
