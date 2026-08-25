import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderHook, act, waitFor } from '@testing-library/react'
import { ApiProvider } from '@/contexts/ApiContext'
import { useGoogleAuth } from '../useGoogleAuth'

/**
 * `useGoogleAuth` under test with the IPC surface as the ONLY boundary that is
 * faked: every state transition, the detection walk, the confirm gate, project
 * selection, and the block-output publication are the real implementation.
 *
 * The runbook + session contexts are stubbed because they are ambient state the
 * hook reads (block outputs, session readiness), not the behaviour under test.
 * `useApi()` is fed through the REAL ApiProvider so the hook's context access is
 * exercised too — GoogleAuth is the first auth block that must not touch
 * `window.api` directly (plan D8).
 */

const registerOutputs = vi.fn()
const runbookState: { blockOutputs: Record<string, { values: Record<string, string> }> } = {
  blockOutputs: {},
}
const sessionState = { isReady: true }

vi.mock('@/contexts/useRunbook', () => ({
  useRunbookContext: () => ({
    registerOutputs,
    blockOutputs: runbookState.blockOutputs,
  }),
}))
vi.mock('@/contexts/useSession', () => ({
  useSession: () => ({ isReady: sessionState.isReady }),
}))

type InvokeImpl = (channel: string, args?: Record<string, unknown>) => unknown

type Api = Parameters<typeof ApiProvider>[0]['api']

let currentApi: Api

/** Install a fake IPC surface. Returns the spy so channels/params can be asserted. */
function installApi(impl: InvokeImpl) {
  const invoke = vi.fn(async (channel: string, args?: Record<string, unknown>) => {
    const result = impl(channel, args)
    // The hook probes `google:oauth-available` on mount so the Google Sign-In
    // tab can label "(needs OAuth client)" on FIRST paint. Default it to
    // "configured" so only the tests that care about an unconfigured build have
    // to say so.
    if (channel === 'google:oauth-available' && Object.keys((result ?? {}) as object).length === 0) {
      return { available: true }
    }
    return result
  })
  currentApi = { invoke, on: () => () => {}, once: () => {} } as unknown as Api
  return invoke
}

/**
 * Calls to one channel. Used instead of raw call counts so the mount-time
 * capability probe — which is not a credential read — never skews an assertion
 * about what detection did.
 */
const callsTo = (invoke: ReturnType<typeof installApi>, channel: string) =>
  invoke.mock.calls.filter((call) => call[0] === channel)

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(ApiProvider, { api: currentApi, children })

const renderGoogleAuth = (options: Parameters<typeof useGoogleAuth>[0]) =>
  renderHook(() => useGoogleAuth(options), { wrapper })

/** The full output map the block publishes — every key, in one call (plan §7.2). */
function outputs(over: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    GOOGLE_APPLICATION_CREDENTIALS: '',
    CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: '',
    GOOGLE_CLOUD_PROJECT: '',
    CLOUDSDK_CORE_PROJECT: '',
    GOOGLE_PROJECT: '',
    CLOUDSDK_CORE_ACCOUNT: '',
    GOOGLE_CLOUD_REGION: '',
    CLOUDSDK_COMPUTE_REGION: '',
    GOOGLE_REGION: '',
    CLOUDSDK_COMPUTE_ZONE: '',
    GOOGLE_ZONE: '',
    GOOGLE_AUTH_TYPE: '',
    __AUTHENTICATED: 'true',
    ...over,
  } as Record<string, string>
}

/**
 * The block published no authentication contract.
 *
 * Not `not.toHaveBeenCalled()`: every flow that can make MAIN materialise a new
 * credential file WITHDRAWS the previous outputs up front (see
 * `invalidateBlockOutputs`), so `registerOutputs` legitimately fires before the
 * flow resolves. What must never happen is a `__AUTHENTICATED: 'true'` while the
 * credential is unresolved — that is what leaves a `<Command googleAuthId>`
 * injecting a path MAIN has already superseded.
 */
function expectNoAuthenticatedPublish(spy: ReturnType<typeof vi.fn>) {
  for (const [, values] of spy.mock.calls) {
    expect((values as Record<string, string>).__AUTHENTICATED).not.toBe('true')
  }
}

const SA_KEY = JSON.stringify({
  type: 'service_account',
  project_id: 'key-project',
  client_email: 'sa@key-project.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nzzz\n-----END PRIVATE KEY-----\n',
})

beforeEach(() => {
  registerOutputs.mockClear()
  runbookState.blockOutputs = {}
  sessionState.isReady = true
  installApi(() => ({}))
})

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

describe('useGoogleAuth — detection', () => {
  it('detectCredentials={false} starts done and never probes for credentials', async () => {
    const invoke = installApi(() => ({}))
    const { result } = renderGoogleAuth({ id: 'gcp', detectCredentials: false })

    expect(result.current.detectionStatus).toBe('done')
    expect(result.current.authStatus).toBe('pending')
    await act(async () => {})
    expect(callsTo(invoke, 'google:env-credentials')).toHaveLength(0)
    expect(callsTo(invoke, 'google:validate-credentials')).toHaveLength(0)
  })

  it('waits for the session before probing anything', async () => {
    sessionState.isReady = false
    const invoke = installApi(() => ({ found: false }))

    const { result, rerender } = renderGoogleAuth({ id: 'gcp' })
    await act(async () => {})
    expect(callsTo(invoke, 'google:env-credentials')).toHaveLength(0)
    expect(result.current.detectionStatus).toBe('pending')

    sessionState.isReady = true
    rerender()
    await waitFor(() => expect(result.current.detectionStatus).toBe('done'))
    expect(invoke).toHaveBeenCalledWith('google:env-credentials', expect.anything())
  })

  it('walks sources in author order and stops at the first success (read-only)', async () => {
    const invoke = installApi((channel, args) => {
      if (channel !== 'google:env-credentials') return {}
      if (args?.source === 'adc') {
        return {
          found: true,
          valid: true,
          projectId: 'proj-a',
          projectName: 'Project A',
          account: { principal: 'dev@example.com', accountType: 'user' },
          credentialType: 'authorized_user',
          path: '/home/u/.config/gcloud/application_default_credentials.json',
          quotaProjectId: 'quota-proj',
        }
      }
      return { found: false }
    })

    const { result } = renderGoogleAuth({ id: 'gcp' })

    await waitFor(() => expect(result.current.detectionStatus).toBe('detected'))

    const sources = callsTo(invoke, 'google:env-credentials').map(
      (c) => (c[1] as { source?: string })?.source,
    )
    expect(sources).toEqual(['env', 'adc'])

    expect(result.current.detectedCredentials).toEqual({
      projectId: 'proj-a',
      projectName: 'Project A',
      principal: 'dev@example.com',
      credentialType: 'authorized_user',
      source: 'adc',
      quotaProjectId: 'quota-proj',
      path: '/home/u/.config/gcloud/application_default_credentials.json',
    })
    // Detection is a probe: nothing is published and nothing is confirmed yet.
    expectNoAuthenticatedPublish(registerOutputs)
    expect(result.current.authStatus).toBe('pending')
  })

  it('joins "found but invalid" warnings and finishes as done', async () => {
    installApi((channel) =>
      channel === 'google:env-credentials' ? { found: true, valid: false } : {},
    )

    const { result } = renderGoogleAuth({ id: 'gcp' })

    await waitFor(() => expect(result.current.detectionStatus).toBe('done'))
    expect(result.current.detectionWarning).toBe(
      'Google Cloud credentials in the environment are invalid or expired; Application Default Credentials are invalid or expired',
    )
    expect(result.current.detectedCredentials).toBeNull()
  })

  it('passes the prefix through for a { env: { prefix } } source', async () => {
    const invoke = installApi(() => ({ found: false }))

    const { result } = renderGoogleAuth({
      id: 'gcp',
      project: 'proj-prop',
      detectCredentials: [{ env: { prefix: 'PROD_' } }],
    })

    await waitFor(() => expect(result.current.detectionStatus).toBe('done'))
    expect(invoke).toHaveBeenCalledWith('google:env-credentials', {
      prefix: 'PROD_',
      defaultProject: 'proj-prop',
      source: 'env',
    })
  })

  it('confirming detected credentials registers the session and publishes outputs', async () => {
    const invoke = installApi((channel, args) => {
      if (channel === 'google:env-credentials') {
        return {
          found: true,
          valid: true,
          projectId: 'proj-a',
          projectName: 'Project A',
          account: { principal: 'dev@example.com', accountType: 'user' },
          credentialType: 'authorized_user',
          envVar: 'GOOGLE_APPLICATION_CREDENTIALS',
        }
      }
      if (channel === 'google:env-credentials-confirm') {
        expect(args).toEqual({ blockId: 'gcp', source: 'env', projectId: 'proj-a' })
        return {
          valid: true,
          account: { principal: 'dev@example.com', accountType: 'user' },
          projectId: 'proj-a',
          credentialsPath: '/tmp/runbooks-gcp-1/adc.json',
          credentialType: 'authorized_user',
        }
      }
      if (channel === 'google:check-project') return { enabled: true }
      return {}
    })

    const { result } = renderGoogleAuth({ id: 'gcp', detectCredentials: ['env'] })
    await waitFor(() => expect(result.current.detectionStatus).toBe('detected'))

    await act(async () => {
      await result.current.handleConfirmDetected()
    })

    expect(result.current.authStatus).toBe('authenticated')
    expect(result.current.accountInfo).toEqual({
      projectId: 'proj-a',
      projectName: 'Project A',
      principal: 'dev@example.com',
      accountType: 'user',
      credentialType: 'authorized_user',
      credentialsPath: '/tmp/runbooks-gcp-1/adc.json',
    })
    // Two calls, in this order: the contract is WITHDRAWN before MAIN can
    // materialise a replacement credential, then re-published once the flow
    // resolves. The publish itself is still the single all-keys call (§7.2).
    expect(registerOutputs).toHaveBeenCalledTimes(2)
    expect(registerOutputs.mock.calls[0]).toEqual(['gcp', { __AUTHENTICATED: 'false' }])
    expect(registerOutputs).toHaveBeenCalledWith(
      'gcp',
      outputs({
        GOOGLE_APPLICATION_CREDENTIALS: '/tmp/runbooks-gcp-1/adc.json',
        CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: '/tmp/runbooks-gcp-1/adc.json',
        GOOGLE_CLOUD_PROJECT: 'proj-a',
        CLOUDSDK_CORE_PROJECT: 'proj-a',
        GOOGLE_PROJECT: 'proj-a',
        CLOUDSDK_CORE_ACCOUNT: 'dev@example.com',
        GOOGLE_AUTH_TYPE: 'authorized_user',
      }),
    )
    // MAIN owns every credential write; the renderer never touches session env.
    expect(invoke).not.toHaveBeenCalledWith('session:set-env', expect.anything())
  })

  it('a failed confirm renders inline and publishes nothing', async () => {
    installApi((channel) => {
      if (channel === 'google:env-credentials') {
        return {
          found: true,
          valid: true,
          projectId: 'proj-a',
          account: { principal: 'dev@example.com', accountType: 'user' },
          credentialType: 'authorized_user',
        }
      }
      if (channel === 'google:env-credentials-confirm') {
        return { valid: false, error: 'The credentials expired between detection and use' }
      }
      return {}
    })

    const { result } = renderGoogleAuth({ id: 'gcp', detectCredentials: ['env'] })
    await waitFor(() => expect(result.current.detectionStatus).toBe('detected'))

    await act(async () => {
      await result.current.handleConfirmDetected()
    })

    expect(result.current.authStatus).toBe('failed')
    expect(result.current.errorMessage).toBe('The credentials expired between detection and use')
    expectNoAuthenticatedPublish(registerOutputs)
  })

  it('rejecting the prompt falls through to the manual tabs', async () => {
    installApi((channel) =>
      channel === 'google:env-credentials'
        ? {
            found: true,
            valid: true,
            projectId: 'proj-a',
            account: { principal: 'dev@example.com', accountType: 'user' },
            credentialType: 'authorized_user',
          }
        : {},
    )

    const { result } = renderGoogleAuth({ id: 'gcp', detectCredentials: ['env'] })
    await waitFor(() => expect(result.current.detectionStatus).toBe('detected'))

    act(() => result.current.handleRejectDetected())

    expect(result.current.detectedCredentials).toBeNull()
    expect(result.current.detectionStatus).toBe('done')
    expect(result.current.authStatus).toBe('pending')
  })

  it('pauses on a block source that has not executed, then resumes when it has', async () => {
    const invoke = installApi((channel) => {
      if (channel === 'google:validate-credentials') {
        return {
          valid: true,
          projectId: 'proj-b',
          account: { principal: 'sa@proj-b.iam.gserviceaccount.com', accountType: 'service_account' },
          credentialType: 'service_account',
        }
      }
      return { found: false }
    })

    const { result, rerender } = renderGoogleAuth({
      id: 'gcp',
      detectCredentials: [{ block: 'bootstrap' }, 'env'],
    })

    // The author's ordering wins: the walk PAUSES rather than skipping ahead.
    await waitFor(() => expect(result.current.waitingForBlockId).toBe('bootstrap'))
    expect(result.current.detectionStatus).toBe('pending')
    expect(invoke).not.toHaveBeenCalledWith('google:env-credentials', expect.anything())

    runbookState.blockOutputs = {
      bootstrap: {
        values: {
          GOOGLE_APPLICATION_CREDENTIALS: '/tmp/from-block.json',
          CLOUDSDK_CORE_PROJECT: 'proj-b',
        },
      },
    }
    rerender()

    await waitFor(() => expect(result.current.detectionStatus).toBe('detected'))
    expect(invoke).toHaveBeenCalledWith('google:validate-credentials', {
      blockId: 'gcp',
      keyPath: '/tmp/from-block.json',
      projectId: 'proj-b',
      registerSession: false,
    })
    expect(result.current.detectedCredentials?.source).toBe('block')
    expect(result.current.waitingForBlockId).toBeNull()
  })

  it('enforces required scopes on { block } credentials via validate-credentials', async () => {
    const DIRECTORY = 'https://www.googleapis.com/auth/admin.directory.rolemanagement'
    const CLOUD_PLATFORM = 'https://www.googleapis.com/auth/cloud-platform'
    const requiredScopes = [CLOUD_PLATFORM, DIRECTORY]

    runbookState.blockOutputs = {
      bootstrap: {
        values: {
          GOOGLE_OAUTH_ACCESS_TOKEN: 'ya29.user-token',
          CLOUDSDK_CORE_PROJECT: 'proj-b',
        },
      },
    }

    const invoke = installApi((channel, args) => {
      if (channel === 'google:validate-credentials') {
        expect(args?.scopes).toEqual(requiredScopes)
        expect(args?.registerSession).toBe(false)
        return {
          valid: false,
          insufficientScopes: true,
          missingScopes: [DIRECTORY],
          grantedScopes: [CLOUD_PLATFORM],
          projectId: 'proj-b',
          account: { principal: 'admin@example.com', accountType: 'user', scopes: [CLOUD_PLATFORM] },
          credentialType: 'access_token',
        }
      }
      return { found: false }
    })

    const { result } = renderGoogleAuth({
      id: 'gcp',
      scopes: requiredScopes,
      detectCredentials: [{ block: 'bootstrap' }],
    })

    await waitFor(() => expect(result.current.detectionStatus).toBe('detected'))
    expect(result.current.detectedCredentials?.source).toBe('block')
    expect(result.current.detectedCredentials?.missingScopes).toEqual([DIRECTORY])
    expect(invoke).toHaveBeenCalledWith(
      'google:validate-credentials',
      expect.objectContaining({
        blockId: 'gcp',
        accessToken: 'ya29.user-token',
        scopes: requiredScopes,
        registerSession: false,
      }),
    )
  })

  it('retrying detection re-runs the walk and flags "found nothing"', async () => {
    const invoke = installApi(() => ({ found: false }))

    const { result } = renderGoogleAuth({ id: 'gcp', detectCredentials: ['env'] })
    await waitFor(() => expect(result.current.detectionStatus).toBe('done'))
    expect(result.current.retryFoundNothing).toBe(false)
    expect(callsTo(invoke, 'google:env-credentials')).toHaveLength(1)

    act(() => result.current.handleRetryDetection())

    await waitFor(() => expect(result.current.retryFoundNothing).toBe(true))
    expect(callsTo(invoke, 'google:env-credentials')).toHaveLength(2)

    act(() => result.current.clearRetryMessage())
    expect(result.current.retryFoundNothing).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Tab 1 — service account key
// ---------------------------------------------------------------------------

describe('useGoogleAuth — service account tab', () => {
  it('validates the pasted key, registers the session, and publishes outputs', async () => {
    const invoke = installApi((channel) => {
      if (channel === 'google:validate-credentials') {
        return {
          valid: true,
          account: {
            principal: 'sa@key-project.iam.gserviceaccount.com',
            accountType: 'service_account',
          },
          projectId: 'proj-x',
          projectName: 'Project X',
          credentialType: 'service_account',
          credentialsPath: '/tmp/runbooks-gcp-2/adc.json',
        }
      }
      if (channel === 'google:check-project') return { enabled: true }
      return {}
    })

    const { result } = renderGoogleAuth({
      id: 'gcp',
      project: 'proj-x',
      defaultRegion: 'us-central1',
      detectCredentials: false,
    })

    act(() => result.current.setServiceAccountKey(SA_KEY))
    await act(async () => {
      result.current.handleServiceAccountSubmit()
    })

    await waitFor(() => expect(result.current.authStatus).toBe('authenticated'))
    expect(invoke).toHaveBeenCalledWith('google:validate-credentials', {
      blockId: 'gcp',
      keyJson: SA_KEY,
      projectId: 'proj-x',
      region: 'us-central1',
      registerSession: true,
    })
    expect(registerOutputs).toHaveBeenCalledWith(
      'gcp',
      outputs({
        GOOGLE_APPLICATION_CREDENTIALS: '/tmp/runbooks-gcp-2/adc.json',
        CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: '/tmp/runbooks-gcp-2/adc.json',
        GOOGLE_CLOUD_PROJECT: 'proj-x',
        CLOUDSDK_CORE_PROJECT: 'proj-x',
        GOOGLE_PROJECT: 'proj-x',
        CLOUDSDK_CORE_ACCOUNT: 'sa@key-project.iam.gserviceaccount.com',
        GOOGLE_CLOUD_REGION: 'us-central1',
        CLOUDSDK_COMPUTE_REGION: 'us-central1',
        GOOGLE_REGION: 'us-central1',
        GOOGLE_AUTH_TYPE: 'service_account',
      }),
    )
    expect(invoke).toHaveBeenCalledWith('google:check-project', {
      blockId: 'gcp',
      projectId: 'proj-x',
    })
    expect(invoke).not.toHaveBeenCalledWith('session:set-env', expect.anything())
  })

  it('surfaces a rejected key inline as a runtime error', async () => {
    installApi((channel) =>
      channel === 'google:validate-credentials'
        ? { valid: false, error: 'Not a service account key (expected type: service_account)' }
        : {},
    )

    const { result } = renderGoogleAuth({ id: 'gcp', detectCredentials: false })

    act(() => result.current.setServiceAccountKey('{"type":"authorized_user"}'))
    await act(async () => {
      result.current.handleServiceAccountSubmit()
    })

    await waitFor(() => expect(result.current.authStatus).toBe('failed'))
    expect(result.current.errorMessage).toBe(
      'Not a service account key (expected type: service_account)',
    )
    expectNoAuthenticatedPublish(registerOutputs)
  })

  it('refuses to submit an empty key without an IPC round trip', async () => {
    const invoke = installApi(() => ({}))
    const { result } = renderGoogleAuth({ id: 'gcp', detectCredentials: false })

    await act(async () => {
      result.current.handleServiceAccountSubmit()
    })

    expect(result.current.authStatus).toBe('failed')
    expect(result.current.errorMessage).toBe('A service account key JSON is required')
    expect(callsTo(invoke, 'google:validate-credentials')).toHaveLength(0)
  })

  it('falls into project selection when the key can see more than one project', async () => {
    const invoke = installApi((channel) => {
      if (channel === 'google:validate-credentials') {
        return {
          valid: true,
          account: { principal: 'sa@key-project.iam.gserviceaccount.com', accountType: 'service_account' },
          credentialType: 'service_account',
          credentialsPath: '/tmp/runbooks-gcp-3/adc.json',
          projects: [
            { projectId: 'proj-one', displayName: 'Project One' },
            { projectId: 'proj-two', displayName: 'Project Two' },
          ],
        }
      }
      if (channel === 'google:set-project') return { ok: true, projectName: 'Project Two' }
      if (channel === 'google:check-project') return { enabled: true }
      return {}
    })

    const { result } = renderGoogleAuth({ id: 'gcp', detectCredentials: false })

    act(() => result.current.setServiceAccountKey(SA_KEY))
    await act(async () => {
      result.current.handleServiceAccountSubmit()
    })

    await waitFor(() => expect(result.current.authStatus).toBe('select_project'))
    expect(result.current.projects).toHaveLength(2)
    expectNoAuthenticatedPublish(registerOutputs)

    await act(async () => {
      await result.current.handleProjectSelect({ projectId: 'proj-two', displayName: 'Project Two' })
    })

    expect(invoke).toHaveBeenCalledWith('google:set-project', {
      blockId: 'gcp',
      projectId: 'proj-two',
    })
    expect(result.current.authStatus).toBe('authenticated')
    // The credentials file survives the select_project detour.
    expect(registerOutputs).toHaveBeenCalledWith(
      'gcp',
      outputs({
        GOOGLE_APPLICATION_CREDENTIALS: '/tmp/runbooks-gcp-3/adc.json',
        CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: '/tmp/runbooks-gcp-3/adc.json',
        GOOGLE_CLOUD_PROJECT: 'proj-two',
        CLOUDSDK_CORE_PROJECT: 'proj-two',
        GOOGLE_PROJECT: 'proj-two',
        CLOUDSDK_CORE_ACCOUNT: 'sa@key-project.iam.gserviceaccount.com',
        GOOGLE_AUTH_TYPE: 'service_account',
      }),
    )
  })

  it('takes a key file by PATH and never reads its contents into the renderer', async () => {
    const invoke = installApi((channel) => {
      if (channel === 'native:show-open-dialog') {
        // The ordinary case: a key downloaded from the console, i.e. OUTSIDE
        // the workspace. `file:read` would refuse this path outright.
        return { filePaths: ['/home/u/Downloads/project-abc-1234.json'], canceled: false }
      }
      if (channel === 'google:validate-credentials') {
        return {
          valid: true,
          account: {
            principal: 'sa@key-project.iam.gserviceaccount.com',
            accountType: 'service_account',
          },
          projectId: 'proj-x',
          credentialType: 'service_account',
          credentialsPath: '/home/u/Downloads/project-abc-1234.json',
        }
      }
      if (channel === 'google:check-project') return { enabled: true }
      return {}
    })

    const { result } = renderGoogleAuth({ id: 'gcp', detectCredentials: false })

    await act(async () => {
      await result.current.loadKeyFromFile()
    })

    expect(result.current.keyFilePath).toBe('/home/u/Downloads/project-abc-1234.json')
    expect(result.current.keyFileName).toBe('project-abc-1234.json')
    // The custody rule: the private key never enters renderer state.
    expect(result.current.serviceAccountKey).toBe('')
    expect(callsTo(invoke, 'file:read')).toHaveLength(0)

    await act(async () => {
      result.current.handleServiceAccountSubmit()
    })
    await waitFor(() => expect(result.current.authStatus).toBe('authenticated'))

    // MAIN reads and validates the file itself; only the path crosses IPC.
    expect(invoke).toHaveBeenCalledWith('google:validate-credentials', {
      blockId: 'gcp',
      keyPath: '/home/u/Downloads/project-abc-1234.json',
      registerSession: true,
    })
  })

  it('pasting a key after choosing a file drops the file (one credential at a time)', async () => {
    const invoke = installApi((channel) => {
      if (channel === 'native:show-open-dialog') {
        return { filePaths: ['/home/u/Downloads/key.json'], canceled: false }
      }
      if (channel === 'google:validate-credentials') {
        return {
          valid: true,
          account: { principal: 'sa@key-project.iam.gserviceaccount.com', accountType: 'service_account' },
          projectId: 'proj-x',
          credentialType: 'service_account',
        }
      }
      if (channel === 'google:check-project') return { enabled: true }
      return {}
    })

    const { result } = renderGoogleAuth({ id: 'gcp', detectCredentials: false })

    await act(async () => {
      await result.current.loadKeyFromFile()
    })
    act(() => result.current.setServiceAccountKey(SA_KEY))

    expect(result.current.keyFilePath).toBeNull()
    expect(result.current.keyFileName).toBeNull()

    await act(async () => {
      result.current.handleServiceAccountSubmit()
    })
    await waitFor(() => expect(result.current.authStatus).toBe('authenticated'))

    const [, params] = invoke.mock.calls.find((c) => c[0] === 'google:validate-credentials')!
    expect(params).toHaveProperty('keyJson', SA_KEY)
    expect(params).not.toHaveProperty('keyPath')
  })
})

// ---------------------------------------------------------------------------
// Tab 2 — Google sign-in (loopback OAuth)
// ---------------------------------------------------------------------------

describe('useGoogleAuth — OAuth tab', () => {
  it('starts the loopback flow, hands off to the browser, and finishes on complete', async () => {
    const invoke = installApi((channel) => {
      if (channel === 'google:oauth-start') {
        return {
          flowId: 'flow-1',
          authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=abc',
          redirectUri: 'http://127.0.0.1:53211/oauth2callback',
          expiresInSeconds: 300,
        }
      }
      if (channel === 'google:oauth-poll') {
        return {
          status: 'complete',
          account: { principal: 'dev@example.com', accountType: 'user' },
          credentialsPath: '/tmp/runbooks-gcp-4/adc.json',
          projects: [{ projectId: 'proj-solo', displayName: 'Solo Project' }],
          scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        }
      }
      if (channel === 'google:set-project') return { ok: true, projectName: 'Solo Project' }
      if (channel === 'google:check-project') return { enabled: true }
      return {}
    })

    const { result } = renderGoogleAuth({ id: 'gcp', detectCredentials: false })

    await act(async () => {
      await result.current.handleOAuthLogin()
    })
    await waitFor(() => expect(result.current.authStatus).toBe('authenticated'))

    // MAIN owns the default client id — nothing is sent unless the author overrode it.
    expect(invoke).toHaveBeenCalledWith('google:oauth-start', {})
    expect(invoke).toHaveBeenCalledWith('native:open-external', {
      url: 'https://accounts.google.com/o/oauth2/v2/auth?state=abc',
    })
    // Exactly one visible project auto-selects; no picker detour.
    expect(invoke).toHaveBeenCalledWith('google:set-project', {
      blockId: 'gcp',
      projectId: 'proj-solo',
    })
    expect(result.current.oauthFlowId).toBeNull()
    expect(registerOutputs).toHaveBeenCalledWith(
      'gcp',
      outputs({
        GOOGLE_APPLICATION_CREDENTIALS: '/tmp/runbooks-gcp-4/adc.json',
        CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: '/tmp/runbooks-gcp-4/adc.json',
        GOOGLE_CLOUD_PROJECT: 'proj-solo',
        CLOUDSDK_CORE_PROJECT: 'proj-solo',
        GOOGLE_PROJECT: 'proj-solo',
        CLOUDSDK_CORE_ACCOUNT: 'dev@example.com',
        GOOGLE_AUTH_TYPE: 'authorized_user',
      }),
    )
  })

  it('sends author OAuth overrides and offers a project picker for multiple projects', async () => {
    const invoke = installApi((channel) => {
      if (channel === 'google:oauth-start') {
        return { flowId: 'flow-2', authUrl: 'https://accounts.google.com/o/oauth2/v2/auth' }
      }
      if (channel === 'google:oauth-poll') {
        return {
          status: 'complete',
          account: { principal: 'dev@example.com', accountType: 'user' },
          credentialsPath: '/tmp/runbooks-gcp-5/adc.json',
          projects: [
            { projectId: 'proj-one', displayName: 'Project One' },
            { projectId: 'proj-two', displayName: 'Project Two' },
          ],
        }
      }
      return {}
    })

    const { result } = renderGoogleAuth({
      id: 'gcp',
      detectCredentials: false,
      oauthClientId: 'custom.apps.googleusercontent.com',
      oauthClientSecret: 'not-confidential',
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    })

    await act(async () => {
      await result.current.handleOAuthLogin()
    })
    await waitFor(() => expect(result.current.authStatus).toBe('select_project'))

    expect(invoke).toHaveBeenCalledWith('google:oauth-start', {
      clientId: 'custom.apps.googleusercontent.com',
      clientSecret: 'not-confidential',
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    })
    expect(result.current.projects).toHaveLength(2)
    expectNoAuthenticatedPublish(registerOutputs)
  })

  it('cancelling releases the loopback listener in MAIN', async () => {
    const invoke = installApi((channel) => {
      if (channel === 'google:oauth-start') {
        return { flowId: 'flow-3', authUrl: 'https://accounts.google.com/o/oauth2/v2/auth' }
      }
      if (channel === 'google:oauth-poll') return { status: 'pending' }
      return {}
    })

    const { result } = renderGoogleAuth({ id: 'gcp', detectCredentials: false })

    await act(async () => {
      await result.current.handleOAuthLogin()
    })
    expect(result.current.authStatus).toBe('authenticating')
    expect(result.current.oauthFlowId).toBe('flow-3')

    await act(async () => {
      result.current.handleCancelOAuth()
    })

    expect(invoke).toHaveBeenCalledWith('google:oauth-cancel', { flowId: 'flow-3' })
    expect(result.current.authStatus).toBe('pending')
    expect(result.current.oauthFlowId).toBeNull()
  })

  it('marks OAuth unavailable ON MOUNT from the capability probe', async () => {
    const invoke = installApi((channel) =>
      channel === 'google:oauth-available' ? { available: false } : {},
    )

    const { result } = renderGoogleAuth({ id: 'gcp', detectCredentials: false })

    // No click required: the tab is known to be dead before it is offered.
    await waitFor(() => expect(result.current.oauthUnavailable).toBe(true))
    expect(callsTo(invoke, 'google:oauth-start')).toHaveLength(0)
    expect(result.current.authStatus).toBe('pending')
    expect(result.current.errorMessage).toBeNull()
  })

  it('treats an author-supplied client id as available without a round trip', async () => {
    const invoke = installApi((channel) =>
      channel === 'google:oauth-available' ? { available: false } : {},
    )

    const { result } = renderGoogleAuth({
      id: 'gcp',
      detectCredentials: false,
      oauthClientId: 'custom.apps.googleusercontent.com',
      oauthClientSecret: 'not-confidential',
    })

    await act(async () => {})
    expect(result.current.oauthUnavailable).toBe(false)
    expect(callsTo(invoke, 'google:oauth-available')).toHaveLength(0)
  })

  it('treats an author-supplied oauthClientFile as available without a round trip', async () => {
    const invoke = installApi((channel) =>
      channel === 'google:oauth-available' ? { available: false } : {},
    )

    const { result } = renderGoogleAuth({
      id: 'gcp',
      detectCredentials: false,
      oauthClientFile: '~/.config/gcloud/client_secret_example.json',
    })

    await act(async () => {})
    expect(result.current.oauthUnavailable).toBe(false)
    expect(callsTo(invoke, 'google:oauth-available')).toHaveLength(0)
  })

  it('sends oauthClientFile to MAIN on sign-in start', async () => {
    const invoke = installApi((channel) => {
      if (channel === 'google:oauth-start') {
        return {
          flowId: 'flow-file',
          authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        }
      }
      if (channel === 'google:oauth-poll') {
        return { status: 'pending' }
      }
      return {}
    })

    const { result } = renderGoogleAuth({
      id: 'gcp',
      detectCredentials: false,
      oauthClientFile: '~/.config/gcloud/client_secret_example.json',
    })

    await act(async () => {
      await result.current.handleOAuthLogin()
    })

    expect(invoke).toHaveBeenCalledWith('google:oauth-start', {
      clientFile: '~/.config/gcloud/client_secret_example.json',
    })
  })

  it('lets the operator pick a Desktop OAuth client JSON when none is configured', async () => {
    const invoke = installApi((channel) => {
      if (channel === 'google:oauth-available') return { available: false }
      if (channel === 'native:show-open-dialog') {
        return { filePaths: ['/tmp/client_secret_example.apps.googleusercontent.com.json'] }
      }
      if (channel === 'google:oauth-start') {
        return {
          flowId: 'flow-picked',
          authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        }
      }
      if (channel === 'google:oauth-poll') return { status: 'pending' }
      return {}
    })

    const { result } = renderGoogleAuth({ id: 'gcp', detectCredentials: false })

    await waitFor(() => expect(result.current.oauthUnavailable).toBe(true))

    await act(async () => {
      await result.current.loadOAuthClientFromFile()
    })

    expect(result.current.oauthUnavailable).toBe(false)
    expect(result.current.oauthClientFileName).toBe(
      'client_secret_example.apps.googleusercontent.com.json',
    )
    expect(result.current.oauthClientFilePath).toBe(
      '/tmp/client_secret_example.apps.googleusercontent.com.json',
    )

    await act(async () => {
      await result.current.handleOAuthLogin()
    })

    expect(invoke).toHaveBeenCalledWith('google:oauth-start', {
      clientFile: '/tmp/client_secret_example.apps.googleusercontent.com.json',
    })
  })

  it('releases the loopback listener when the poll loop gives up', async () => {
    const invoke = installApi((channel) => {
      if (channel === 'google:oauth-start') {
        return { flowId: 'flow-9', authUrl: 'https://accounts.google.com/o/oauth2/v2/auth' }
      }
      if (channel === 'google:oauth-poll') return { status: 'failed', error: 'Sign-in was denied' }
      return {}
    })

    const { result } = renderGoogleAuth({ id: 'gcp', detectCredentials: false })

    await act(async () => {
      await result.current.handleOAuthLogin()
    })
    await waitFor(() => expect(result.current.authStatus).toBe('failed'))

    // A terminal failure must not strand MAIN's 127.0.0.1 listener — nor the
    // refresh token a late consent would deposit behind it.
    expect(invoke).toHaveBeenCalledWith('google:oauth-cancel', { flowId: 'flow-9' })
  })

  it('"Try auto-detection again" cancels an in-flight sign-in', async () => {
    const invoke = installApi((channel) => {
      if (channel === 'google:oauth-start') {
        return { flowId: 'flow-10', authUrl: 'https://accounts.google.com/o/oauth2/v2/auth' }
      }
      if (channel === 'google:oauth-poll') return { status: 'pending' }
      return { found: false }
    })

    const { result } = renderGoogleAuth({ id: 'gcp', detectCredentials: ['env'] })
    await waitFor(() => expect(result.current.detectionStatus).toBe('done'))

    await act(async () => {
      await result.current.handleOAuthLogin()
    })
    expect(result.current.oauthFlowId).toBe('flow-10')

    // The retry link unmounts the whole form subtree — including the flow's own
    // Cancel button — so it has to release the flow itself.
    await act(async () => {
      result.current.handleRetryDetection()
    })

    expect(invoke).toHaveBeenCalledWith('google:oauth-cancel', { flowId: 'flow-10' })
    expect(result.current.oauthFlowId).toBeNull()
  })

  it('marks OAuth unavailable when the build has no registered client', async () => {
    installApi((channel) =>
      channel === 'google:oauth-start'
        ? { error: 'OAuth login is not configured for this build' }
        : {},
    )

    const { result } = renderGoogleAuth({ id: 'gcp', detectCredentials: false })

    await act(async () => {
      await result.current.handleOAuthLogin()
    })

    expect(result.current.oauthUnavailable).toBe(true)
    expect(result.current.authStatus).toBe('failed')
    expect(result.current.errorMessage).toBe('OAuth login is not configured for this build')
  })

  it('reports an expired authorization request inline', async () => {
    installApi((channel) => {
      if (channel === 'google:oauth-start') {
        return { flowId: 'flow-4', authUrl: 'https://accounts.google.com/o/oauth2/v2/auth' }
      }
      if (channel === 'google:oauth-poll') return { status: 'expired' }
      return {}
    })

    const { result } = renderGoogleAuth({ id: 'gcp', detectCredentials: false })

    await act(async () => {
      await result.current.handleOAuthLogin()
    })

    await waitFor(() => expect(result.current.authStatus).toBe('failed'))
    expect(result.current.errorMessage).toBe('Authorization request expired. Please try again.')
    expect(result.current.oauthFlowId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Tab 3 — gcloud configuration
// ---------------------------------------------------------------------------

const GCLOUD_LISTING = {
  configurations: [
    {
      name: 'default',
      isActive: true,
      account: 'dev@example.com',
      project: 'proj-a',
      region: 'us-east1',
      authType: 'adc-user',
    },
    { name: 'staging', isActive: false, project: 'proj-s', authType: 'config-only' },
  ],
  activeConfiguration: 'default',
  configRoot: '/home/u/.config/gcloud',
  adc: {
    path: '/home/u/.config/gcloud/application_default_credentials.json',
    type: 'authorized_user',
    clientEmail: 'dev@example.com',
  },
}

describe('useGoogleAuth — gcloud tab', () => {
  it('lists configurations from disk and preselects the active usable one', async () => {
    installApi((channel) => (channel === 'google:gcloud-configurations' ? GCLOUD_LISTING : {}))

    const { result } = renderGoogleAuth({ id: 'gcp', detectCredentials: false })

    await act(async () => {
      await result.current.loadGcloudConfigs()
    })

    expect(result.current.gcloudConfigs).toHaveLength(2)
    expect(result.current.selectedConfig?.name).toBe('default')
    expect(result.current.gcloudConfigRoot).toBe('/home/u/.config/gcloud')
    expect(result.current.adcInfo?.clientEmail).toBe('dev@example.com')
  })

  it('honours the gcloudConfiguration prop and authenticates against the existing ADC', async () => {
    const invoke = installApi((channel) => {
      if (channel === 'google:gcloud-configurations') {
        return {
          ...GCLOUD_LISTING,
          configurations: [
            ...GCLOUD_LISTING.configurations,
            { name: 'prod', isActive: false, account: 'ops@example.com', project: 'proj-p', authType: 'adc-service-account' },
          ],
        }
      }
      if (channel === 'google:gcloud-auth') {
        return {
          valid: true,
          account: { principal: 'ops@example.com', accountType: 'service_account' },
          projectId: 'proj-p',
          credentialsPath: '/home/u/.config/gcloud/application_default_credentials.json',
        }
      }
      if (channel === 'google:check-project') return { enabled: true }
      return {}
    })

    const { result } = renderGoogleAuth({
      id: 'gcp',
      gcloudConfiguration: 'prod',
      detectCredentials: false,
    })

    await act(async () => {
      await result.current.loadGcloudConfigs()
    })
    expect(result.current.selectedConfig?.name).toBe('prod')

    await act(async () => {
      await result.current.handleGcloudAuth()
    })

    expect(invoke).toHaveBeenCalledWith('google:gcloud-auth', {
      blockId: 'gcp',
      configuration: 'prod',
      projectId: 'proj-p',
    })
    expect(result.current.authStatus).toBe('authenticated')
    expect(registerOutputs).toHaveBeenCalledWith(
      'gcp',
      outputs({
        GOOGLE_APPLICATION_CREDENTIALS: '/home/u/.config/gcloud/application_default_credentials.json',
        CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: '/home/u/.config/gcloud/application_default_credentials.json',
        GOOGLE_CLOUD_PROJECT: 'proj-p',
        CLOUDSDK_CORE_PROJECT: 'proj-p',
        GOOGLE_PROJECT: 'proj-p',
        CLOUDSDK_CORE_ACCOUNT: 'ops@example.com',
        GOOGLE_AUTH_TYPE: 'service_account',
      }),
    )
  })

  it('routes to the project picker when the configuration sets no core/project', async () => {
    const invoke = installApi((channel) => {
      if (channel === 'google:gcloud-configurations') {
        return {
          ...GCLOUD_LISTING,
          configurations: [
            {
              name: 'scratch',
              isActive: true,
              account: 'dev@example.com',
              region: 'us-east1',
              authType: 'adc-user',
            },
          ],
        }
      }
      if (channel === 'google:gcloud-auth') {
        // No projectId: `gcloud config configurations create scratch` without a
        // `core/project`, and no `project` prop to fall back on.
        return {
          valid: true,
          account: { principal: 'dev@example.com', accountType: 'user' },
          credentialsPath: '/home/u/.config/gcloud/application_default_credentials.json',
          projects: [
            { projectId: 'proj-one', displayName: 'Project One' },
            { projectId: 'proj-two', displayName: 'Project Two' },
          ],
        }
      }
      if (channel === 'google:set-project') return { ok: true, projectName: 'Project Two' }
      if (channel === 'google:check-project') return { enabled: true }
      return {}
    })

    const { result } = renderGoogleAuth({ id: 'gcp', detectCredentials: false })

    await act(async () => {
      await result.current.loadGcloudConfigs()
    })
    await act(async () => {
      await result.current.handleGcloudAuth()
    })

    // NOT 'authenticated' with a blank project: the user picks one first.
    expect(result.current.authStatus).toBe('select_project')
    expect(result.current.projects).toHaveLength(2)
    expectNoAuthenticatedPublish(registerOutputs)
    expect(callsTo(invoke, 'google:set-project')).toHaveLength(0)

    await act(async () => {
      await result.current.handleProjectSelect({ projectId: 'proj-two', displayName: 'Project Two' })
    })

    // The configuration's own compute/region survives the picker detour.
    expect(invoke).toHaveBeenCalledWith('google:set-project', {
      blockId: 'gcp',
      projectId: 'proj-two',
      region: 'us-east1',
    })
    expect(result.current.authStatus).toBe('authenticated')
  })

  it('auto-selects the single visible project when the configuration sets none', async () => {
    const invoke = installApi((channel) => {
      if (channel === 'google:gcloud-configurations') {
        return {
          ...GCLOUD_LISTING,
          configurations: [
            { name: 'scratch', isActive: true, account: 'dev@example.com', authType: 'adc-user' },
          ],
        }
      }
      if (channel === 'google:gcloud-auth') {
        return {
          valid: true,
          account: { principal: 'dev@example.com', accountType: 'user' },
          credentialsPath: '/home/u/.config/gcloud/application_default_credentials.json',
          projects: [{ projectId: 'proj-solo', displayName: 'Solo Project' }],
        }
      }
      if (channel === 'google:set-project') return { ok: true, projectName: 'Solo Project' }
      if (channel === 'google:check-project') return { enabled: true }
      return {}
    })

    const { result } = renderGoogleAuth({ id: 'gcp', detectCredentials: false })

    await act(async () => {
      await result.current.loadGcloudConfigs()
    })
    await act(async () => {
      await result.current.handleGcloudAuth()
    })

    expect(result.current.authStatus).toBe('authenticated')
    expect(invoke).toHaveBeenCalledWith('google:set-project', {
      blockId: 'gcp',
      projectId: 'proj-solo',
    })
    expect(registerOutputs).toHaveBeenCalledWith(
      'gcp',
      outputs({
        GOOGLE_APPLICATION_CREDENTIALS: '/home/u/.config/gcloud/application_default_credentials.json',
        CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: '/home/u/.config/gcloud/application_default_credentials.json',
        GOOGLE_CLOUD_PROJECT: 'proj-solo',
        CLOUDSDK_CORE_PROJECT: 'proj-solo',
        GOOGLE_PROJECT: 'proj-solo',
        CLOUDSDK_CORE_ACCOUNT: 'dev@example.com',
        GOOGLE_AUTH_TYPE: 'authorized_user',
      }),
    )
  })

  it('says so out loud when it authenticates with no project at all', async () => {
    installApi((channel) => {
      if (channel === 'google:gcloud-configurations') {
        return {
          ...GCLOUD_LISTING,
          configurations: [
            { name: 'scratch', isActive: true, account: 'dev@example.com', authType: 'adc-user' },
          ],
        }
      }
      if (channel === 'google:gcloud-auth') {
        // Authenticated, no project, and the principal cannot enumerate any.
        return {
          valid: true,
          account: { principal: 'dev@example.com', accountType: 'user' },
          credentialsPath: '/home/u/.config/gcloud/application_default_credentials.json',
        }
      }
      return {}
    })

    const { result } = renderGoogleAuth({ id: 'gcp', detectCredentials: false })

    await act(async () => {
      await result.current.loadGcloudConfigs()
    })
    await act(async () => {
      await result.current.handleGcloudAuth()
    })

    expect(result.current.authStatus).toBe('authenticated')
    // The green card must not silently claim readiness with a blank project.
    expect(result.current.warningMessage).toMatch(/no Google Cloud project is set/)
    expect(registerOutputs).toHaveBeenCalledWith('gcp', outputs({
      GOOGLE_APPLICATION_CREDENTIALS: '/home/u/.config/gcloud/application_default_credentials.json',
      CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: '/home/u/.config/gcloud/application_default_credentials.json',
      CLOUDSDK_CORE_ACCOUNT: 'dev@example.com',
      GOOGLE_AUTH_TYPE: 'authorized_user',
    }))
  })

  it('refuses a configuration with no Application Default Credentials', async () => {
    const invoke = installApi((channel) =>
      channel === 'google:gcloud-configurations' ? GCLOUD_LISTING : {},
    )

    const { result } = renderGoogleAuth({ id: 'gcp', detectCredentials: false })

    await act(async () => {
      await result.current.loadGcloudConfigs()
    })
    act(() =>
      result.current.setSelectedConfig({
        name: 'staging',
        isActive: false,
        project: 'proj-s',
        authType: 'config-only',
      }),
    )

    await act(async () => {
      await result.current.handleGcloudAuth()
    })

    expect(result.current.authStatus).toBe('failed')
    expect(result.current.errorMessage).toBe(
      'Configuration found, but no Application Default Credentials — run `gcloud auth application-default login`.',
    )
    expect(invoke).not.toHaveBeenCalledWith('google:gcloud-auth', expect.anything())
  })
})

// ---------------------------------------------------------------------------
// Post-auth
// ---------------------------------------------------------------------------

describe('useGoogleAuth — post-authentication', () => {
  it('surfaces a project-access warning without failing the auth', async () => {
    installApi((channel) => {
      if (channel === 'google:validate-credentials') {
        return {
          valid: true,
          account: { principal: 'sa@key-project.iam.gserviceaccount.com', accountType: 'service_account' },
          projectId: 'proj-x',
          credentialType: 'service_account',
          credentialsPath: '/tmp/runbooks-gcp-6/adc.json',
        }
      }
      if (channel === 'google:check-project') {
        return { enabled: false, warning: 'This credential cannot read project "proj-x"' }
      }
      return {}
    })

    const { result } = renderGoogleAuth({ id: 'gcp', project: 'proj-x', detectCredentials: false })

    act(() => result.current.setServiceAccountKey(SA_KEY))
    await act(async () => {
      result.current.handleServiceAccountSubmit()
    })

    await waitFor(() => expect(result.current.authStatus).toBe('authenticated'))
    expect(result.current.warningMessage).toBe('This credential cannot read project "proj-x"')
  })

  it('"Change project" loads the picker when the list is empty', async () => {
    const invoke = installApi((channel) => {
      if (channel === 'google:projects') {
        return { projects: [{ projectId: 'proj-one', displayName: 'Project One' }] }
      }
      return {}
    })

    const { result } = renderGoogleAuth({ id: 'gcp', detectCredentials: false })

    await act(async () => {
      await result.current.handleChangeProject()
    })

    expect(result.current.authStatus).toBe('select_project')
    expect(invoke).toHaveBeenCalledWith('google:projects', { blockId: 'gcp' })
    expect(result.current.projects).toHaveLength(1)
  })

  it('re-authenticating clears the account, the projects, and the detection state', async () => {
    installApi((channel) => {
      if (channel === 'google:validate-credentials') {
        return {
          valid: true,
          account: { principal: 'sa@key-project.iam.gserviceaccount.com', accountType: 'service_account' },
          projectId: 'proj-x',
          credentialType: 'service_account',
          credentialsPath: '/tmp/runbooks-gcp-7/adc.json',
        }
      }
      return {}
    })

    const { result } = renderGoogleAuth({ id: 'gcp', project: 'proj-x', detectCredentials: false })

    act(() => result.current.setServiceAccountKey(SA_KEY))
    await act(async () => {
      result.current.handleServiceAccountSubmit()
    })
    await waitFor(() => expect(result.current.authStatus).toBe('authenticated'))

    act(() => result.current.handleManualAuth())

    expect(result.current.authStatus).toBe('pending')
    expect(result.current.accountInfo).toBeNull()
    expect(result.current.projects).toEqual([])
    expect(result.current.detectedCredentials).toBeNull()
    expect(result.current.detectionStatus).toBe('done')
  })

  it('re-authenticating WITHDRAWS the published credential path, not just the card', async () => {
    // The regression. The card going blue used to leave the block's outputs
    // standing, so a `<Command googleAuthId>` kept injecting
    // GOOGLE_APPLICATION_CREDENTIALS for a file MAIN released the moment the
    // next sign-in materialised its replacement — and because the Run button
    // reads `__AUTHENTICATED`, it stayed enabled the whole time. gcloud then
    // failed with "Failed to load credential file … was not found".
    installApi((channel) => {
      if (channel === 'google:validate-credentials') {
        return {
          valid: true,
          account: { principal: 'sa@key-project.iam.gserviceaccount.com', accountType: 'service_account' },
          projectId: 'proj-x',
          credentialType: 'service_account',
          credentialsPath: '/tmp/runbooks-gcp-A7oaHl/adc.json',
        }
      }
      return {}
    })

    const { result } = renderGoogleAuth({ id: 'gcp', project: 'proj-x', detectCredentials: false })

    act(() => result.current.setServiceAccountKey(SA_KEY))
    await act(async () => {
      result.current.handleServiceAccountSubmit()
    })
    await waitFor(() => expect(result.current.authStatus).toBe('authenticated'))
    expect(registerOutputs).toHaveBeenLastCalledWith(
      'gcp',
      expect.objectContaining({
        GOOGLE_APPLICATION_CREDENTIALS: '/tmp/runbooks-gcp-A7oaHl/adc.json',
        __AUTHENTICATED: 'true',
      }),
    )

    act(() => result.current.handleManualAuth())

    // The path is gone from the outputs, and the marker that gates the Run
    // button went with it.
    expect(registerOutputs).toHaveBeenLastCalledWith('gcp', { __AUTHENTICATED: 'false' })
  })

  it('tells MAIN which credential it committed, so the superseded file can be zeroed', async () => {
    const invoke = installApi((channel) => {
      if (channel === 'google:validate-credentials') {
        return {
          valid: true,
          account: { principal: 'sa@key-project.iam.gserviceaccount.com', accountType: 'service_account' },
          projectId: 'proj-x',
          credentialType: 'service_account',
          credentialsPath: '/tmp/runbooks-gcp-4gUk0g/adc.json',
        }
      }
      return {}
    })

    const { result } = renderGoogleAuth({ id: 'gcp', project: 'proj-x', detectCredentials: false })

    act(() => result.current.setServiceAccountKey(SA_KEY))
    await act(async () => {
      result.current.handleServiceAccountSubmit()
    })
    await waitFor(() => expect(result.current.authStatus).toBe('authenticated'))

    expect(callsTo(invoke, 'google:credential-committed')).toEqual([
      [
        'google:credential-committed',
        { blockId: 'gcp', credentialsPath: '/tmp/runbooks-gcp-4gUk0g/adc.json' },
      ],
    ])
  })
})

// Which tab the block opens on. Decided once, at mount, from the author's
// `defaultTab`; the user's tab clicks own it from then on.
describe('useGoogleAuth — defaultTab', () => {
  const renderWithTab = (defaultTab?: string) => {
    installApi(() => ({}))
    return renderGoogleAuth({ id: 'gcp', detectCredentials: false, defaultTab })
  }

  it('opens on the Service Account Key tab when no defaultTab is set', () => {
    expect(renderWithTab().result.current.authMethod).toBe('service_account')
  })

  it('opens on the tab the author asked for', () => {
    expect(renderWithTab('oauth').result.current.authMethod).toBe('oauth')
    expect(renderWithTab('gcloud').result.current.authMethod).toBe('gcloud')
  })

  it('falls back to the Service Account Key tab for an unrecognized tab name', () => {
    // MDX props are untyped, so a typo must not leave the block formless.
    expect(renderWithTab('sign-in').result.current.authMethod).toBe('service_account')
  })
})
