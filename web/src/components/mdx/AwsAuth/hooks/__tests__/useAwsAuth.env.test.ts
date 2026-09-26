import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderHook, act, waitFor } from '@testing-library/react'
import { ApiProvider } from '@/contexts/ApiContext'
import { useAwsAuth } from '../useAwsAuth'

/**
 * Env credential detection and confirm, driven by replies in the shape MAIN's
 * aws:env-credentials / aws:env-credentials-confirm handlers return (pinned on
 * that side by electron/main/ipc/aws-env.test.ts). The IPC surface is the only
 * boundary faked (through the real ApiProvider); the runbook and session
 * contexts are ambient state the hook reads.
 */

const registerOutputs = vi.fn()

vi.mock('@/contexts/useRunbook', () => ({
  useRunbookContext: () => ({ registerOutputs, blockOutputs: {} }),
}))
vi.mock('@/contexts/useSession', () => ({
  useSession: () => ({ isReady: true }),
}))

type Api = Parameters<typeof ApiProvider>[0]['api']
type Reply = Record<string, unknown>

let currentApi: Api

function installApi(replies: { detect?: Reply; confirm?: Reply }) {
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'aws:env-credentials') return replies.detect ?? { found: false }
    if (channel === 'aws:env-credentials-confirm') return replies.confirm ?? { valid: false }
    if (channel === 'session:set-env') return { ok: true }
    if (channel === 'aws:check-region') return { enabled: true }
    throw new Error(`unexpected channel ${channel}`)
  })
  currentApi = { invoke, on: () => () => {}, once: () => {} } as unknown as Api
  return invoke
}

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(ApiProvider, { api: currentApi, children })

const renderAwsAuth = (detectCredentials?: Parameters<typeof useAwsAuth>[0]['detectCredentials']) =>
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

const IDENTITY = {
  accountId: '111122223333',
  accountName: 'prod',
  arn: 'arn:aws:iam::111122223333:user/deployer',
}

beforeEach(() => {
  registerOutputs.mockClear()
})

describe('useAwsAuth — env credential detection', () => {
  it('prompts with the detected account for a found and valid reply (default source)', async () => {
    const invoke = installApi({
      detect: { found: true, valid: true, ...IDENTITY, region: 'eu-west-1', hasSessionToken: true },
    })

    const { result } = renderAwsAuth()

    await waitFor(() => expect(result.current.detectionStatus).toBe('detected'))
    expect(invoke).toHaveBeenCalledWith('aws:env-credentials', { prefix: '', defaultRegion: 'us-west-2' })
    expect(result.current.detectedCredentials).toEqual({
      ...IDENTITY,
      region: 'eu-west-1',
      source: 'env',
      hasSessionToken: true,
    })
    // Detection is read-only: nothing is published until the user confirms.
    expect(registerOutputs).not.toHaveBeenCalled()
  })

  it('falls through to manual auth when nothing is found', async () => {
    installApi({ detect: { found: false } })

    const { result } = renderAwsAuth()

    await waitFor(() => expect(result.current.detectionStatus).toBe('done'))
    expect(result.current.detectedCredentials).toBeNull()
    expect(result.current.detectionWarning).toBeNull()
  })

  it('warns when credentials are found but invalid', async () => {
    installApi({ detect: { found: true, valid: false, error: 'ExpiredToken' } })

    const { result } = renderAwsAuth()

    await waitFor(() => expect(result.current.detectionStatus).toBe('done'))
    expect(result.current.detectedCredentials).toBeNull()
    expect(result.current.detectionWarning).toBe('AWS credentials in environment are invalid or expired')
  })

  it("'Try auto-detection again' re-runs detection and says when it found nothing", async () => {
    const invoke = installApi({ detect: { found: false } })

    const { result } = renderAwsAuth()
    await waitFor(() => expect(result.current.detectionStatus).toBe('done'))
    // The first, automatic attempt is silent.
    expect(result.current.retryFoundNothing).toBe(false)

    act(() => result.current.handleRetryDetection())

    await waitFor(() => expect(result.current.retryFoundNothing).toBe(true))
    expect(result.current.detectionStatus).toBe('done')
    expect(invoke.mock.calls.filter(([channel]) => channel === 'aws:env-credentials')).toHaveLength(2)
  })

  it("'Try auto-detection again' after rejecting the prompt brings it back", async () => {
    installApi({
      detect: { found: true, valid: true, ...IDENTITY, region: 'us-west-2', hasSessionToken: false },
    })

    const { result } = renderAwsAuth()
    await waitFor(() => expect(result.current.detectionStatus).toBe('detected'))
    act(() => result.current.handleRejectDetected())
    expect(result.current.detectionStatus).toBe('done')
    expect(result.current.detectedCredentials).toBeNull()

    act(() => result.current.handleRetryDetection())

    await waitFor(() => expect(result.current.detectionStatus).toBe('detected'))
    expect(result.current.detectedCredentials?.accountId).toBe(IDENTITY.accountId)
    expect(registerOutputs).not.toHaveBeenCalled()
  })
})

describe('useAwsAuth — env credential confirm', () => {
  it('sends the prefix through detect and confirm, then publishes the confirmed keys', async () => {
    const invoke = installApi({
      detect: { found: true, valid: true, ...IDENTITY, region: 'eu-central-1', hasSessionToken: false },
      confirm: {
        valid: true,
        ...IDENTITY,
        accessKeyId: 'AKIA_PROD',
        secretAccessKey: 'prod-secret',
        region: 'eu-central-1',
      },
    })

    const { result } = renderAwsAuth([{ env: { prefix: 'PROD_' } }])

    await waitFor(() => expect(result.current.detectionStatus).toBe('detected'))
    expect(invoke).toHaveBeenCalledWith('aws:env-credentials', { prefix: 'PROD_', defaultRegion: 'us-west-2' })
    expect(result.current.detectedCredentials?.envPrefix).toBe('PROD_')

    await act(() => result.current.handleConfirmDetected())

    expect(invoke).toHaveBeenCalledWith('aws:env-credentials-confirm', {
      prefix: 'PROD_',
      defaultRegion: 'us-west-2',
      expectedAccountId: IDENTITY.accountId,
    })
    expect(result.current.authStatus).toBe('authenticated')
    expect(result.current.accountInfo).toEqual(IDENTITY)
    const published = {
      AWS_ACCESS_KEY_ID: 'AKIA_PROD',
      AWS_SECRET_ACCESS_KEY: 'prod-secret',
      AWS_REGION: 'eu-central-1',
      AWS_SESSION_TOKEN: '',
    }
    expect(registerOutputs).toHaveBeenCalledWith('aws', published)
    // The renderer, not MAIN's confirm handler, writes the session env.
    expect(invoke).toHaveBeenCalledWith('session:set-env', { env: published })
  })

  it('asks again, publishing nothing, when the credentials now belong to another account', async () => {
    const OTHER = { accountId: '999999999999', accountName: 'other', arn: 'arn:aws:iam::999999999999:user/x' }
    const invoke = installApi({
      detect: { found: true, valid: true, ...IDENTITY, region: 'us-west-2', hasSessionToken: false },
      confirm: { valid: false, accountChanged: true, ...OTHER, region: 'us-west-2', hasSessionToken: true },
    })

    const { result } = renderAwsAuth()
    await waitFor(() => expect(result.current.detectionStatus).toBe('detected'))
    await act(() => result.current.handleConfirmDetected())

    expect(result.current.authStatus).toBe('pending')
    expect(result.current.detectedCredentials).toEqual({
      ...OTHER,
      region: 'us-west-2',
      source: 'env',
      hasSessionToken: true,
    })
    expect(registerOutputs).not.toHaveBeenCalled()
    expect(invoke.mock.calls.map(([c]) => c)).not.toContain('session:set-env')
  })

  it('fails without publishing anything when confirm reports invalid', async () => {
    installApi({
      detect: { found: true, valid: true, ...IDENTITY, region: 'us-west-2', hasSessionToken: false },
      confirm: { valid: false, error: 'No AWS credentials found in AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY' },
    })

    const { result } = renderAwsAuth()

    await waitFor(() => expect(result.current.detectionStatus).toBe('detected'))
    await act(() => result.current.handleConfirmDetected())

    expect(result.current.authStatus).toBe('failed')
    expect(result.current.errorMessage).toContain('No AWS credentials found')
    expect(registerOutputs).not.toHaveBeenCalled()
  })
})

describe('useAwsAuth — env confirm reply after the block is gone', () => {
  it('publishes nothing when the confirm reply lands after the block unmounts', async () => {
    let answerConfirm!: (reply: Reply) => void
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'aws:env-credentials') return { found: true, valid: true, ...IDENTITY, region: 'eu-west-1', hasSessionToken: false }
      if (channel === 'aws:env-credentials-confirm') return new Promise<Reply>((r) => { answerConfirm = r })
      throw new Error(`unexpected channel ${channel}`)
    })
    currentApi = { invoke, on: () => () => {}, once: () => {} } as unknown as Api
    const { result, unmount } = renderAwsAuth()
    await waitFor(() => expect(result.current.detectionStatus).toBe('detected'))

    let confirming!: Promise<void>
    act(() => { confirming = result.current.handleConfirmDetected() })
    unmount()
    answerConfirm({ valid: true, ...IDENTITY, accessKeyId: 'AKIA_ENV', secretAccessKey: 'env-secret', region: 'eu-west-1' })
    await confirming

    expect(registerOutputs).not.toHaveBeenCalled()
    // MAIN's confirm handler writes nothing itself, and the renderer never
    // gets to publish: the session env is untouched.
    expect(invoke.mock.calls.map(([c]) => c)).not.toContain('session:set-env')
  })
})
