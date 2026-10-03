import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { ReactNode } from "react"
import { renderHook, act, waitFor } from "@testing-library/react"
import { ApiProvider, type RunbooksAPI } from "@/contexts/ApiContext"
import { IpcSessionHistoryProvider } from "@/contexts/IpcSessionHistoryContext"
import { sensitiveOutput } from "@/lib/outputValues"
import { useAwsAuth } from "../useAwsAuth"
import type { SavedBlockState } from "../../../../../../../src/domain/session/history"

// AwsAuth in a session: its sign-ins and sign-outs go to the session's history,
// and a resumed session starts it from the sign-in the history has. The IPC
// surface is the boundary faked (through the real ApiProvider and the real
// session history provider); the runbook and session contexts are ambient
// state the hook reads.

const registerOutputs = vi.fn()
const runbookState: { blockOutputs: Record<string, { values: Record<string, string> }> } = {
  blockOutputs: {},
}

vi.mock("@/contexts/useRunbook", () => ({
  useRunbookContext: () => ({ registerOutputs, blockOutputs: runbookState.blockOutputs }),
}))
vi.mock("@/contexts/useSession", () => ({
  useSession: () => ({ isReady: true }),
}))

type Reply = (args: unknown) => unknown

let replies: Record<string, Reply>
let invoke: ReturnType<typeof vi.fn>

beforeEach(() => {
  registerOutputs.mockClear()
  runbookState.blockOutputs = {}
  replies = {
    "session:record-event": () => ({ ok: true }),
    "session:set-env": () => ({ ok: true }),
    "aws:check-region": () => ({ enabled: true }),
    "aws:env-credentials": () => ({ found: false }),
  }
  invoke = vi.fn(async (channel: string, args?: unknown) => {
    const reply = replies[channel]
    if (!reply) throw new Error(`unexpected channel ${channel}`)
    return reply(args)
  })
})

const ACCOUNT = {
  accountId: "111122223333",
  accountName: "dev",
  arn: "arn:aws:iam::111122223333:user/dev",
}

const SAVED = {
  status: "signed-in",
  block: "aws",
  credentials: {
    accessKeyId: "AKIA_SAVED",
    secretAccessKey: "saved-secret",
    sessionToken: "saved-token",
    region: "us-west-2",
    expiresAt: "2026-10-03T13:00:00.000Z",
  },
  account: ACCOUNT,
}

/** The payload of each auth event sent to the main process, oldest first. */
const recorded = () =>
  invoke.mock.calls
    .filter(([channel]) => channel === "session:record-event")
    .map(([, event]) => {
      expect(event).toMatchObject({ sessionId: "s1", blockId: "aws", kind: "auth" })
      return (event as { payload: unknown }).payload
    })

function renderAwsAuth(
  options: {
    saved?: unknown
    detectCredentials?: Parameters<typeof useAwsAuth>[0]["detectCredentials"]
    sso?: { ssoStartUrl: string; ssoAccountId?: string; ssoRoleName?: string }
  } = {},
) {
  const blockStates: SavedBlockState[] =
    options.saved === undefined ? [] : [{ blockId: "aws", kind: "auth", payload: options.saved }]
  const api = { invoke, on: () => () => {} } as unknown as RunbooksAPI
  return renderHook(
    () =>
      useAwsAuth({
        id: "aws",
        ssoRegion: "us-east-1",
        defaultRegion: "us-west-2",
        detectCredentials: options.detectCredentials ?? false,
        ...options.sso,
      }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <ApiProvider api={api}>
          <IpcSessionHistoryProvider sessionId="s1" blockStates={blockStates}>
            {children}
          </IpcSessionHistoryProvider>
        </ApiProvider>
      ),
    },
  )
}

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("useAwsAuth in a session — recording", () => {
  it("records a sign-in with static keys, with the credentials and the account", async () => {
    replies["aws:validate"] = () => ({ valid: true, ...ACCOUNT })
    const { result } = renderAwsAuth()

    act(() => {
      result.current.setAccessKeyId("AKIA_STATIC")
      result.current.setSecretAccessKey("static-secret")
    })
    act(() => result.current.handleCredentialsSubmit())

    await waitFor(() => expect(result.current.authStatus).toBe("authenticated"))
    await waitFor(() => expect(recorded()).toHaveLength(1))
    expect(recorded()[0]).toEqual({
      status: "signed-in",
      block: "aws",
      credentials: {
        accessKeyId: "AKIA_STATIC",
        secretAccessKey: "static-secret",
        region: "us-west-2",
      },
      account: ACCOUNT,
    })
  })

  it("records a sign-in with a local profile, with when its credentials expire", async () => {
    replies["aws:profiles"] = () => ({ profiles: [{ name: "default", authType: "static" }] })
    replies["aws:profile-auth"] = () => ({
      valid: true,
      ...ACCOUNT,
      accessKeyId: "AKIA_PROFILE",
      secretAccessKey: "profile-secret",
      sessionToken: "profile-token",
      expiresAt: "2026-10-03T13:00:00.000Z",
    })
    const { result } = renderAwsAuth()

    await act(() => result.current.loadAwsProfiles())
    await act(() => result.current.handleProfileAuth())

    await waitFor(() =>
      expect(recorded()).toEqual([
        {
          status: "signed-in",
          block: "aws",
          credentials: {
            accessKeyId: "AKIA_PROFILE",
            secretAccessKey: "profile-secret",
            sessionToken: "profile-token",
            region: "us-west-2",
            expiresAt: "2026-10-03T13:00:00.000Z",
          },
          account: ACCOUNT,
        },
      ]),
    )
  })

  it("records a sign-in with credentials detected in the environment", async () => {
    replies["aws:env-credentials"] = () => ({ found: true, valid: true, ...ACCOUNT })
    replies["aws:env-credentials-confirm"] = () => ({
      valid: true,
      ...ACCOUNT,
      accessKeyId: "AKIA_ENV",
      secretAccessKey: "env-secret",
      region: "eu-central-1",
      expiresAt: "2026-10-03T14:00:00.000Z",
    })
    const { result } = renderAwsAuth({ detectCredentials: ["env"] })
    await waitFor(() => expect(result.current.detectionStatus).toBe("detected"))

    await act(() => result.current.handleConfirmDetected())

    await waitFor(() =>
      expect(recorded()).toEqual([
        {
          status: "signed-in",
          block: "aws",
          credentials: {
            accessKeyId: "AKIA_ENV",
            secretAccessKey: "env-secret",
            region: "eu-central-1",
            expiresAt: "2026-10-03T14:00:00.000Z",
          },
          account: ACCOUNT,
        },
      ]),
    )
  })

  it("records a sign-in confirmed from another block's outputs, with the account", async () => {
    runbookState.blockOutputs = {
      creds: {
        values: {
          AWS_ACCESS_KEY_ID: "AKIA_BLOCK",
          AWS_SECRET_ACCESS_KEY: "block-secret",
          AWS_REGION: "eu-west-1",
          AWS_CREDENTIAL_EXPIRATION: "2026-10-03T14:30:00+02:00",
        },
      },
    }
    replies["aws:validate"] = () => ({ valid: true, ...ACCOUNT })
    const { result } = renderAwsAuth({ detectCredentials: [{ block: "creds" }] })
    await waitFor(() => expect(result.current.detectionStatus).toBe("detected"))

    await act(() => result.current.handleConfirmDetected())

    await waitFor(() =>
      expect(recorded()).toEqual([
        {
          status: "signed-in",
          block: "aws",
          credentials: {
            accessKeyId: "AKIA_BLOCK",
            secretAccessKey: "block-secret",
            region: "eu-west-1",
            expiresAt: "2026-10-03T12:30:00.000Z",
          },
          account: ACCOUNT,
        },
      ]),
    )
  })

  describe("with SSO", () => {
    const SSO_CREDENTIALS = {
      accessKeyId: "AKIA_SSO",
      secretAccessKey: "sso-secret",
      sessionToken: "sso-token",
      expiresAt: "2026-10-03T20:00:00.000Z",
    }
    const savedSso = {
      status: "signed-in",
      block: "aws",
      credentials: { ...SSO_CREDENTIALS, region: "us-west-2" },
      account: ACCOUNT,
    }

    let open: { mockRestore: () => void }
    beforeEach(() => {
      open = vi.spyOn(window, "open").mockReturnValue(null)
      replies["aws:sso-start"] = () => ({
        verificationUri: "https://device.sso.example/",
        deviceCode: "dc",
        clientId: "cid",
        clientSecret: "cs",
      })
    })

    afterEach(() => {
      open.mockRestore()
    })

    it("records a sign-in to the account and role the block names", async () => {
      replies["aws:sso-poll"] = () => ({ status: "success", ...ACCOUNT, ...SSO_CREDENTIALS })
      const { result } = renderAwsAuth({
        sso: {
          ssoStartUrl: "https://acme.awsapps.com/start",
          ssoAccountId: ACCOUNT.accountId,
          ssoRoleName: "Admin",
        },
      })

      await act(() => result.current.handleSsoAuth())

      await waitFor(() => expect(recorded()).toEqual([savedSso]))
    })

    it("records a sign-in to the account and role the user picks", async () => {
      replies["aws:sso-poll"] = () => ({
        status: "select_account",
        accessToken: "sso-access",
        accounts: [{ accountId: ACCOUNT.accountId, accountName: "dev", emailAddress: "d@x" }],
      })
      replies["aws:sso-roles"] = () => ({ roles: [{ roleName: "Admin" }] })
      replies["aws:sso-complete"] = () => ({ ...ACCOUNT, ...SSO_CREDENTIALS })
      const { result } = renderAwsAuth({ sso: { ssoStartUrl: "https://acme.awsapps.com/start" } })

      await act(() => result.current.handleSsoAuth())
      await waitFor(() => expect(result.current.authStatus).toBe("select_account"))
      await act(() => result.current.handleSsoAccountSelect(result.current.ssoAccounts[0]!))
      await waitFor(() => expect(result.current.authStatus).toBe("select_role"))
      await act(() => result.current.handleSsoComplete())

      await waitFor(() => expect(recorded()).toEqual([savedSso]))
    })
  })

  it("records a sign-out when the user re-authenticates", async () => {
    replies["aws:validate"] = () => ({ valid: true, ...ACCOUNT })
    const { result } = renderAwsAuth({ saved: SAVED })
    await act(async () => {})

    act(() => result.current.handleManualAuth())

    expect(recorded()).toEqual([{ status: "signed-out" }])
    expect(result.current.authStatus).toBe("pending")
  })
})

describe("useAwsAuth in a session — resuming", () => {
  it("starts signed in to the saved account, publishes its outputs, and checks the saved credentials", async () => {
    const check = deferred<unknown>()
    replies["aws:validate"] = () => check.promise
    const { result } = renderAwsAuth({ saved: SAVED, detectCredentials: ["env"] })

    expect(result.current.authStatus).toBe("authenticated")
    expect(result.current.accountInfo).toEqual(ACCOUNT)
    expect(result.current.expiresAt).toBe("2026-10-03T13:00:00.000Z")
    expect(result.current.detectionStatus).toBe("done")
    await waitFor(() =>
      expect(registerOutputs).toHaveBeenCalledWith("aws", {
        AWS_ACCESS_KEY_ID: "AKIA_SAVED",
        AWS_SECRET_ACCESS_KEY: sensitiveOutput("saved-secret"),
        AWS_REGION: "us-west-2",
        AWS_SESSION_TOKEN: sensitiveOutput("saved-token"),
      }),
    )
    expect(invoke).toHaveBeenCalledWith("aws:validate", SAVED.credentials)

    await act(async () => check.resolve({ valid: true, ...ACCOUNT }))

    expect(result.current.authStatus).toBe("authenticated")
    // Detection was skipped, and starting from the history is not a sign-in.
    expect(invoke).not.toHaveBeenCalledWith("aws:env-credentials", expect.anything())
    expect(recorded()).toEqual([])
  })

  it("goes back to sign-in when the saved credentials no longer work", async () => {
    replies["aws:validate"] = () => ({ valid: false, error: "ExpiredToken" })
    const { result } = renderAwsAuth({ saved: SAVED })

    await waitFor(() => expect(result.current.authStatus).toBe("failed"))
    expect(result.current.errorMessage).toContain(
      "The credentials saved with this session no longer work",
    )
    expect(result.current.errorMessage).toContain("ExpiredToken")
    expect(result.current.accountInfo).toBeNull()
    expect(registerOutputs.mock.calls.at(-1)).toEqual(["aws", { __AUTHENTICATED: "false" }])
    expect(recorded()).toEqual([{ status: "signed-out" }])
  })

  it("goes back to sign-in when the saved credentials are refused without a reason", async () => {
    replies["aws:validate"] = () => ({ valid: false })
    const { result } = renderAwsAuth({ saved: SAVED })

    await waitFor(() => expect(result.current.authStatus).toBe("failed"))
    expect(result.current.errorMessage).toBe(
      "The credentials saved with this session no longer work (they were refused). Sign in again.",
    )
  })

  it("starts at sign-in when the history says the block signed out", async () => {
    const { result } = renderAwsAuth({ saved: { status: "signed-out" } })

    expect(result.current.authStatus).toBe("pending")
    expect(result.current.accountInfo).toBeNull()
    await act(async () => {})
    expect(invoke).not.toHaveBeenCalledWith("aws:validate", expect.anything())
  })

  it("keeps the sign-in when AWS can't be reached", async () => {
    replies["aws:validate"] = () => ({
      valid: false,
      error: "getaddrinfo ENOTFOUND sts.amazonaws.com",
      unreachable: true,
    })
    const { result } = renderAwsAuth({ saved: SAVED })

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("aws:validate", SAVED.credentials))
    await act(async () => {})

    expect(result.current.authStatus).toBe("authenticated")
    expect(result.current.accountInfo).toEqual(ACCOUNT)
    expect(result.current.errorMessage).toBeNull()
    expect(recorded()).toEqual([])
  })

  it("keeps the sign-in when the check itself fails", async () => {
    replies["aws:validate"] = () => {
      throw new Error("IPC channel closed")
    }
    const { result } = renderAwsAuth({ saved: SAVED })

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("aws:validate", SAVED.credentials))
    await act(async () => {})

    expect(result.current.authStatus).toBe("authenticated")
    expect(result.current.errorMessage).toBeNull()
    expect(recorded()).toEqual([])
  })

  it("ignores a late failed check once the user has re-authenticated", async () => {
    const check = deferred<unknown>()
    replies["aws:validate"] = () => check.promise
    const { result } = renderAwsAuth({ saved: SAVED })
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("aws:validate", SAVED.credentials))

    act(() => result.current.handleManualAuth())
    await act(async () => check.resolve({ valid: false, error: "ExpiredToken" }))

    expect(result.current.authStatus).toBe("pending")
    expect(result.current.errorMessage).toBeNull()
    expect(recorded()).toEqual([{ status: "signed-out" }])
  })

  it("ignores a saved sign-in of another type of block", async () => {
    const { result } = renderAwsAuth({
      saved: { ...SAVED, block: "git" },
    })

    expect(result.current.authStatus).toBe("pending")
    expect(invoke).not.toHaveBeenCalledWith("aws:validate", expect.anything())
  })
})
