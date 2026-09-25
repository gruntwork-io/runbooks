import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderHook, act } from '@testing-library/react'
import { ApiProvider } from '@/contexts/ApiContext'
import { useAwsAuth } from '../useAwsAuth'

/**
 * The SSO device flow, driven by replies in the shape MAIN's aws:sso-poll /
 * aws:sso-roles handlers return (pinned on that side by
 * electron/main/ipc/aws-sso.test.ts), and the poll loop's lifecycle: a loop
 * belongs to one sign-in attempt, and cancel, restart, re-auth, retry and
 * unmount all end it for good. The IPC surface is the only boundary faked
 * (through the real ApiProvider); timers are fake so the 2s poll interval and
 * the 2-minute limit run instantly.
 */

const registerOutputs = vi.fn()

vi.mock('@/contexts/useRunbook', () => ({
  useRunbookContext: () => ({ registerOutputs, blockOutputs: {} }),
}))
vi.mock('@/contexts/useSession', () => ({
  useSession: () => ({ isReady: true }),
}))

type Api = Parameters<typeof ApiProvider>[0]['api']
type Params = Record<string, unknown>
type Handler = (params: Params) => unknown

const SSO_REGION = 'eu-central-1'
const ACCOUNTS = [
  { accountId: '111111111111', accountName: 'prod', emailAddress: 'prod@example.com' },
  { accountId: '222222222222', accountName: 'dev', emailAddress: 'dev@example.com' },
]
const IDENTITY = {
  accountId: '111111111111',
  accountName: 'prod',
  arn: 'arn:aws:sts::111111111111:assumed-role/Admin/me',
}
const ROLE_KEYS = { accessKeyId: 'ASIA_ROLE', secretAccessKey: 'role-secret', sessionToken: 'role-token' }
const SUCCESS = { status: 'success', ...IDENTITY, ...ROLE_KEYS }
const PENDING = { status: 'pending' }

/** An aws:sso-start reply; each attempt gets its own device code. */
const deviceFlow = (deviceCode: string) => ({
  verificationUri: `https://device.sso.example/${deviceCode}`,
  userCode: 'ABCD-EFGH',
  deviceCode,
  clientId: 'cid',
  clientSecret: 'csecret',
})

/** Starts D1, D2, ... in order. */
const startsInOrder = (): Handler => {
  let n = 0
  return () => deviceFlow(`D${++n}`)
}

let currentApi: Api
let invoke: ReturnType<typeof vi.fn>

function installApi(handlers: Record<string, Handler>) {
  const all: Record<string, Handler> = {
    'aws:sso-start': startsInOrder(),
    'aws:sso-poll': () => PENDING,
    'session:set-env': () => ({}),
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

/** A promise the test settles by hand, to hold an IPC call in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(ApiProvider, { api: currentApi, children })

const renderSso = (props: { ssoAccountId?: string; ssoRoleName?: string } = {}) =>
  renderHook(
    () =>
      useAwsAuth({
        id: 'aws',
        ssoStartUrl: 'https://acme.awsapps.com/start',
        ssoRegion: SSO_REGION,
        defaultRegion: 'us-west-2',
        detectCredentials: false,
        ...props,
      }),
    { wrapper },
  )

/** Let `ms` of poll interval pass, settling every IPC reply along the way. */
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

const polledDeviceCodes = () =>
  invoke.mock.calls.filter(([channel]) => channel === 'aws:sso-poll').map(([, params]) => params.deviceCode)

const channelsCalled = () => invoke.mock.calls.map(([channel]) => channel)

let openSpy: MockInstance<typeof window.open>

beforeEach(() => {
  vi.useFakeTimers()
  registerOutputs.mockClear()
  openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
})

afterEach(() => {
  openSpy.mockRestore()
  vi.useRealTimers()
})

describe('useAwsAuth — SSO sign-in', () => {
  it('polls through pending, lets the user pick an account and role, then publishes the keys', async () => {
    let polls = 0
    installApi({
      'aws:sso-poll': () =>
        ++polls < 3 ? PENDING : { status: 'select_account', accessToken: 'sso-token', accounts: ACCOUNTS },
      'aws:sso-roles': () => ({ roles: [{ roleName: 'ReadOnly' }, { roleName: 'Admin' }] }),
      'aws:sso-complete': () => ({ ...IDENTITY, ...ROLE_KEYS }),
    })
    const { result } = renderSso()

    await act(() => result.current.handleSsoAuth())

    expect(openSpy).toHaveBeenCalledWith('https://device.sso.example/D1', '_blank')
    expect(result.current.authStatus).toBe('authenticating')
    expect(invoke).toHaveBeenCalledWith('aws:sso-poll', {
      deviceCode: 'D1',
      clientId: 'cid',
      clientSecret: 'csecret',
      region: SSO_REGION,
      accountId: undefined,
      roleName: undefined,
    })

    await advance(2000)
    expect(result.current.authStatus).toBe('authenticating')
    await advance(2000)
    expect(result.current.authStatus).toBe('select_account')
    expect(result.current.ssoAccounts).toEqual(ACCOUNTS)

    await act(() => result.current.handleSsoAccountSelect(ACCOUNTS[0]))
    expect(invoke).toHaveBeenCalledWith('aws:sso-roles', {
      accessToken: 'sso-token',
      accountId: '111111111111',
      region: SSO_REGION,
    })
    expect(result.current.authStatus).toBe('select_role')
    expect(result.current.ssoRoles).toHaveLength(2)

    act(() => result.current.setSelectedSsoRole('Admin'))
    await act(() => result.current.handleSsoComplete())

    expect(invoke).toHaveBeenCalledWith('aws:sso-complete', {
      accessToken: 'sso-token',
      accountId: '111111111111',
      roleName: 'Admin',
      region: SSO_REGION,
    })
    expect(result.current.authStatus).toBe('authenticated')
    expect(result.current.accountInfo).toEqual(IDENTITY)
    expect(registerOutputs).toHaveBeenCalledWith('aws', {
      AWS_ACCESS_KEY_ID: 'ASIA_ROLE',
      AWS_SECRET_ACCESS_KEY: 'role-secret',
      AWS_REGION: 'us-west-2',
      AWS_SESSION_TOKEN: 'role-token',
    })
    // The loop ended at select_account.
    expect(polledDeviceCodes()).toHaveLength(3)
  })

  it('signs straight in when the block pins the account and role', async () => {
    installApi({ 'aws:sso-poll': () => SUCCESS })
    const { result } = renderSso({ ssoAccountId: '111111111111', ssoRoleName: 'Admin' })

    await act(() => result.current.handleSsoAuth())
    await advance(0)

    expect(invoke).toHaveBeenCalledWith('aws:sso-poll', expect.objectContaining({
      deviceCode: 'D1',
      region: SSO_REGION,
      accountId: '111111111111',
      roleName: 'Admin',
    }))
    expect(result.current.authStatus).toBe('authenticated')
    expect(result.current.accountInfo).toEqual(IDENTITY)
    expect(registerOutputs).toHaveBeenCalledWith('aws', {
      AWS_ACCESS_KEY_ID: 'ASIA_ROLE',
      AWS_SECRET_ACCESS_KEY: 'role-secret',
      AWS_REGION: 'us-west-2',
      AWS_SESSION_TOKEN: 'role-token',
    })
  })

  it('shows the reason when the poll fails', async () => {
    installApi({ 'aws:sso-poll': () => ({ status: 'failed', error: 'SSO sign-in was denied or cancelled in the browser' }) })
    const { result } = renderSso()

    await act(() => result.current.handleSsoAuth())
    await advance(0)

    expect(result.current.authStatus).toBe('failed')
    expect(result.current.errorMessage).toBe('SSO sign-in was denied or cancelled in the browser')
  })
})

describe('useAwsAuth — SSO poll lifecycle', () => {
  it('never polls a cancelled device code again after the user signs in again', async () => {
    let approved = false
    installApi({ 'aws:sso-poll': (p) => (p.deviceCode === 'D2' && approved ? SUCCESS : PENDING) })
    const { result } = renderSso()

    await act(() => result.current.handleSsoAuth())
    expect(polledDeviceCodes()).toEqual(['D1'])

    // Cancel, and sign in again before D1's next poll is due.
    act(() => result.current.handleCancelSsoAuth())
    await act(() => result.current.handleSsoAuth())
    approved = true
    await advance(2000)
    expect(result.current.authStatus).toBe('authenticated')

    // Past D1's 2-minute limit: its loop must not come back and fail the block.
    await advance(130_000)
    expect(polledDeviceCodes().filter((code) => code === 'D1')).toHaveLength(1)
    expect(result.current.authStatus).toBe('authenticated')
    expect(result.current.errorMessage).toBeNull()
  })

  it("ignores a cancelled attempt's in-flight poll when it answers after a new sign-in", async () => {
    const d1Poll = deferred<unknown>()
    installApi({ 'aws:sso-poll': (p) => (p.deviceCode === 'D1' ? d1Poll.promise : SUCCESS) })
    const { result } = renderSso()

    await act(() => result.current.handleSsoAuth())
    act(() => result.current.handleCancelSsoAuth())
    await act(() => result.current.handleSsoAuth())
    await advance(0)
    expect(result.current.authStatus).toBe('authenticated')

    await act(async () => {
      d1Poll.resolve({ status: 'failed', error: 'The SSO sign-in request expired. Please try again.' })
    })
    await advance(130_000)

    expect(result.current.authStatus).toBe('authenticated')
    expect(result.current.errorMessage).toBeNull()
    expect(polledDeviceCodes()).toEqual(['D1', 'D2'])
  })

  it('does not open the browser or poll when cancelled while the flow is starting', async () => {
    const start = deferred<unknown>()
    installApi({ 'aws:sso-start': () => start.promise })
    const { result } = renderSso()

    let signIn!: Promise<void>
    act(() => { signIn = result.current.handleSsoAuth() })
    act(() => result.current.handleCancelSsoAuth())
    await act(async () => {
      start.resolve(deviceFlow('D1'))
      await signIn
    })
    await advance(10_000)

    expect(openSpy).not.toHaveBeenCalled()
    expect(channelsCalled()).toEqual(['aws:sso-start'])
    expect(result.current.authStatus).toBe('pending')
  })

  it('stops polling when the block unmounts', async () => {
    installApi({})
    const { result, unmount } = renderSso()

    await act(() => result.current.handleSsoAuth())
    unmount()
    await advance(130_000)

    expect(polledDeviceCodes()).toEqual(['D1'])
    expect(registerOutputs).not.toHaveBeenCalled()
    expect(channelsCalled()).not.toContain('session:set-env')
  })

  it("stops polling on 'Try auto-detection again'", async () => {
    installApi({})
    const { result } = renderSso()

    await act(() => result.current.handleSsoAuth())
    act(() => result.current.handleRetryDetection())
    await advance(130_000)

    expect(polledDeviceCodes()).toEqual(['D1'])
    expect(result.current.authStatus).toBe('pending')
  })
})

describe('useAwsAuth — Re-authenticate', () => {
  it("withdraws the block's published credentials", async () => {
    installApi({ 'aws:sso-poll': () => SUCCESS })
    const { result } = renderSso({ ssoAccountId: '111111111111', ssoRoleName: 'Admin' })

    await act(() => result.current.handleSsoAuth())
    await advance(0)
    expect(result.current.authStatus).toBe('authenticated')
    registerOutputs.mockClear()

    act(() => result.current.handleManualAuth())

    // registerOutputs replaces the block's whole output map, so the AWS_* keys
    // go with it and `awsAuthId` steps see an unauthenticated block.
    expect(registerOutputs).toHaveBeenCalledTimes(1)
    expect(registerOutputs).toHaveBeenCalledWith('aws', { __AUTHENTICATED: 'false' })
    expect(result.current.authStatus).toBe('pending')
    expect(result.current.accountInfo).toBeNull()
  })

  it('stops a sign-in that is still polling', async () => {
    installApi({})
    const { result } = renderSso()

    await act(() => result.current.handleSsoAuth())
    act(() => result.current.handleManualAuth())
    await advance(130_000)

    expect(polledDeviceCodes()).toEqual(['D1'])
  })
})
