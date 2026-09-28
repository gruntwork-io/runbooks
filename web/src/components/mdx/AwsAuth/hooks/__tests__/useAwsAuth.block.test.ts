import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderHook, act, waitFor } from '@testing-library/react'
import { ApiProvider } from '@/contexts/ApiContext'
import { useAwsAuth } from '../useAwsAuth'

/**
 * Detection from a `{ block }` source and the confirm step that follows it. The
 * block's outputs are ambient runbook state, changed between renders the way a
 * Command re-run changes them; aws:validate answers per access key, so a test
 * decides which account each set of keys belongs to. The IPC surface is the
 * only boundary faked (through the real ApiProvider).
 */

const registerOutputs = vi.fn()
const runbookState: { blockOutputs: Record<string, { values: Record<string, string> }> } = {
  blockOutputs: {},
}

vi.mock('@/contexts/useRunbook', () => ({
  useRunbookContext: () => ({ registerOutputs, blockOutputs: runbookState.blockOutputs }),
}))
vi.mock('@/contexts/useSession', () => ({
  useSession: () => ({ isReady: true }),
}))

type Api = Parameters<typeof ApiProvider>[0]['api']
type Params = Record<string, unknown>
type Reply = Record<string, unknown>

const ACCOUNT_A = {
  accountId: '111111111111',
  accountName: 'staging',
  arn: 'arn:aws:sts::111111111111:assumed-role/Deploy/run-1',
}
const ACCOUNT_B = {
  accountId: '222222222222',
  accountName: 'prod',
  arn: 'arn:aws:sts::222222222222:assumed-role/Deploy/run-2',
}

/** What aws:validate says about each access key; anything else is invalid. */
let identities: Record<string, Reply>
let currentApi: Api
let invoke: ReturnType<typeof vi.fn>

function installApi(handlers: Record<string, (params: Params) => unknown> = {}) {
  const all: Record<string, (params: Params) => unknown> = {
    'aws:validate': (p) => {
      const identity = identities[p.accessKeyId as string]
      return identity ? { valid: true, ...identity } : { valid: false, error: 'The security token included in the request is expired' }
    },
    'aws:env-credentials': () => ({ found: false }),
    'session:set-env': () => ({ ok: true }),
    'aws:check-region': () => ({ enabled: true }),
    ...handlers,
  }
  invoke = vi.fn(async (channel: string, params: Params) => {
    const handler = all[channel]
    if (!handler) throw new Error(`unexpected channel ${channel}`)
    return handler(params)
  })
  currentApi = { invoke, on: () => () => {}, once: () => {} } as unknown as Api
}

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(ApiProvider, { api: currentApi, children })

const renderAwsAuth = (detectCredentials: Parameters<typeof useAwsAuth>[0]['detectCredentials']) =>
  renderHook(
    () =>
      useAwsAuth({
        id: 'aws',
        ssoRegion: 'us-east-1',
        defaultRegion: 'us-west-2',
        detectCredentials,
      }),
    { wrapper },
  )

/**
 * The source block (re-)runs and publishes these outputs. The runbook context
 * keys outputs by normalized id, so `assume-role` lands under `assume_role`.
 */
function blockOutputs(values: Record<string, string>) {
  runbookState.blockOutputs = { assume_role: { values } }
}

const KEYS_A = {
  AWS_ACCESS_KEY_ID: 'ASIA_A',
  AWS_SECRET_ACCESS_KEY: 'secret-a',
  AWS_SESSION_TOKEN: 'token-a',
  AWS_REGION: 'eu-west-1',
}

const channelsCalled = () => invoke.mock.calls.map(([channel]) => channel)

beforeEach(() => {
  registerOutputs.mockClear()
  runbookState.blockOutputs = {}
  identities = { ASIA_A: ACCOUNT_A }
  installApi()
})

describe('useAwsAuth — { block } detection', () => {
  it('waits for a block that has not run, then prompts with the account its keys validate to', async () => {
    const { result, rerender } = renderAwsAuth([{ block: 'assume-role' }, 'env'])

    // The author listed the block first, so env is not tried while it is pending.
    await waitFor(() => expect(result.current.waitingForBlockId).toBe('assume-role'))
    expect(result.current.detectionStatus).toBe('pending')
    expect(channelsCalled()).not.toContain('aws:env-credentials')

    blockOutputs(KEYS_A)
    rerender()

    await waitFor(() => expect(result.current.detectionStatus).toBe('detected'))
    expect(invoke).toHaveBeenCalledWith('aws:validate', {
      accessKeyId: 'ASIA_A',
      secretAccessKey: 'secret-a',
      sessionToken: 'token-a',
      region: 'eu-west-1',
    })
    expect(result.current.detectedCredentials).toEqual({
      ...ACCOUNT_A,
      region: 'eu-west-1',
      source: 'block',
      hasSessionToken: true,
    })
    expect(result.current.waitingForBlockId).toBeNull()
    expect(channelsCalled()).not.toContain('aws:env-credentials')
    // Detection is read-only: nothing is published until the user confirms.
    expect(registerOutputs).not.toHaveBeenCalled()
  })

  it('falls back to the next source once the block runs without AWS keys', async () => {
    installApi({
      'aws:env-credentials': () => ({
        found: true,
        valid: true,
        ...ACCOUNT_B,
        region: 'us-west-2',
        hasSessionToken: false,
      }),
    })
    const { result, rerender } = renderAwsAuth([{ block: 'assume-role' }, 'env'])
    await waitFor(() => expect(result.current.waitingForBlockId).toBe('assume-role'))

    blockOutputs({ ROLE_NAME: 'Deploy' })
    rerender()

    await waitFor(() => expect(result.current.detectionStatus).toBe('detected'))
    expect(result.current.detectedCredentials?.source).toBe('env')
    expect(result.current.detectedCredentials?.accountId).toBe(ACCOUNT_B.accountId)
    expect(result.current.waitingForBlockId).toBeNull()
    expect(channelsCalled()).not.toContain('aws:validate')
  })
})

describe('useAwsAuth — confirming { block } credentials', () => {
  /** Detect KEYS_A from the block; the prompt names account A. */
  async function detectAccountA() {
    blockOutputs(KEYS_A)
    const hook = renderAwsAuth([{ block: 'assume-role' }])
    await waitFor(() => expect(hook.result.current.detectionStatus).toBe('detected'))
    expect(hook.result.current.detectedCredentials?.accountId).toBe(ACCOUNT_A.accountId)
    return hook
  }

  it('re-validates at confirm and publishes the keys it validated', async () => {
    const { result } = await detectAccountA()
    invoke.mockClear()

    await act(() => result.current.handleConfirmDetected())

    expect(channelsCalled()[0]).toBe('aws:validate')
    expect(result.current.authStatus).toBe('authenticated')
    expect(result.current.accountInfo).toEqual(ACCOUNT_A)
    expect(registerOutputs).toHaveBeenCalledWith('aws', {
      AWS_ACCESS_KEY_ID: 'ASIA_A',
      AWS_SECRET_ACCESS_KEY: 'secret-a',
      AWS_REGION: 'eu-west-1',
      AWS_SESSION_TOKEN: 'token-a',
    })
  })

  it('asks again, publishing nothing, when the block re-ran into a different account', async () => {
    const { result, rerender } = await detectAccountA()

    // The Command re-runs with another account's role while the prompt is open.
    identities.ASIA_B = ACCOUNT_B
    blockOutputs({ ...KEYS_A, AWS_ACCESS_KEY_ID: 'ASIA_B', AWS_SECRET_ACCESS_KEY: 'secret-b' })
    rerender()

    await act(() => result.current.handleConfirmDetected())

    expect(registerOutputs).not.toHaveBeenCalled()
    expect(channelsCalled()).not.toContain('session:set-env')
    expect(result.current.authStatus).toBe('pending')
    expect(result.current.accountInfo).toBeNull()
    expect(result.current.detectionStatus).toBe('detected')
    expect(result.current.detectedCredentials).toEqual({
      ...ACCOUNT_B,
      region: 'eu-west-1',
      source: 'block',
      hasSessionToken: true,
    })

    // The prompt now names account B; confirming it publishes B.
    await act(() => result.current.handleConfirmDetected())

    expect(result.current.authStatus).toBe('authenticated')
    expect(result.current.accountInfo).toEqual(ACCOUNT_B)
    expect(registerOutputs).toHaveBeenCalledWith('aws', expect.objectContaining({ AWS_ACCESS_KEY_ID: 'ASIA_B' }))
  })

  it('publishes the new keys when the block re-ran into the same account', async () => {
    const { result, rerender } = await detectAccountA()

    // STS hands out new keys on every run; same account, new session name.
    const ACCOUNT_A_RUN_2 = { ...ACCOUNT_A, arn: 'arn:aws:sts::111111111111:assumed-role/Deploy/run-2' }
    identities.ASIA_A2 = ACCOUNT_A_RUN_2
    blockOutputs({ ...KEYS_A, AWS_ACCESS_KEY_ID: 'ASIA_A2', AWS_SECRET_ACCESS_KEY: 'secret-a2', AWS_SESSION_TOKEN: 'token-a2' })
    rerender()

    await act(() => result.current.handleConfirmDetected())

    expect(result.current.authStatus).toBe('authenticated')
    expect(result.current.accountInfo).toEqual(ACCOUNT_A_RUN_2)
    expect(registerOutputs).toHaveBeenCalledTimes(1)
    expect(registerOutputs).toHaveBeenCalledWith('aws', {
      AWS_ACCESS_KEY_ID: 'ASIA_A2',
      AWS_SECRET_ACCESS_KEY: 'secret-a2',
      AWS_REGION: 'eu-west-1',
      AWS_SESSION_TOKEN: 'token-a2',
    })
  })

  it('fails without publishing anything when the keys no longer validate', async () => {
    const { result } = await detectAccountA()

    // The block's temporary credentials expired while the prompt was open.
    delete identities.ASIA_A

    await act(() => result.current.handleConfirmDetected())

    expect(result.current.authStatus).toBe('failed')
    expect(result.current.errorMessage).toBe('The security token included in the request is expired')
    expect(result.current.accountInfo).toBeNull()
    expect(registerOutputs).not.toHaveBeenCalled()
    expect(channelsCalled()).not.toContain('session:set-env')
  })
})
