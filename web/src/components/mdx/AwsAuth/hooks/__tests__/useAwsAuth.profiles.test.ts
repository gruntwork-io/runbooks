import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderHook, act, waitFor } from '@testing-library/react'
import { ApiProvider } from '@/contexts/ApiContext'
import { useAwsAuth } from '../useAwsAuth'
import type { ProfileInfo } from '../../types'

/**
 * The Local Profile tab, driven by aws:profiles replies in the `{ profiles }`
 * shape MAIN's handler returns (pinned on that side by
 * electron/main/ipc/aws-profiles.test.ts). The IPC surface is the only
 * boundary faked (through the real ApiProvider); the runbook and session
 * contexts are ambient state the hook reads. Detection is off, so the only
 * IPC is what the test triggers.
 */

const registerOutputs = vi.fn()

vi.mock('@/contexts/useRunbook', () => ({
  useRunbookContext: () => ({ registerOutputs, blockOutputs: {} }),
}))
vi.mock('@/contexts/useSession', () => ({
  useSession: () => ({ isReady: true }),
}))

type Api = Parameters<typeof ApiProvider>[0]['api']

let profilesReply: () => Promise<{ profiles: ProfileInfo[] }>
let invoke: ReturnType<typeof vi.fn>

beforeEach(() => {
  registerOutputs.mockClear()
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'aws:profiles') return profilesReply()
    if (channel === 'aws:profile-auth') {
      return {
        valid: true,
        accountId: '111122223333',
        accountName: 'dev',
        arn: 'arn:aws:iam::111122223333:user/dev',
        accessKeyId: 'AKIA_DEV',
        secretAccessKey: 'dev-secret',
      }
    }
    if (channel === 'session:set-env') return {}
    if (channel === 'aws:check-region') return { enabled: true }
    throw new Error(`unexpected channel ${channel}`)
  })
})

const replyWith = (profiles: ProfileInfo[]) => {
  profilesReply = async () => ({ profiles })
}

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(ApiProvider, {
    api: { invoke, on: () => () => {}, once: () => {} } as unknown as Api,
    children,
  })

const renderAwsAuth = () =>
  renderHook(
    () =>
      useAwsAuth({
        id: 'aws',
        ssoRegion: 'us-east-1',
        defaultRegion: 'us-west-2',
        detectCredentials: false,
        defaultTab: 'profile',
      }),
    { wrapper },
  )

const SSO: ProfileInfo = { name: 'sso-dev', authType: 'sso' }
const PROC: ProfileInfo = { name: 'proc', authType: 'unsupported' }
const DEFAULT: ProfileInfo = { name: 'default', authType: 'static' }
const ADMIN: ProfileInfo = { name: 'admin', authType: 'assume_role' }

describe('useAwsAuth — local profiles', () => {
  it('lists the profiles and preselects the first usable one', async () => {
    replyWith([SSO, PROC, DEFAULT, ADMIN])
    const { result } = renderAwsAuth()

    await act(() => result.current.loadAwsProfiles())

    expect(result.current.profiles).toEqual([SSO, PROC, DEFAULT, ADMIN])
    expect(result.current.selectedProfile).toEqual(DEFAULT)
  })

  it('authenticates the selected profile and publishes its keys in the chosen region', async () => {
    replyWith([DEFAULT])
    const { result } = renderAwsAuth()
    await act(() => result.current.loadAwsProfiles())

    await act(() => result.current.handleProfileAuth())

    // The chosen region goes along: it is the fallback when the profile sets
    // none, and it picks the partition (commercial or GovCloud) STS runs in.
    expect(invoke).toHaveBeenCalledWith('aws:profile-auth', {
      profileName: 'default',
      profile: 'default',
      defaultRegion: 'us-west-2',
    })
    expect(result.current.authStatus).toBe('authenticated')
    expect(registerOutputs).toHaveBeenCalledWith('aws', {
      AWS_ACCESS_KEY_ID: 'AKIA_DEV',
      AWS_SECRET_ACCESS_KEY: 'dev-secret',
      AWS_REGION: 'us-west-2',
      AWS_SESSION_TOKEN: '',
    })
  })
})

describe('useAwsAuth — profile region', () => {
  it("publishes the profile's own region, not the chosen one, when the profile sets one", async () => {
    replyWith([DEFAULT])
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, args?: unknown) => {
      const reply = await base(channel, args)
      return channel === 'aws:profile-auth' ? { ...reply, region: 'us-gov-east-1' } : reply
    })
    const { result } = renderAwsAuth()
    await act(() => result.current.loadAwsProfiles())

    await act(() => result.current.handleProfileAuth())

    expect(registerOutputs).toHaveBeenCalledWith('aws', expect.objectContaining({ AWS_REGION: 'us-gov-east-1' }))
  })
})

describe('useAwsAuth — refreshing profiles', () => {
  it("keeps the user's pick", async () => {
    replyWith([DEFAULT, ADMIN])
    const { result } = renderAwsAuth()
    await act(() => result.current.loadAwsProfiles())
    act(() => result.current.setSelectedProfile(ADMIN))

    await act(() => result.current.loadAwsProfiles())

    expect(result.current.selectedProfile).toEqual(ADMIN)
  })

  it('drops a pick that is no longer usable for the first usable profile', async () => {
    replyWith([DEFAULT, ADMIN])
    const { result } = renderAwsAuth()
    await act(() => result.current.loadAwsProfiles())
    act(() => result.current.setSelectedProfile(ADMIN))

    // 'admin' was reconfigured as an SSO profile.
    replyWith([DEFAULT, { name: 'admin', authType: 'sso' }])
    await act(() => result.current.loadAwsProfiles())

    expect(result.current.selectedProfile).toEqual(DEFAULT)
  })

  it('clears the selection when no usable profile is left', async () => {
    replyWith([DEFAULT])
    const { result } = renderAwsAuth()
    await act(() => result.current.loadAwsProfiles())
    expect(result.current.selectedProfile).toEqual(DEFAULT)

    replyWith([SSO, PROC])
    await act(() => result.current.loadAwsProfiles())

    expect(result.current.selectedProfile).toBeNull()
  })

  it('clears the selection when the profiles cannot be read', async () => {
    replyWith([DEFAULT])
    const { result } = renderAwsAuth()
    await act(() => result.current.loadAwsProfiles())

    profilesReply = async () => {
      throw new Error('Failed to list AWS profiles')
    }
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(() => result.current.loadAwsProfiles())
    quiet.mockRestore()

    expect(result.current.profiles).toEqual([])
    expect(result.current.selectedProfile).toBeNull()
  })
})

describe('useAwsAuth — profile sign-in reply after the attempt ended', () => {
  /** Holds aws:profile-auth in flight until the test answers it. */
  const holdProfileAuth = () => {
    let answer!: (reply: Record<string, unknown>) => void
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, args?: unknown) => {
      if (channel === 'aws:profile-auth') return new Promise((r) => { answer = r })
      if (channel === 'aws:env-credentials') return { found: false }
      return base(channel, args)
    })
    return (reply: Record<string, unknown>) => answer(reply)
  }
  const VALID = { valid: true, accountId: '111122223333', arn: 'arn:aws:iam::111122223333:user/dev', accessKeyId: 'AKIA_DEV', secretAccessKey: 'dev-secret' }

  it("ignores a reply that lands after 'Try auto-detection again'", async () => {
    replyWith([DEFAULT])
    const answer = holdProfileAuth()
    const { result } = renderHook(
      () => useAwsAuth({ id: 'aws', ssoRegion: 'us-east-1', defaultRegion: 'us-west-2', detectCredentials: ['env'], defaultTab: 'profile' }),
      { wrapper },
    )
    await waitFor(() => expect(result.current.detectionStatus).toBe('done'))
    await act(() => result.current.loadAwsProfiles())

    let signingIn!: Promise<void>
    act(() => { signingIn = result.current.handleProfileAuth() })
    expect(result.current.authStatus).toBe('authenticating')
    act(() => result.current.handleRetryDetection())
    await act(async () => {
      answer(VALID)
      await signingIn
    })

    expect(result.current.authStatus).not.toBe('authenticated')
    expect(result.current.accountInfo).toBeNull()
    expect(registerOutputs).not.toHaveBeenCalled()
  })

  it('publishes nothing when the reply lands after the block unmounts', async () => {
    replyWith([DEFAULT])
    const answer = holdProfileAuth()
    const { result, unmount } = renderAwsAuth()
    await act(() => result.current.loadAwsProfiles())

    let signingIn!: Promise<void>
    act(() => { signingIn = result.current.handleProfileAuth() })
    unmount()
    answer(VALID)
    await signingIn

    expect(registerOutputs).not.toHaveBeenCalled()
  })
})
