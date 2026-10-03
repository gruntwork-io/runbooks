import { describe, it, expect, vi, beforeEach } from "vitest"
import type { ReactNode } from "react"
import { renderHook, act, waitFor } from "@testing-library/react"
import { ApiProvider, type RunbooksAPI } from "@/contexts/ApiContext"
import { IpcSessionHistoryProvider } from "@/contexts/IpcSessionHistoryContext"
import type { OutputValues } from "@/lib/outputValues"
import { useGoogleAuth } from "../hooks/useGoogleAuth"
import type { SavedBlockState } from "../../../../../../src/domain/session/history"

// GoogleAuth in a session: each sign-in goes to the session's history with
// how it was made, and a resumed session does a sign-in it can do again over,
// the same way. The IPC surface is the boundary faked (through the real
// ApiProvider and the real session history provider); the runbook and session
// contexts are ambient state the hook reads.

const registerOutputs = vi.fn()
const runbookState: { blockOutputs: Record<string, { values: OutputValues }> } = {
  blockOutputs: {},
}

vi.mock("@/contexts/useRunbook", () => ({
  useRunbookContext: () => ({ registerOutputs, blockOutputs: runbookState.blockOutputs }),
}))
vi.mock("@/contexts/useSession", () => ({
  useSession: () => ({ isReady: true }),
}))

type Reply = (args: Record<string, unknown> | undefined) => unknown

let replies: Record<string, Reply>
let invoke: ReturnType<typeof vi.fn>

beforeEach(() => {
  registerOutputs.mockClear()
  runbookState.blockOutputs = {}
  replies = {
    "session:record-event": () => ({ ok: true }),
    "google:oauth-available": () => ({ available: true }),
    "google:check-project": () => ({ enabled: true }),
    "google:credential-committed": () => ({ ok: true }),
  }
  invoke = vi.fn(async (channel: string, args?: Record<string, unknown>) => {
    const reply = replies[channel]
    return reply ? reply(args) : {}
  })
})

const callsTo = (channel: string) => invoke.mock.calls.filter(([c]) => c === channel)

/** The payload of each auth event sent to the main process, oldest first. */
const recorded = () =>
  invoke.mock.calls
    .filter(([channel]) => channel === "session:record-event")
    .map(([, event]) => {
      expect(event).toMatchObject({ sessionId: "s1", blockId: "gcp", kind: "auth" })
      return (event as { payload: unknown }).payload
    })

const signIns = () =>
  recorded()
    .filter((p) => (p as { status: string }).status === "signed-in")
    .map((p) => (p as { signIn: unknown }).signIn)

/** Calls that published the block's authentication contract. */
const authenticatedPublishes = () =>
  registerOutputs.mock.calls.filter(
    ([, values]) => (values as Record<string, string>).__AUTHENTICATED === "true",
  )

function renderGoogleAuth(
  options: Partial<Parameters<typeof useGoogleAuth>[0]> = {},
  saved?: unknown,
) {
  const blockStates: SavedBlockState[] =
    saved === undefined ? [] : [{ blockId: "gcp", kind: "auth", payload: saved }]
  const api = { invoke, on: () => () => {} } as unknown as RunbooksAPI
  return renderHook(() => useGoogleAuth({ id: "gcp", detectCredentials: false, ...options }), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <ApiProvider api={api}>
        <IpcSessionHistoryProvider sessionId="s1" blockStates={blockStates}>
          {children}
        </IpcSessionHistoryProvider>
      </ApiProvider>
    ),
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const ACCOUNT = { principal: "ops@example.com", accountType: "service_account" }

const saved = (signIn: unknown) => ({
  status: "signed-in",
  block: "google",
  signIn,
  account: { ...ACCOUNT, credentialType: "service_account" },
  projectId: "proj-p",
  projectName: "Project P",
  region: "us-east1",
  zone: "us-east1-b",
})

const PLACEMENT = { projectId: "proj-p", region: "us-east1", zone: "us-east1-b" }

const SA_KEY = JSON.stringify({ type: "service_account", project_id: "key-project" })

describe("useGoogleAuth in a session — recording", () => {
  it("records a gcloud sign-in with its configuration", async () => {
    replies["google:gcloud-configurations"] = () => ({
      configurations: [
        { name: "prod", isActive: true, project: "proj-p", authType: "adc-service-account" },
      ],
    })
    replies["google:gcloud-auth"] = () => ({ valid: true, account: ACCOUNT, projectId: "proj-p" })
    const { result } = renderGoogleAuth()

    await act(() => result.current.loadGcloudConfigs())
    await act(() => result.current.handleGcloudAuth())

    await waitFor(() => expect(signIns()).toEqual([{ kind: "gcloud", configuration: "prod" }]))
    expect(recorded()[0]).toMatchObject({ block: "google", projectId: "proj-p" })
  })

  it("records a confirmed detection with its source", async () => {
    replies["google:env-credentials"] = () => ({
      found: true,
      valid: true,
      projectId: "proj-a",
      credentialType: "authorized_user",
    })
    replies["google:env-credentials-confirm"] = () => ({ valid: true, projectId: "proj-a" })
    const { result } = renderGoogleAuth({ detectCredentials: ["env"] })
    await waitFor(() => expect(result.current.detectionStatus).toBe("detected"))

    await act(() => result.current.handleConfirmDetected())

    await waitFor(() => expect(signIns()).toEqual([{ kind: "detected", source: "env" }]))
  })

  it("records a key file by its path, and a pasted key as one that can't be done again", async () => {
    replies["native:show-open-dialog"] = () => ({ filePaths: ["/home/u/key.json"] })
    replies["google:validate-credentials"] = () => ({
      valid: true,
      account: ACCOUNT,
      projectId: "proj-x",
    })
    const { result } = renderGoogleAuth()

    await act(() => result.current.loadKeyFromFile())
    act(() => result.current.handleServiceAccountSubmit())
    await waitFor(() => expect(signIns()).toHaveLength(1))

    act(() => result.current.handleManualAuth())
    act(() => result.current.setServiceAccountKey(SA_KEY))
    act(() => result.current.handleServiceAccountSubmit())

    await waitFor(() => expect(signIns()).toHaveLength(2))
    expect(signIns()).toEqual([{ kind: "key-file", keyPath: "/home/u/key.json" }, { kind: "none" }])
  })

  it("records a Google sign-in as one that can't be done again", async () => {
    replies["google:oauth-start"] = () => ({ flowId: "flow-1", authUrl: "https://example.test" })
    replies["google:oauth-poll"] = () => ({
      status: "complete",
      account: { principal: "dev@example.com", accountType: "user" },
      projectId: "proj-o",
    })
    const { result } = renderGoogleAuth()

    await act(() => result.current.handleOAuthLogin())

    await waitFor(() => expect(signIns()).toEqual([{ kind: "none" }]))
  })

  it("records a sign-in from a block's outputs with that block", async () => {
    runbookState.blockOutputs = {
      bootstrap: { values: { GOOGLE_APPLICATION_CREDENTIALS: "/tmp/from-block.json" } },
    }
    replies["google:validate-credentials"] = () => ({
      valid: true,
      account: ACCOUNT,
      projectId: "proj-b",
    })
    const { result } = renderGoogleAuth({ detectCredentials: [{ block: "bootstrap" }] })
    await waitFor(() => expect(result.current.detectionStatus).toBe("detected"))

    await act(() => result.current.handleConfirmDetected())

    await waitFor(() => expect(signIns()).toEqual([{ kind: "block", blockId: "bootstrap" }]))
  })

  it("records a sign-out when the user re-authenticates", async () => {
    replies["google:env-credentials"] = () => ({ found: true, valid: true, account: ACCOUNT })
    replies["google:gcloud-auth"] = () => ({ valid: true, account: ACCOUNT, projectId: "proj-p" })
    const { result } = renderGoogleAuth({}, saved({ kind: "gcloud", configuration: "prod" }))
    await waitFor(() => expect(authenticatedPublishes()).toHaveLength(1))

    act(() => result.current.handleManualAuth())

    expect(recorded().at(-1)).toEqual({ status: "signed-out" })
  })
})

describe("useGoogleAuth in a session — resuming", () => {
  it("signs in with the gcloud configuration again, showing the card meanwhile and publishing after", async () => {
    const replay = deferred<unknown>()
    replies["google:env-credentials"] = () => ({ found: true, valid: true, account: ACCOUNT })
    replies["google:gcloud-auth"] = () => replay.promise
    const { result } = renderGoogleAuth(
      { detectCredentials: ["env"] },
      saved({ kind: "gcloud", configuration: "prod" }),
    )

    expect(result.current.authStatus).toBe("authenticated")
    expect(result.current.accountInfo).toMatchObject({ principal: "ops@example.com" })
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("google:gcloud-auth", {
        blockId: "gcp",
        configuration: "prod",
        ...PLACEMENT,
      }),
    )
    expect(authenticatedPublishes()).toEqual([])
    // The configuration's credential was checked first. Detection did not run.
    expect(callsTo("google:env-credentials")).toEqual([
      ["google:env-credentials", { source: "gcloud", configuration: "prod" }],
    ])

    await act(async () =>
      replay.resolve({
        valid: true,
        account: ACCOUNT,
        projectId: "proj-p",
        credentialsPath: "/home/u/.config/gcloud/new-adc.json",
      }),
    )

    await waitFor(() => expect(authenticatedPublishes()).toHaveLength(1))
    expect(authenticatedPublishes()[0]![1]).toMatchObject({
      GOOGLE_APPLICATION_CREDENTIALS: "/home/u/.config/gcloud/new-adc.json",
      GOOGLE_CLOUD_PROJECT: "proj-p",
      GOOGLE_CLOUD_REGION: "us-east1",
      GOOGLE_ZONE: "us-east1-b",
      __AUTHENTICATED: "true",
    })
    expect(result.current.authStatus).toBe("authenticated")
  })

  it("confirms a detected credential again with its source and placement", async () => {
    replies["google:env-credentials"] = () => ({ found: true, valid: true, account: ACCOUNT })
    replies["google:env-credentials-confirm"] = () => ({
      valid: true,
      account: ACCOUNT,
      projectId: "proj-p",
      credentialsPath: "/tmp/runbooks-gcp-9/adc.json",
    })
    renderGoogleAuth({}, saved({ kind: "detected", source: "env", prefix: "PROD_" }))

    await waitFor(() => expect(authenticatedPublishes()).toHaveLength(1))
    expect(invoke).toHaveBeenCalledWith("google:env-credentials", {
      source: "env",
      prefix: "PROD_",
    })
    expect(invoke).toHaveBeenCalledWith("google:env-credentials-confirm", {
      blockId: "gcp",
      source: "env",
      prefix: "PROD_",
      ...PLACEMENT,
    })
    expect(authenticatedPublishes()[0]![1]).toMatchObject({
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/runbooks-gcp-9/adc.json",
    })
  })

  it("reads a key file again and registers the session", async () => {
    replies["google:validate-credentials"] = () => ({
      valid: true,
      account: ACCOUNT,
      projectId: "proj-p",
      credentialsPath: "/tmp/runbooks-gcp-9/key.json",
    })
    renderGoogleAuth({}, saved({ kind: "key-file", keyPath: "/home/u/key.json" }))

    await waitFor(() => expect(authenticatedPublishes()).toHaveLength(1))
    expect(callsTo("google:validate-credentials")).toEqual([
      ["google:validate-credentials", { keyPath: "/home/u/key.json", ...PLACEMENT }],
      [
        "google:validate-credentials",
        { blockId: "gcp", keyPath: "/home/u/key.json", ...PLACEMENT, registerSession: true },
      ],
    ])
  })

  it("waits for the block it signed in from to have its outputs back", async () => {
    replies["google:validate-credentials"] = () => ({
      valid: true,
      account: ACCOUNT,
      projectId: "proj-p",
      credentialsPath: "/tmp/runbooks-gcp-9/block.json",
    })
    const { rerender } = renderGoogleAuth({}, saved({ kind: "block", blockId: "bootstrap" }))
    await act(async () => {})
    expect(callsTo("google:validate-credentials")).toEqual([])

    runbookState.blockOutputs = {
      bootstrap: { values: { GOOGLE_APPLICATION_CREDENTIALS: "/tmp/from-block.json" } },
    }
    rerender()

    await waitFor(() => expect(authenticatedPublishes()).toHaveLength(1))
    expect(invoke).toHaveBeenCalledWith(
      "google:validate-credentials",
      expect.objectContaining({
        blockId: "gcp",
        keyPath: "/tmp/from-block.json",
        registerSession: true,
      }),
    )
  })

  it("goes back to sign-in, and keeps the sign-in for the next resume, when it can't be done again", async () => {
    replies["google:env-credentials"] = () => ({ found: true, valid: false, error: "ADC expired" })
    const { result } = renderGoogleAuth({}, saved({ kind: "gcloud", configuration: "prod" }))

    await waitFor(() => expect(result.current.authStatus).toBe("failed"))
    expect(result.current.errorMessage).toContain("could not be done again")
    expect(result.current.errorMessage).toContain("ADC expired")
    expect(result.current.accountInfo).toBeNull()
    expect(authenticatedPublishes()).toEqual([])
    expect(callsTo("google:gcloud-auth")).toEqual([])
    expect(recorded()).toEqual([])
  })

  it("keeps the sign-in for the next resume when the check itself fails", async () => {
    replies["google:validate-credentials"] = () => {
      throw new Error("IPC channel closed")
    }
    const { result } = renderGoogleAuth(
      {},
      saved({ kind: "key-file", keyPath: "/home/u/key.json" }),
    )

    await waitFor(() => expect(result.current.authStatus).toBe("failed"))
    expect(result.current.errorMessage).toContain("IPC channel closed")
    expect(recorded()).toEqual([])
  })

  it("signs out, writing nothing, when the credential now belongs to someone else", async () => {
    replies["google:validate-credentials"] = () => ({
      valid: true,
      account: { principal: "intruder@example.com", accountType: "service_account" },
    })
    const { result } = renderGoogleAuth(
      {},
      saved({ kind: "key-file", keyPath: "/home/u/key.json" }),
    )

    await waitFor(() => expect(result.current.authStatus).toBe("failed"))
    expect(result.current.errorMessage).toContain(
      "now belongs to intruder@example.com, not ops@example.com",
    )
    // Only the read-only check ran: the session env was never written.
    expect(callsTo("google:validate-credentials")).toEqual([
      ["google:validate-credentials", { keyPath: "/home/u/key.json", ...PLACEMENT }],
    ])
    expect(authenticatedPublishes()).toEqual([])
    expect(recorded()).toEqual([{ status: "signed-out" }])
  })

  it("checks and confirms a detection with its prefix, configuration and the block's scopes", async () => {
    replies["google:env-credentials"] = () => ({ found: true, valid: true, account: ACCOUNT })
    replies["google:env-credentials-confirm"] = () => ({ valid: true, account: ACCOUNT })
    renderGoogleAuth(
      { scopes: ["https://www.googleapis.com/auth/cloud-platform"] },
      saved({ kind: "detected", source: "gcloud", prefix: "PROD_", configuration: "prod" }),
    )

    await waitFor(() => expect(authenticatedPublishes()).toHaveLength(1))
    const scopes = ["https://www.googleapis.com/auth/cloud-platform"]
    expect(callsTo("google:env-credentials")).toEqual([
      [
        "google:env-credentials",
        { source: "gcloud", prefix: "PROD_", configuration: "prod", scopes },
      ],
    ])
    expect(callsTo("google:env-credentials-confirm")).toEqual([
      [
        "google:env-credentials-confirm",
        {
          blockId: "gcp",
          source: "gcloud",
          prefix: "PROD_",
          configuration: "prod",
          ...PLACEMENT,
          scopes,
        },
      ],
    ])
  })

  it("places the sign-in in the block's own project when the saved one had none", async () => {
    replies["google:validate-credentials"] = () => ({ valid: true, account: ACCOUNT })
    renderGoogleAuth(
      { project: "author-project" },
      {
        ...saved({ kind: "key-file", keyPath: "/home/u/key.json" }),
        projectId: "",
        region: "",
        zone: "",
      },
    )

    await waitFor(() => expect(authenticatedPublishes()).toHaveLength(1))
    expect(callsTo("google:validate-credentials")[1]).toEqual([
      "google:validate-credentials",
      {
        blockId: "gcp",
        keyPath: "/home/u/key.json",
        projectId: "author-project",
        registerSession: true,
      },
    ])
    expect(authenticatedPublishes()[0]![1]).toMatchObject({
      GOOGLE_CLOUD_PROJECT: "author-project",
    })
  })

  it("publishes what the history saved for anything signing in again did not say", async () => {
    replies["google:validate-credentials"] = (args) =>
      args?.registerSession
        ? { valid: true, credentialsPath: "/tmp/runbooks-gcp-9/key.json" }
        : { valid: true }
    const { result } = renderGoogleAuth(
      {},
      saved({ kind: "key-file", keyPath: "/home/u/key.json" }),
    )

    await waitFor(() => expect(authenticatedPublishes()).toHaveLength(1))
    expect(authenticatedPublishes()[0]![1]).toMatchObject({
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/runbooks-gcp-9/key.json",
      GOOGLE_CLOUD_PROJECT: "proj-p",
      GOOGLE_CLOUD_REGION: "us-east1",
      GOOGLE_ZONE: "us-east1-b",
    })
    expect(result.current.accountInfo).toMatchObject({
      principal: "ops@example.com",
      accountType: "service_account",
    })
  })

  it("signs in again when the check names no account to compare", async () => {
    replies["google:env-credentials"] = () => ({ found: true, valid: true })
    replies["google:gcloud-auth"] = () => ({ valid: true, account: ACCOUNT })
    renderGoogleAuth({}, saved({ kind: "gcloud", configuration: "prod" }))

    await waitFor(() => expect(authenticatedPublishes()).toHaveLength(1))
    expect(recorded()).toEqual([])
  })

  it.each([
    ["the credential is gone", { found: false }, "the credential is no longer there"],
    ["detection says why it found nothing", { found: false, error: "no ADC file" }, "no ADC file"],
    [
      "the credential is refused, with no reason",
      { found: true, valid: false },
      "the credential was refused",
    ],
    ["detection does not say it is valid", { found: true }, "the credential was refused"],
  ])("goes back to sign-in, writing nothing, when %s", async (_label, reply, reason) => {
    replies["google:env-credentials"] = () => reply
    const { result } = renderGoogleAuth({}, saved({ kind: "gcloud", configuration: "prod" }))

    await waitFor(() => expect(result.current.authStatus).toBe("failed"))
    expect(result.current.errorMessage).toContain(`(${reason})`)
    expect(callsTo("google:gcloud-auth")).toEqual([])
    expect(recorded()).toEqual([])
  })

  it("goes back to sign-in when signing in again is refused after the check passed", async () => {
    replies["google:env-credentials"] = () => ({ found: true, valid: true, account: ACCOUNT })
    replies["google:gcloud-auth"] = () => ({ valid: false })
    const { result } = renderGoogleAuth({}, saved({ kind: "gcloud", configuration: "prod" }))

    await waitFor(() => expect(result.current.authStatus).toBe("failed"))
    expect(result.current.errorMessage).toContain("(the credential was refused)")
    expect(authenticatedPublishes()).toEqual([])
    expect(recorded()).toEqual([])
  })

  it("says it could not check when the check fails without an error", async () => {
    replies["google:env-credentials"] = () => Promise.reject("closed")
    const { result } = renderGoogleAuth({}, saved({ kind: "gcloud", configuration: "prod" }))

    await waitFor(() => expect(result.current.authStatus).toBe("failed"))
    expect(result.current.errorMessage).toContain("(it could not be checked)")
  })

  it("goes back to sign-in when the block it signed in from has no Google credential now", async () => {
    runbookState.blockOutputs = { bootstrap: { values: { OTHER: "x" } } }
    const { result } = renderGoogleAuth({}, saved({ kind: "block", blockId: "bootstrap" }))

    await waitFor(() => expect(result.current.authStatus).toBe("failed"))
    expect(result.current.errorMessage).toContain(
      'Block "bootstrap" did not output GOOGLE_APPLICATION_CREDENTIALS',
    )
    expect(callsTo("google:validate-credentials")).toEqual([])
  })

  it.each([
    ["the check", "google:env-credentials"],
    ["signing in again", "google:gcloud-auth"],
  ])("ignores %s once the user has started another sign-in", async (_label, held) => {
    const pending = deferred<unknown>()
    replies["google:env-credentials"] = () => ({ found: true, valid: true, account: ACCOUNT })
    replies["google:gcloud-auth"] = () => ({ valid: true, account: ACCOUNT })
    replies[held] = () => pending.promise
    const { result } = renderGoogleAuth({}, saved({ kind: "gcloud", configuration: "prod" }))
    await waitFor(() => expect(callsTo(held)).toHaveLength(1))

    act(() => result.current.handleManualAuth())
    // A late answer that would have let the sign-in go on.
    await act(async () => pending.resolve({ found: true, valid: true, account: ACCOUNT }))

    expect(result.current.authStatus).toBe("pending")
    expect(authenticatedPublishes()).toEqual([])
    expect(callsTo("google:gcloud-auth")).toHaveLength(held === "google:gcloud-auth" ? 1 : 0)
    expect(recorded()).toEqual([{ status: "signed-out" }])
  })

  it("ignores a check that fails once the user has started another sign-in", async () => {
    const pending = deferred<unknown>()
    replies["google:env-credentials"] = () => pending.promise
    const { result } = renderGoogleAuth({}, saved({ kind: "gcloud", configuration: "prod" }))
    await waitFor(() => expect(callsTo("google:env-credentials")).toHaveLength(1))

    act(() => result.current.handleManualAuth())
    await act(async () => pending.reject(new Error("late")))

    expect(result.current.authStatus).toBe("pending")
    expect(result.current.errorMessage).toBeNull()
  })

  it("does the sign-in again once, however often the block re-renders", async () => {
    replies["google:env-credentials"] = () => ({ found: true, valid: true, account: ACCOUNT })
    replies["google:gcloud-auth"] = () => ({ valid: true, account: ACCOUNT })
    const { rerender } = renderGoogleAuth({}, saved({ kind: "gcloud", configuration: "prod" }))
    await waitFor(() => expect(authenticatedPublishes()).toHaveLength(1))

    runbookState.blockOutputs = { other: { values: { X: "1" } } }
    rerender()
    await act(async () => {})

    expect(callsTo("google:env-credentials")).toHaveLength(1)
    expect(callsTo("google:gcloud-auth")).toHaveLength(1)
  })

  it("starts showing the saved account, project and region", () => {
    replies["google:env-credentials"] = () => deferred<unknown>().promise
    const { result } = renderGoogleAuth(
      { defaultRegion: "europe-west1" },
      saved({ kind: "gcloud", configuration: "prod" }),
    )

    expect(result.current.accountInfo).toEqual({
      ...ACCOUNT,
      credentialType: "service_account",
      projectId: "proj-p",
      projectName: "Project P",
    })
    expect(result.current.selectedRegion).toBe("us-east1")
  })

  it("starts with no project when the saved sign-in had none", () => {
    replies["google:env-credentials"] = () => deferred<unknown>().promise
    const { result } = renderGoogleAuth(
      {},
      { ...saved({ kind: "gcloud", configuration: "prod" }), projectId: "" },
    )

    expect(result.current.accountInfo).not.toHaveProperty("projectId")
  })

  it("leaves the project out of the sign-in when neither the history nor the block names one", async () => {
    replies["google:validate-credentials"] = () => ({ valid: true, account: ACCOUNT })
    renderGoogleAuth(
      {},
      {
        ...saved({ kind: "key-file", keyPath: "/home/u/key.json" }),
        projectId: "",
        region: "",
        zone: "",
      },
    )

    await waitFor(() => expect(callsTo("google:validate-credentials")).toHaveLength(2))
    expect(callsTo("google:validate-credentials")[0]).toEqual([
      "google:validate-credentials",
      { keyPath: "/home/u/key.json" },
    ])
  })

  it("sends no scopes when the block requires none", async () => {
    replies["google:env-credentials"] = () => ({ found: true, valid: true, account: ACCOUNT })
    replies["google:gcloud-auth"] = () => ({ valid: true, account: ACCOUNT })
    renderGoogleAuth({ scopes: [] }, saved({ kind: "gcloud", configuration: "prod" }))

    await waitFor(() => expect(authenticatedPublishes()).toHaveLength(1))
    expect(callsTo("google:env-credentials")[0]![1]).not.toHaveProperty("scopes")
    expect(callsTo("google:gcloud-auth")[0]![1]).not.toHaveProperty("scopes")
  })

  it("checks a block's credential read-only before signing in with it", async () => {
    runbookState.blockOutputs = {
      bootstrap: { values: { GOOGLE_APPLICATION_CREDENTIALS: "/tmp/from-block.json" } },
    }
    replies["google:validate-credentials"] = () => ({ valid: true, account: ACCOUNT })
    renderGoogleAuth({}, saved({ kind: "block", blockId: "bootstrap" }))

    await waitFor(() => expect(authenticatedPublishes()).toHaveLength(1))
    expect(callsTo("google:validate-credentials")[0]).toEqual([
      "google:validate-credentials",
      { keyPath: "/tmp/from-block.json", ...PLACEMENT },
    ])
  })

  it("keeps the saved scopes when signing in again names none", async () => {
    replies["google:env-credentials"] = () => ({ found: true, valid: true, account: ACCOUNT })
    replies["google:gcloud-auth"] = () => ({ valid: true, account: ACCOUNT })
    const { result } = renderGoogleAuth(
      {},
      {
        ...saved({ kind: "gcloud", configuration: "prod" }),
        account: { ...ACCOUNT, credentialType: "service_account", scopes: ["cloud-platform"] },
      },
    )

    await waitFor(() => expect(authenticatedPublishes()).toHaveLength(1))
    expect(result.current.accountInfo?.scopes).toEqual(["cloud-platform"])
  })

  it("starts at sign-in when the history says the block signed out", () => {
    const { result } = renderGoogleAuth({}, { status: "signed-out" })

    expect(result.current.authStatus).toBe("pending")
    expect(result.current.errorMessage).toBeNull()
    expect(result.current.accountInfo).toBeNull()
  })

  it("starts over, saying why, from a sign-in that can't be done again, and says it once", async () => {
    const { result, rerender } = renderGoogleAuth(
      { defaultRegion: "europe-west1" },
      saved({ kind: "none" }),
    )

    expect(result.current.authStatus).toBe("failed")
    expect(result.current.errorMessage).toContain("can't be resumed")
    expect(result.current.accountInfo).toBeNull()
    expect(result.current.selectedRegion).toBe("europe-west1")
    await waitFor(() => expect(recorded()).toEqual([{ status: "signed-out" }]))

    rerender()
    await act(async () => {})
    expect(recorded()).toEqual([{ status: "signed-out" }])
    expect(callsTo("google:validate-credentials")).toEqual([])
    expect(callsTo("google:gcloud-auth")).toEqual([])
  })
})
