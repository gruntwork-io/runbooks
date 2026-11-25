import { describe, it, expect, vi, beforeEach } from "vitest"
import { createElement, type ReactNode } from "react"
import { renderHook, act, waitFor } from "@testing-library/react"
import { ApiProvider } from "@/contexts/ApiContext"
import { makeTestApi, type Handlers, type Result, type TestApi } from "@/test/test-api"
import { useGoogleAuth } from "../useGoogleAuth"
import { sensitiveOutput, type OutputValues } from "@/lib/outputValues"

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
const runbookState: { blockOutputs: Record<string, { values: OutputValues }> } = {
  blockOutputs: {},
}
const sessionState = { isReady: true }

vi.mock("@/contexts/useRunbook", () => ({
  useRunbookContext: () => ({
    registerOutputs,
    blockOutputs: runbookState.blockOutputs,
  }),
}))
vi.mock("@/contexts/useSession", () => ({
  useSession: () => ({ isReady: sessionState.isReady }),
}))

let testApi: TestApi

/**
 * Install the typed IPC fake, answering each channel with its handler in
 * `handlers`. Returns the invoke spy so channels/params can be asserted.
 *
 * A few calls are answered unless a test says otherwise:
 * - The hook probes `google:oauth-available` on mount so the Google Sign-In
 *   tab can label "(needs OAuth client)" on FIRST paint: "configured", so only
 *   the tests that care about an unconfigured build have to say so.
 * - The advisory project check after a sign-in: readable, so no warning.
 * - The fire-and-forget calls (committing a credential, releasing a sign-in's
 *   loopback listener, opening the browser): done.
 */
function installApi(handlers: Handlers = {}) {
  testApi = makeTestApi({
    "google:oauth-available": () => ({ available: true }),
    "google:check-project": () => ({ enabled: true }),
    "google:credential-committed": () => ({ ok: true }),
    "google:oauth-cancel": () => ({ ok: true }),
    "native:open-external": () => ({ ok: true }),
    ...handlers,
  })
  return testApi.invoke
}

/**
 * The params of each call to one channel. Used instead of raw call counts so
 * the mount-time capability probe — which is not a credential read — never
 * skews an assertion about what detection did.
 */
const callsTo = <C extends Parameters<TestApi["callsTo"]>[0]>(channel: C) =>
  testApi.callsTo(channel)

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(ApiProvider, { api: testApi.api }, children)

const renderGoogleAuth = (options: Parameters<typeof useGoogleAuth>[0]) =>
  renderHook(() => useGoogleAuth(options), { wrapper })

/** The full output map the block publishes — every key, in one call (plan §7.2). */
function outputs(over: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    GOOGLE_APPLICATION_CREDENTIALS: "",
    CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: "",
    GOOGLE_CLOUD_PROJECT: "",
    CLOUDSDK_CORE_PROJECT: "",
    GOOGLE_PROJECT: "",
    CLOUDSDK_CORE_ACCOUNT: "",
    GOOGLE_CLOUD_REGION: "",
    CLOUDSDK_COMPUTE_REGION: "",
    GOOGLE_REGION: "",
    CLOUDSDK_COMPUTE_ZONE: "",
    GOOGLE_ZONE: "",
    GOOGLE_AUTH_TYPE: "",
    __AUTHENTICATED: "true",
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
    expect((values as Record<string, string>).__AUTHENTICATED).not.toBe("true")
  }
}

const SA_KEY = JSON.stringify({
  type: "service_account",
  project_id: "key-project",
  client_email: "sa@key-project.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nzzz\n-----END PRIVATE KEY-----\n",
})

beforeEach(() => {
  registerOutputs.mockClear()
  runbookState.blockOutputs = {}
  sessionState.isReady = true
  installApi()
})

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

describe("useGoogleAuth — detection", () => {
  it("detectCredentials={false} starts done and never probes for credentials", async () => {
    installApi()
    const { result } = renderGoogleAuth({ id: "gcp", detectCredentials: false })

    expect(result.current.detectionStatus).toBe("done")
    expect(result.current.authStatus).toBe("pending")
    await act(async () => {})
    expect(callsTo("google:env-credentials")).toHaveLength(0)
    expect(callsTo("google:validate-credentials")).toHaveLength(0)
  })

  it("waits for the session before probing anything", async () => {
    sessionState.isReady = false
    const invoke = installApi({ "google:env-credentials": () => ({ found: false }) })

    const { result, rerender } = renderGoogleAuth({ id: "gcp" })
    await act(async () => {})
    expect(callsTo("google:env-credentials")).toHaveLength(0)
    expect(result.current.detectionStatus).toBe("pending")

    sessionState.isReady = true
    rerender()
    await waitFor(() => expect(result.current.detectionStatus).toBe("done"))
    expect(invoke).toHaveBeenCalledWith("google:env-credentials", expect.anything())
  })

  it("walks sources in author order and stops at the first success (read-only)", async () => {
    installApi({
      "google:env-credentials": ({ source }) => {
        if (source === "adc") {
          return {
            found: true,
            valid: true,
            projectId: "proj-a",
            projectName: "Project A",
            account: { principal: "dev@example.com", accountType: "user" },
            credentialType: "authorized_user",
            path: "/home/u/.config/gcloud/application_default_credentials.json",
            quotaProjectId: "quota-proj",
          }
        }
        return { found: false }
      },
    })

    const { result } = renderGoogleAuth({ id: "gcp" })

    await waitFor(() => expect(result.current.detectionStatus).toBe("detected"))

    const sources = callsTo("google:env-credentials").map((params) => params.source)
    expect(sources).toEqual(["env", "adc"])

    expect(result.current.detectedCredentials).toEqual({
      projectId: "proj-a",
      projectName: "Project A",
      principal: "dev@example.com",
      credentialType: "authorized_user",
      source: "adc",
      quotaProjectId: "quota-proj",
      path: "/home/u/.config/gcloud/application_default_credentials.json",
    })
    // Detection is a probe: nothing is published and nothing is confirmed yet.
    expectNoAuthenticatedPublish(registerOutputs)
    expect(result.current.authStatus).toBe("pending")
  })

  it('joins "found but invalid" warnings and finishes as done', async () => {
    installApi({ "google:env-credentials": () => ({ found: true, valid: false }) })

    const { result } = renderGoogleAuth({ id: "gcp" })

    await waitFor(() => expect(result.current.detectionStatus).toBe("done"))
    expect(result.current.detectionWarning).toBe(
      "Google Cloud credentials in the environment are invalid or expired; Application Default Credentials are invalid or expired",
    )
    expect(result.current.detectedCredentials).toBeNull()
    expect(result.current.manualHint).toBe("Fix the credentials, or sign in below.")
  })

  it("appends MAIN's reason to the per-source copy for a found-but-invalid credential", async () => {
    installApi({
      "google:env-credentials": ({ source }) => {
        if (source === "adc") {
          return {
            found: true,
            valid: false,
            source: "adc",
            warning: "ENOENT: no such file or directory, open '/home/u/adc.json'",
          }
        }
        return { found: false }
      },
    })

    const { result } = renderGoogleAuth({ id: "gcp" })

    await waitFor(() => expect(result.current.detectionStatus).toBe("done"))
    expect(result.current.detectionWarning).toBe(
      "Application Default Credentials are invalid or expired (ENOENT: no such file or directory, open '/home/u/adc.json')",
    )
  })

  it("passes the prefix through for a { env: { prefix } } source", async () => {
    const invoke = installApi({ "google:env-credentials": () => ({ found: false }) })

    const { result } = renderGoogleAuth({
      id: "gcp",
      project: "proj-prop",
      detectCredentials: [{ env: { prefix: "PROD_" } }],
    })

    await waitFor(() => expect(result.current.detectionStatus).toBe("done"))
    expect(invoke).toHaveBeenCalledWith("google:env-credentials", {
      prefix: "PROD_",
      defaultProject: "proj-prop",
      source: "env",
    })
  })

  it("confirming detected credentials registers the session and publishes outputs", async () => {
    const invoke = installApi({
      "google:env-credentials": () => ({
        found: true,
        valid: true,
        projectId: "proj-a",
        projectName: "Project A",
        account: { principal: "dev@example.com", accountType: "user" },
        credentialType: "authorized_user",
        envVar: "GOOGLE_APPLICATION_CREDENTIALS",
      }),
      "google:env-credentials-confirm": (params) => {
        expect(params).toEqual({ blockId: "gcp", source: "env", projectId: "proj-a" })
        return {
          valid: true,
          account: { principal: "dev@example.com", accountType: "user" },
          projectId: "proj-a",
          credentialsPath: "/tmp/runbooks-gcp-1/adc.json",
          credentialType: "authorized_user",
        }
      },
      "google:check-project": () => ({ enabled: true }),
    })

    const { result } = renderGoogleAuth({ id: "gcp", detectCredentials: ["env"] })
    await waitFor(() => expect(result.current.detectionStatus).toBe("detected"))

    await act(async () => {
      await result.current.handleConfirmDetected()
    })

    expect(result.current.authStatus).toBe("authenticated")
    expect(result.current.accountInfo).toEqual({
      projectId: "proj-a",
      projectName: "Project A",
      principal: "dev@example.com",
      accountType: "user",
      credentialType: "authorized_user",
      credentialsPath: "/tmp/runbooks-gcp-1/adc.json",
    })
    // Two calls, in this order: the contract is WITHDRAWN before MAIN can
    // materialise a replacement credential, then re-published once the flow
    // resolves. The publish itself is still the single all-keys call (§7.2).
    expect(registerOutputs).toHaveBeenCalledTimes(2)
    expect(registerOutputs.mock.calls[0]).toEqual(["gcp", { __AUTHENTICATED: "false" }])
    expect(registerOutputs).toHaveBeenCalledWith(
      "gcp",
      outputs({
        GOOGLE_APPLICATION_CREDENTIALS: "/tmp/runbooks-gcp-1/adc.json",
        CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: "/tmp/runbooks-gcp-1/adc.json",
        GOOGLE_CLOUD_PROJECT: "proj-a",
        CLOUDSDK_CORE_PROJECT: "proj-a",
        GOOGLE_PROJECT: "proj-a",
        CLOUDSDK_CORE_ACCOUNT: "dev@example.com",
        GOOGLE_AUTH_TYPE: "authorized_user",
      }),
    )
    // MAIN owns every credential write; the renderer never touches session env.
    expect(invoke).not.toHaveBeenCalledWith("session:set-env", expect.anything())
  })

  it("confirming a gcloud detection publishes the region/zone MAIN took from the configuration", async () => {
    const invoke = installApi({
      "google:env-credentials": () => ({
        found: true,
        valid: true,
        source: "gcloud",
        projectId: "proj-a",
        account: { principal: "dev@example.com", accountType: "user" },
        credentialType: "authorized_user",
        path: "/home/u/.config/gcloud/application_default_credentials.json",
        configuration: "default",
      }),
      // Nothing requested, so MAIN wrote the configuration's compute defaults.
      "google:env-credentials-confirm": () => ({
        valid: true,
        account: { principal: "dev@example.com", accountType: "user" },
        projectId: "proj-a",
        credentialsPath: "/home/u/.config/gcloud/application_default_credentials.json",
        credentialType: "authorized_user",
        region: "europe-west1",
        zone: "europe-west1-b",
      }),
      "google:check-project": () => ({ enabled: true }),
    })

    const { result } = renderGoogleAuth({ id: "gcp", detectCredentials: ["gcloud"] })
    await waitFor(() => expect(result.current.detectionStatus).toBe("detected"))

    await act(async () => {
      await result.current.handleConfirmDetected()
    })

    expect(invoke).toHaveBeenCalledWith("google:env-credentials-confirm", {
      blockId: "gcp",
      source: "gcloud",
      configuration: "default",
      projectId: "proj-a",
    })
    expect(result.current.authStatus).toBe("authenticated")
    expect(registerOutputs).toHaveBeenLastCalledWith(
      "gcp",
      outputs({
        GOOGLE_APPLICATION_CREDENTIALS:
          "/home/u/.config/gcloud/application_default_credentials.json",
        CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE:
          "/home/u/.config/gcloud/application_default_credentials.json",
        GOOGLE_CLOUD_PROJECT: "proj-a",
        CLOUDSDK_CORE_PROJECT: "proj-a",
        GOOGLE_PROJECT: "proj-a",
        CLOUDSDK_CORE_ACCOUNT: "dev@example.com",
        GOOGLE_CLOUD_REGION: "europe-west1",
        CLOUDSDK_COMPUTE_REGION: "europe-west1",
        GOOGLE_REGION: "europe-west1",
        CLOUDSDK_COMPUTE_ZONE: "europe-west1-b",
        GOOGLE_ZONE: "europe-west1-b",
        GOOGLE_AUTH_TYPE: "authorized_user",
      }),
    )
  })

  it("a failed confirm renders inline and publishes nothing", async () => {
    installApi({
      "google:env-credentials": () => ({
        found: true,
        valid: true,
        projectId: "proj-a",
        account: { principal: "dev@example.com", accountType: "user" },
        credentialType: "authorized_user",
      }),
      "google:env-credentials-confirm": () => ({
        valid: false,
        error: "The credentials expired between detection and use",
      }),
    })

    const { result } = renderGoogleAuth({ id: "gcp", detectCredentials: ["env"] })
    await waitFor(() => expect(result.current.detectionStatus).toBe("detected"))

    await act(async () => {
      await result.current.handleConfirmDetected()
    })

    expect(result.current.authStatus).toBe("failed")
    expect(result.current.errorMessage).toBe("The credentials expired between detection and use")
    expectNoAuthenticatedPublish(registerOutputs)
  })

  it("rejecting the prompt falls through to the manual tabs", async () => {
    installApi({
      "google:env-credentials": () => ({
        found: true,
        valid: true,
        projectId: "proj-a",
        account: { principal: "dev@example.com", accountType: "user" },
        credentialType: "authorized_user",
      }),
    })

    const { result } = renderGoogleAuth({ id: "gcp", detectCredentials: ["env"] })
    await waitFor(() => expect(result.current.detectionStatus).toBe("detected"))

    act(() => result.current.handleRejectDetected())

    expect(result.current.detectedCredentials).toBeNull()
    expect(result.current.detectionStatus).toBe("done")
    expect(result.current.authStatus).toBe("pending")
  })

  it("pauses on a block source that has not executed, then resumes when it has", async () => {
    const invoke = installApi({
      "google:validate-credentials": () => ({
        valid: true,
        projectId: "proj-b",
        account: {
          principal: "sa@proj-b.iam.gserviceaccount.com",
          accountType: "service_account",
        },
        credentialType: "service_account",
      }),
      "google:env-credentials": () => ({ found: false }),
    })

    const { result, rerender } = renderGoogleAuth({
      id: "gcp",
      detectCredentials: [{ block: "bootstrap" }, "env"],
    })

    // The author's ordering wins: the walk PAUSES rather than skipping ahead.
    await waitFor(() => expect(result.current.waitingForBlockId).toBe("bootstrap"))
    expect(result.current.detectionStatus).toBe("pending")
    expect(invoke).not.toHaveBeenCalledWith("google:env-credentials", expect.anything())

    runbookState.blockOutputs = {
      bootstrap: {
        values: {
          GOOGLE_APPLICATION_CREDENTIALS: "/tmp/from-block.json",
          CLOUDSDK_CORE_PROJECT: "proj-b",
        },
      },
    }
    rerender()

    await waitFor(() => expect(result.current.detectionStatus).toBe("detected"))
    expect(invoke).toHaveBeenCalledWith("google:validate-credentials", {
      blockId: "gcp",
      keyPath: "/tmp/from-block.json",
      projectId: "proj-b",
      registerSession: false,
    })
    expect(result.current.detectedCredentials?.source).toBe("block")
    expect(result.current.waitingForBlockId).toBeNull()
  })

  it("validates an access token the block marked sensitive with its real value", async () => {
    runbookState.blockOutputs = {
      bootstrap: {
        values: {
          GOOGLE_OAUTH_ACCESS_TOKEN: sensitiveOutput("ya29.secret-token"),
          CLOUDSDK_CORE_PROJECT: "proj-b",
        },
      },
    }
    const invoke = installApi({
      "google:validate-credentials": () => ({
        valid: true,
        projectId: "proj-b",
        account: {
          principal: "sa@proj-b.iam.gserviceaccount.com",
          accountType: "service_account",
        },
        credentialType: "access_token",
      }),
    })

    const { result } = renderGoogleAuth({ id: "gcp", detectCredentials: [{ block: "bootstrap" }] })

    await waitFor(() => expect(result.current.detectionStatus).toBe("detected"))
    expect(invoke).toHaveBeenCalledWith(
      "google:validate-credentials",
      expect.objectContaining({ accessToken: "ya29.secret-token", projectId: "proj-b" }),
    )
  })

  it("enforces required scopes on { block } credentials via validate-credentials", async () => {
    const DIRECTORY = "https://www.googleapis.com/auth/admin.directory.rolemanagement"
    const CLOUD_PLATFORM = "https://www.googleapis.com/auth/cloud-platform"
    const requiredScopes = [CLOUD_PLATFORM, DIRECTORY]

    runbookState.blockOutputs = {
      bootstrap: {
        values: {
          GOOGLE_OAUTH_ACCESS_TOKEN: "ya29.user-token",
          CLOUDSDK_CORE_PROJECT: "proj-b",
        },
      },
    }

    const invoke = installApi({
      "google:validate-credentials": (params) => {
        expect(params.scopes).toEqual(requiredScopes)
        expect(params.registerSession).toBe(false)
        return {
          valid: false,
          insufficientScopes: true,
          missingScopes: [DIRECTORY],
          grantedScopes: [CLOUD_PLATFORM],
          projectId: "proj-b",
          account: {
            principal: "admin@example.com",
            accountType: "user",
            scopes: [CLOUD_PLATFORM],
          },
          credentialType: "access_token",
        }
      },
    })

    const { result } = renderGoogleAuth({
      id: "gcp",
      scopes: requiredScopes,
      detectCredentials: [{ block: "bootstrap" }],
    })

    await waitFor(() => expect(result.current.detectionStatus).toBe("detected"))
    expect(result.current.detectedCredentials?.source).toBe("block")
    expect(result.current.detectedCredentials?.missingScopes).toEqual([DIRECTORY])
    expect(invoke).toHaveBeenCalledWith(
      "google:validate-credentials",
      expect.objectContaining({
        blockId: "gcp",
        accessToken: "ya29.user-token",
        scopes: requiredScopes,
        registerSession: false,
      }),
    )
  })

  it('"Check again" re-runs the walk and says when it found nothing', async () => {
    installApi({ "google:env-credentials": () => ({ found: false }) })

    const { result } = renderGoogleAuth({ id: "gcp", detectCredentials: ["env"] })
    await waitFor(() => expect(result.current.detectionStatus).toBe("done"))
    expect(result.current.manualHint).toBe("No existing credentials found. Sign in below.")
    expect(callsTo("google:env-credentials")).toHaveLength(1)

    act(() => result.current.handleRetryDetection())
    expect(result.current.detectionStatus).toBe("pending")

    await waitFor(() => expect(result.current.detectionStatus).toBe("done"))
    expect(result.current.manualHint).toBe("No existing credentials found. Sign in below.")
    expect(callsTo("google:env-credentials")).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Tab 1 — service account key
// ---------------------------------------------------------------------------

describe("useGoogleAuth — service account tab", () => {
  it("validates the pasted key, registers the session, and publishes outputs", async () => {
    const invoke = installApi({
      "google:validate-credentials": () => ({
        valid: true,
        account: {
          principal: "sa@key-project.iam.gserviceaccount.com",
          accountType: "service_account",
        },
        projectId: "proj-x",
        projectName: "Project X",
        credentialType: "service_account",
        credentialsPath: "/tmp/runbooks-gcp-2/adc.json",
      }),
      "google:check-project": () => ({ enabled: true }),
    })

    const { result } = renderGoogleAuth({
      id: "gcp",
      project: "proj-x",
      defaultRegion: "us-central1",
      detectCredentials: false,
    })

    act(() => result.current.setServiceAccountKey(SA_KEY))
    await act(async () => {
      result.current.handleServiceAccountSubmit()
    })

    await waitFor(() => expect(result.current.authStatus).toBe("authenticated"))
    expect(invoke).toHaveBeenCalledWith("google:validate-credentials", {
      blockId: "gcp",
      keyJson: SA_KEY,
      projectId: "proj-x",
      region: "us-central1",
      registerSession: true,
    })
    expect(registerOutputs).toHaveBeenCalledWith(
      "gcp",
      outputs({
        GOOGLE_APPLICATION_CREDENTIALS: "/tmp/runbooks-gcp-2/adc.json",
        CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: "/tmp/runbooks-gcp-2/adc.json",
        GOOGLE_CLOUD_PROJECT: "proj-x",
        CLOUDSDK_CORE_PROJECT: "proj-x",
        GOOGLE_PROJECT: "proj-x",
        CLOUDSDK_CORE_ACCOUNT: "sa@key-project.iam.gserviceaccount.com",
        GOOGLE_CLOUD_REGION: "us-central1",
        CLOUDSDK_COMPUTE_REGION: "us-central1",
        GOOGLE_REGION: "us-central1",
        GOOGLE_AUTH_TYPE: "service_account",
      }),
    )
    expect(invoke).toHaveBeenCalledWith("google:check-project", {
      blockId: "gcp",
      projectId: "proj-x",
    })
    expect(invoke).not.toHaveBeenCalledWith("session:set-env", expect.anything())
  })

  /**
   * MAIN registers `params.projectId ?? <the key's project_id>` in the session
   * env and echoes it back as `projectId`. Modelled here so a test sees the
   * project MAIN would actually have written.
   */
  const echoingValidate: Handlers = {
    "google:validate-credentials": ({ projectId }) => ({
      valid: true,
      account: {
        principal: "sa@key-project.iam.gserviceaccount.com",
        accountType: "service_account",
      },
      projectId: projectId ?? "key-project",
      credentialType: "service_account",
      credentialsPath: "/tmp/runbooks-gcp-4/adc.json",
    }),
    "google:check-project": () => ({ enabled: true }),
  }

  /** The full output map for an `echoingValidate` login. */
  const saOutputs = (over: Partial<Record<string, string>>) =>
    outputs({
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/runbooks-gcp-4/adc.json",
      CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: "/tmp/runbooks-gcp-4/adc.json",
      CLOUDSDK_CORE_ACCOUNT: "sa@key-project.iam.gserviceaccount.com",
      GOOGLE_AUTH_TYPE: "service_account",
      ...over,
    })

  const projectOutputs = (projectId: string) => ({
    GOOGLE_CLOUD_PROJECT: projectId,
    CLOUDSDK_CORE_PROJECT: projectId,
    GOOGLE_PROJECT: projectId,
  })

  it("publishes the Project ID typed over the `project` prop — the one MAIN registered", async () => {
    const invoke = installApi(echoingValidate)
    const { result } = renderGoogleAuth({
      id: "gcp",
      project: "prop-proj",
      detectCredentials: false,
    })

    expect(result.current.projectIdInput).toBe("prop-proj")
    act(() => result.current.setServiceAccountKey(SA_KEY))
    act(() => result.current.setProjectIdInput("user-proj"))
    await act(async () => {
      result.current.handleServiceAccountSubmit()
    })

    await waitFor(() => expect(result.current.authStatus).toBe("authenticated"))
    expect(invoke).toHaveBeenCalledWith("google:validate-credentials", {
      blockId: "gcp",
      keyJson: SA_KEY,
      projectId: "user-proj",
      registerSession: true,
    })
    // The outputs (what a `googleAuthId` step injects) name the same project as
    // the session env MAIN wrote (what a bare step inherits).
    expect(registerOutputs).toHaveBeenCalledWith("gcp", saOutputs(projectOutputs("user-proj")))
    expect(result.current.accountInfo?.projectId).toBe("user-proj")
    expect(invoke).toHaveBeenCalledWith("google:check-project", {
      blockId: "gcp",
      projectId: "user-proj",
    })
  })

  it("the Project ID field follows a `project` prop that changes before any edit", async () => {
    const invoke = installApi(echoingValidate)
    // `project="{{ .inputs.project }}"` re-resolves when the input changes.
    const { result, rerender } = renderHook(
      (options: Parameters<typeof useGoogleAuth>[0]) => useGoogleAuth(options),
      { wrapper, initialProps: { id: "gcp", project: "dev", detectCredentials: false } },
    )
    expect(result.current.projectIdInput).toBe("dev")

    rerender({ id: "gcp", project: "prod", detectCredentials: false })
    expect(result.current.projectIdInput).toBe("prod")

    act(() => result.current.setServiceAccountKey(SA_KEY))
    await act(async () => {
      result.current.handleServiceAccountSubmit()
    })

    await waitFor(() => expect(result.current.authStatus).toBe("authenticated"))
    expect(invoke).toHaveBeenCalledWith(
      "google:validate-credentials",
      expect.objectContaining({ projectId: "prod" }),
    )
    expect(registerOutputs).toHaveBeenCalledWith("gcp", saOutputs(projectOutputs("prod")))
  })

  it("an edited Project ID survives a later change to the `project` prop", () => {
    const { result, rerender } = renderHook(
      (options: Parameters<typeof useGoogleAuth>[0]) => useGoogleAuth(options),
      { wrapper, initialProps: { id: "gcp", project: "dev", detectCredentials: false } },
    )

    act(() => result.current.setProjectIdInput("user-proj"))
    rerender({ id: "gcp", project: "prod", detectCredentials: false })

    expect(result.current.projectIdInput).toBe("user-proj")
  })

  it("clearing the Project ID field sends no project, so the key's own project_id applies", async () => {
    const invoke = installApi(echoingValidate)
    const { result } = renderGoogleAuth({
      id: "gcp",
      project: "prop-proj",
      detectCredentials: false,
    })

    act(() => result.current.setServiceAccountKey(SA_KEY))
    act(() => result.current.setProjectIdInput(""))
    await act(async () => {
      result.current.handleServiceAccountSubmit()
    })

    await waitFor(() => expect(result.current.authStatus).toBe("authenticated"))
    expect(invoke).toHaveBeenCalledWith("google:validate-credentials", {
      blockId: "gcp",
      keyJson: SA_KEY,
      registerSession: true,
    })
    expect(registerOutputs).toHaveBeenCalledWith("gcp", saOutputs(projectOutputs("key-project")))
  })

  it('"No default region" sends and publishes no region, even with defaultRegion set', async () => {
    const invoke = installApi(echoingValidate)
    const { result } = renderGoogleAuth({
      id: "gcp",
      defaultRegion: "us-central1",
      defaultZone: "us-central1-a",
      detectCredentials: false,
    })

    expect(result.current.selectedRegion).toBe("us-central1")
    act(() => result.current.setServiceAccountKey(SA_KEY))
    act(() => result.current.setSelectedRegion(""))
    await act(async () => {
      result.current.handleServiceAccountSubmit()
    })

    await waitFor(() => expect(result.current.authStatus).toBe("authenticated"))
    // No `region` key at all; the zone has no picker and still comes from the prop.
    expect(invoke).toHaveBeenCalledWith("google:validate-credentials", {
      blockId: "gcp",
      keyJson: SA_KEY,
      zone: "us-central1-a",
      registerSession: true,
    })
    expect(registerOutputs).toHaveBeenCalledWith(
      "gcp",
      saOutputs({
        ...projectOutputs("key-project"),
        GOOGLE_CLOUD_REGION: "",
        CLOUDSDK_COMPUTE_REGION: "",
        GOOGLE_REGION: "",
        CLOUDSDK_COMPUTE_ZONE: "us-central1-a",
        GOOGLE_ZONE: "us-central1-a",
      }),
    )
  })

  it("surfaces a rejected key inline as a runtime error", async () => {
    installApi({
      "google:validate-credentials": () => ({
        valid: false,
        error: "Not a service account key (expected type: service_account)",
      }),
    })

    const { result } = renderGoogleAuth({ id: "gcp", detectCredentials: false })

    act(() => result.current.setServiceAccountKey('{"type":"authorized_user"}'))
    await act(async () => {
      result.current.handleServiceAccountSubmit()
    })

    await waitFor(() => expect(result.current.authStatus).toBe("failed"))
    expect(result.current.errorMessage).toBe(
      "Not a service account key (expected type: service_account)",
    )
    expectNoAuthenticatedPublish(registerOutputs)
  })

  it("refuses to submit an empty key without an IPC round trip", async () => {
    installApi()
    const { result } = renderGoogleAuth({ id: "gcp", detectCredentials: false })

    await act(async () => {
      result.current.handleServiceAccountSubmit()
    })

    expect(result.current.authStatus).toBe("failed")
    expect(result.current.errorMessage).toBe("A service account key JSON is required")
    expect(callsTo("google:validate-credentials")).toHaveLength(0)
  })

  it("falls into project selection when the key can see more than one project", async () => {
    const invoke = installApi({
      "google:validate-credentials": () => ({
        valid: true,
        account: {
          principal: "sa@key-project.iam.gserviceaccount.com",
          accountType: "service_account",
        },
        credentialType: "service_account",
        credentialsPath: "/tmp/runbooks-gcp-3/adc.json",
        projects: [
          { projectId: "proj-one", displayName: "Project One" },
          { projectId: "proj-two", displayName: "Project Two" },
        ],
      }),
      "google:set-project": () => ({ ok: true, projectName: "Project Two" }),
      "google:check-project": () => ({ enabled: true }),
    })

    const { result } = renderGoogleAuth({ id: "gcp", detectCredentials: false })

    act(() => result.current.setServiceAccountKey(SA_KEY))
    await act(async () => {
      result.current.handleServiceAccountSubmit()
    })

    await waitFor(() => expect(result.current.authStatus).toBe("select_project"))
    expect(result.current.projects).toHaveLength(2)
    expectNoAuthenticatedPublish(registerOutputs)

    await act(async () => {
      await result.current.handleProjectSelect({
        projectId: "proj-two",
        displayName: "Project Two",
      })
    })

    expect(invoke).toHaveBeenCalledWith("google:set-project", {
      blockId: "gcp",
      projectId: "proj-two",
    })
    expect(result.current.authStatus).toBe("authenticated")
    // The credentials file survives the select_project detour.
    expect(registerOutputs).toHaveBeenCalledWith(
      "gcp",
      outputs({
        GOOGLE_APPLICATION_CREDENTIALS: "/tmp/runbooks-gcp-3/adc.json",
        CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: "/tmp/runbooks-gcp-3/adc.json",
        GOOGLE_CLOUD_PROJECT: "proj-two",
        CLOUDSDK_CORE_PROJECT: "proj-two",
        GOOGLE_PROJECT: "proj-two",
        CLOUDSDK_CORE_ACCOUNT: "sa@key-project.iam.gserviceaccount.com",
        GOOGLE_AUTH_TYPE: "service_account",
      }),
    )
  })

  it("takes a key file by PATH and never reads its contents into the renderer", async () => {
    const invoke = installApi({
      // The ordinary case: a key downloaded from the console, i.e. OUTSIDE
      // the workspace. `file:read` would refuse this path outright.
      "native:show-open-dialog": () => ({ filePaths: ["/home/u/Downloads/project-abc-1234.json"] }),
      "google:validate-credentials": () => ({
        valid: true,
        account: {
          principal: "sa@key-project.iam.gserviceaccount.com",
          accountType: "service_account",
        },
        projectId: "proj-x",
        credentialType: "service_account",
        credentialsPath: "/home/u/Downloads/project-abc-1234.json",
      }),
      "google:check-project": () => ({ enabled: true }),
    })

    const { result } = renderGoogleAuth({ id: "gcp", detectCredentials: false })

    await act(async () => {
      await result.current.loadKeyFromFile()
    })

    expect(result.current.keyFilePath).toBe("/home/u/Downloads/project-abc-1234.json")
    expect(result.current.keyFileName).toBe("project-abc-1234.json")
    // The custody rule: the private key never enters renderer state.
    expect(result.current.serviceAccountKey).toBe("")
    expect(callsTo("file:read")).toHaveLength(0)

    await act(async () => {
      result.current.handleServiceAccountSubmit()
    })
    await waitFor(() => expect(result.current.authStatus).toBe("authenticated"))

    // MAIN reads and validates the file itself; only the path crosses IPC.
    expect(invoke).toHaveBeenCalledWith("google:validate-credentials", {
      blockId: "gcp",
      keyPath: "/home/u/Downloads/project-abc-1234.json",
      registerSession: true,
    })
  })

  it("pasting a key after choosing a file drops the file (one credential at a time)", async () => {
    installApi({
      "native:show-open-dialog": () => ({ filePaths: ["/home/u/Downloads/key.json"] }),
      "google:validate-credentials": () => ({
        valid: true,
        account: {
          principal: "sa@key-project.iam.gserviceaccount.com",
          accountType: "service_account",
        },
        projectId: "proj-x",
        credentialType: "service_account",
      }),
      "google:check-project": () => ({ enabled: true }),
    })

    const { result } = renderGoogleAuth({ id: "gcp", detectCredentials: false })

    await act(async () => {
      await result.current.loadKeyFromFile()
    })
    act(() => result.current.setServiceAccountKey(SA_KEY))

    expect(result.current.keyFilePath).toBeNull()
    expect(result.current.keyFileName).toBeNull()

    await act(async () => {
      result.current.handleServiceAccountSubmit()
    })
    await waitFor(() => expect(result.current.authStatus).toBe("authenticated"))

    const [params] = callsTo("google:validate-credentials")
    expect(params).toHaveProperty("keyJson", SA_KEY)
    expect(params).not.toHaveProperty("keyPath")
  })
})

// ---------------------------------------------------------------------------
// Tab 2 — Google sign-in (loopback OAuth)
// ---------------------------------------------------------------------------

describe("useGoogleAuth — OAuth tab", () => {
  it("starts the loopback flow, hands off to the browser, and finishes on complete", async () => {
    const invoke = installApi({
      "google:oauth-start": () => ({
        flowId: "flow-1",
        authUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=abc",
        redirectUri: "http://127.0.0.1:53211/oauth2callback",
        expiresInSeconds: 300,
      }),
      "google:oauth-poll": () => ({
        status: "complete",
        account: { principal: "dev@example.com", accountType: "user" },
        credentialsPath: "/tmp/runbooks-gcp-4/adc.json",
        projects: [{ projectId: "proj-solo", displayName: "Solo Project" }],
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      }),
      "google:set-project": () => ({ ok: true, projectName: "Solo Project" }),
      "google:check-project": () => ({ enabled: true }),
    })

    const { result } = renderGoogleAuth({ id: "gcp", detectCredentials: false })

    await act(async () => {
      await result.current.handleOAuthLogin()
    })
    await waitFor(() => expect(result.current.authStatus).toBe("authenticated"))

    // MAIN owns the default client id — nothing is sent unless the author overrode it.
    expect(invoke).toHaveBeenCalledWith("google:oauth-start", {})
    expect(invoke).toHaveBeenCalledWith("native:open-external", {
      url: "https://accounts.google.com/o/oauth2/v2/auth?state=abc",
    })
    // Exactly one visible project auto-selects; no picker detour.
    expect(invoke).toHaveBeenCalledWith("google:set-project", {
      blockId: "gcp",
      projectId: "proj-solo",
    })
    expect(result.current.oauthFlowId).toBeNull()
    expect(registerOutputs).toHaveBeenCalledWith(
      "gcp",
      outputs({
        GOOGLE_APPLICATION_CREDENTIALS: "/tmp/runbooks-gcp-4/adc.json",
        CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: "/tmp/runbooks-gcp-4/adc.json",
        GOOGLE_CLOUD_PROJECT: "proj-solo",
        CLOUDSDK_CORE_PROJECT: "proj-solo",
        GOOGLE_PROJECT: "proj-solo",
        CLOUDSDK_CORE_ACCOUNT: "dev@example.com",
        GOOGLE_AUTH_TYPE: "authorized_user",
      }),
    )
  })

  it("with no project to pick, sends the region/zone to MAIN and publishes what MAIN wrote", async () => {
    installApi({
      "google:oauth-start": () => ({
        flowId: "flow-np",
        authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      }),
      // No `project` prop and no listable projects: nothing follows this
      // poll, so it is the only session write. MAIN echoes what it wrote.
      "google:oauth-poll": ({ region, zone }) => ({
        status: "complete",
        account: { principal: "dev@example.com", accountType: "user" },
        credentialsPath: "/tmp/runbooks-gcp-np/adc.json",
        ...(region ? { region } : {}),
        ...(zone ? { zone } : {}),
      }),
    })

    const { result } = renderGoogleAuth({
      id: "gcp",
      defaultRegion: "europe-west1",
      defaultZone: "europe-west1-b",
      detectCredentials: false,
    })

    await act(async () => {
      await result.current.handleOAuthLogin()
    })
    await waitFor(() => expect(result.current.authStatus).toBe("authenticated"))

    expect(callsTo("google:oauth-poll")).toEqual([
      { flowId: "flow-np", blockId: "gcp", region: "europe-west1", zone: "europe-west1-b" },
    ])
    expect(callsTo("google:set-project")).toHaveLength(0)
    expect(registerOutputs).toHaveBeenLastCalledWith(
      "gcp",
      outputs({
        GOOGLE_APPLICATION_CREDENTIALS: "/tmp/runbooks-gcp-np/adc.json",
        CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: "/tmp/runbooks-gcp-np/adc.json",
        CLOUDSDK_CORE_ACCOUNT: "dev@example.com",
        GOOGLE_CLOUD_REGION: "europe-west1",
        CLOUDSDK_COMPUTE_REGION: "europe-west1",
        GOOGLE_REGION: "europe-west1",
        CLOUDSDK_COMPUTE_ZONE: "europe-west1-b",
        GOOGLE_ZONE: "europe-west1-b",
        GOOGLE_AUTH_TYPE: "authorized_user",
      }),
    )
  })

  it("sends author OAuth overrides and offers a project picker for multiple projects", async () => {
    const invoke = installApi({
      "google:oauth-start": () => ({
        flowId: "flow-2",
        authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      }),
      "google:oauth-poll": () => ({
        status: "complete",
        account: { principal: "dev@example.com", accountType: "user" },
        credentialsPath: "/tmp/runbooks-gcp-5/adc.json",
        projects: [
          { projectId: "proj-one", displayName: "Project One" },
          { projectId: "proj-two", displayName: "Project Two" },
        ],
      }),
    })

    const { result } = renderGoogleAuth({
      id: "gcp",
      detectCredentials: false,
      oauthClientId: "custom.apps.googleusercontent.com",
      oauthClientSecret: "not-confidential",
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    })

    await act(async () => {
      await result.current.handleOAuthLogin()
    })
    await waitFor(() => expect(result.current.authStatus).toBe("select_project"))

    expect(invoke).toHaveBeenCalledWith("google:oauth-start", {
      clientId: "custom.apps.googleusercontent.com",
      clientSecret: "not-confidential",
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    })
    expect(result.current.projects).toHaveLength(2)
    expectNoAuthenticatedPublish(registerOutputs)
  })

  it("cancelling releases the loopback listener in MAIN", async () => {
    const invoke = installApi({
      "google:oauth-start": () => ({
        flowId: "flow-3",
        authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      }),
      "google:oauth-poll": () => ({ status: "pending" }),
    })

    const { result } = renderGoogleAuth({ id: "gcp", detectCredentials: false })

    await act(async () => {
      await result.current.handleOAuthLogin()
    })
    expect(result.current.authStatus).toBe("authenticating")
    expect(result.current.oauthFlowId).toBe("flow-3")

    await act(async () => {
      result.current.handleCancelOAuth()
    })

    expect(invoke).toHaveBeenCalledWith("google:oauth-cancel", { flowId: "flow-3" })
    expect(result.current.authStatus).toBe("pending")
    expect(result.current.oauthFlowId).toBeNull()
  })

  it("a poll still in flight from a cancelled sign-in cannot fail the next one", async () => {
    let settleStalePoll: (value: Result<"google:oauth-poll">) => void = () => {}
    let started = 0
    const invoke = installApi({
      "google:oauth-start": () => {
        started++
        return {
          flowId: `flow-${started}`,
          authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        }
      },
      "google:oauth-poll": ({ flowId }) => {
        if (flowId === "flow-1")
          return new Promise((resolve) => {
            settleStalePoll = resolve
          })
        return { status: "pending" }
      },
    })

    const { result } = renderGoogleAuth({ id: "gcp", detectCredentials: false })

    await act(async () => {
      await result.current.handleOAuthLogin()
    })
    act(() => result.current.handleCancelOAuth())
    await act(async () => {
      await result.current.handleOAuthLogin()
    })
    expect(result.current.oauthFlowId).toBe("flow-2")

    // flow-1's poll comes back only now, after the user has moved on.
    await act(async () => {
      settleStalePoll({ status: "failed", error: "Sign-in was denied" })
    })

    expect(result.current.authStatus).toBe("authenticating")
    expect(result.current.errorMessage).toBeNull()
    expect(result.current.oauthFlowId).toBe("flow-2")
    expect(invoke).not.toHaveBeenCalledWith("google:oauth-cancel", { flowId: "flow-2" })
  })

  it("marks OAuth unavailable ON MOUNT from the capability probe", async () => {
    installApi({ "google:oauth-available": () => ({ available: false }) })

    const { result } = renderGoogleAuth({ id: "gcp", detectCredentials: false })

    // No click required: the tab is known to be dead before it is offered.
    await waitFor(() => expect(result.current.oauthUnavailable).toBe(true))
    expect(callsTo("google:oauth-start")).toHaveLength(0)
    expect(result.current.authStatus).toBe("pending")
    expect(result.current.errorMessage).toBeNull()
  })

  it("treats an author-supplied client id as available without a round trip", async () => {
    installApi({ "google:oauth-available": () => ({ available: false }) })

    const { result } = renderGoogleAuth({
      id: "gcp",
      detectCredentials: false,
      oauthClientId: "custom.apps.googleusercontent.com",
      oauthClientSecret: "not-confidential",
    })

    await act(async () => {})
    expect(result.current.oauthUnavailable).toBe(false)
    expect(callsTo("google:oauth-available")).toHaveLength(0)
  })

  it("treats an author-supplied oauthClientFile as available without a round trip", async () => {
    installApi({ "google:oauth-available": () => ({ available: false }) })

    const { result } = renderGoogleAuth({
      id: "gcp",
      detectCredentials: false,
      oauthClientFile: "~/.config/gcloud/client_secret_example.json",
    })

    await act(async () => {})
    expect(result.current.oauthUnavailable).toBe(false)
    expect(callsTo("google:oauth-available")).toHaveLength(0)
  })

  it("sends oauthClientFile to MAIN on sign-in start", async () => {
    const invoke = installApi({
      "google:oauth-start": () => ({
        flowId: "flow-file",
        authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      }),
      "google:oauth-poll": () => ({ status: "pending" }),
    })

    const { result } = renderGoogleAuth({
      id: "gcp",
      detectCredentials: false,
      oauthClientFile: "~/.config/gcloud/client_secret_example.json",
    })

    await act(async () => {
      await result.current.handleOAuthLogin()
    })

    expect(invoke).toHaveBeenCalledWith("google:oauth-start", {
      clientFile: "~/.config/gcloud/client_secret_example.json",
    })
  })

  it("lets the operator pick a Desktop OAuth client JSON when none is configured", async () => {
    const invoke = installApi({
      "google:oauth-available": () => ({ available: false }),
      "native:show-open-dialog": () => ({
        filePaths: ["/tmp/client_secret_example.apps.googleusercontent.com.json"],
      }),
      "google:oauth-start": () => ({
        flowId: "flow-picked",
        authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      }),
      "google:oauth-poll": () => ({ status: "pending" }),
    })

    const { result } = renderGoogleAuth({ id: "gcp", detectCredentials: false })

    await waitFor(() => expect(result.current.oauthUnavailable).toBe(true))

    await act(async () => {
      await result.current.loadOAuthClientFromFile()
    })

    expect(result.current.oauthUnavailable).toBe(false)
    expect(result.current.oauthClientFileName).toBe(
      "client_secret_example.apps.googleusercontent.com.json",
    )
    expect(result.current.oauthClientFilePath).toBe(
      "/tmp/client_secret_example.apps.googleusercontent.com.json",
    )

    await act(async () => {
      await result.current.handleOAuthLogin()
    })

    expect(invoke).toHaveBeenCalledWith("google:oauth-start", {
      clientFile: "/tmp/client_secret_example.apps.googleusercontent.com.json",
    })
  })

  it("clearing a picked client JSON re-probes exactly once, through the probe effect", async () => {
    installApi({
      "google:oauth-available": () => ({ available: false }),
      "native:show-open-dialog": () => ({
        filePaths: ["/tmp/client_secret_example.apps.googleusercontent.com.json"],
      }),
    })

    const { result } = renderGoogleAuth({ id: "gcp", detectCredentials: false })
    await waitFor(() => expect(result.current.oauthUnavailable).toBe(true))

    await act(async () => {
      await result.current.loadOAuthClientFromFile()
    })
    expect(result.current.oauthUnavailable).toBe(false)
    const probesBeforeClear = callsTo("google:oauth-available").length

    await act(async () => {
      result.current.clearOAuthClientFile()
    })

    // One probe, not a second hand-rolled one racing the effect's.
    await waitFor(() => expect(result.current.oauthUnavailable).toBe(true))
    expect(callsTo("google:oauth-available")).toHaveLength(probesBeforeClear + 1)
    expect(result.current.oauthClientFilePath).toBeNull()
    expect(result.current.oauthClientFileName).toBeNull()
  })

  it("a failing re-probe after clearing leaves Sign-In selectable", async () => {
    installApi({
      "google:oauth-available": () => {
        throw new Error("IPC unavailable")
      },
      "native:show-open-dialog": () => ({
        filePaths: ["/tmp/client_secret_example.apps.googleusercontent.com.json"],
      }),
    })

    const { result } = renderGoogleAuth({ id: "gcp", detectCredentials: false })
    await act(async () => {
      await result.current.loadOAuthClientFromFile()
    })
    const probesBeforeClear = callsTo("google:oauth-available").length

    await act(async () => {
      result.current.clearOAuthClientFile()
    })
    await act(async () => {})

    // The probe effect's policy: an unanswerable probe leaves oauth-start (or
    // the Desktop client picker) the last word, rather than disabling Sign-In.
    expect(callsTo("google:oauth-available")).toHaveLength(probesBeforeClear + 1)
    expect(result.current.oauthUnavailable).toBe(false)
  })

  it("releases the loopback listener when the poll loop gives up", async () => {
    const invoke = installApi({
      "google:oauth-start": () => ({
        flowId: "flow-9",
        authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      }),
      "google:oauth-poll": () => ({ status: "failed", error: "Sign-in was denied" }),
    })

    const { result } = renderGoogleAuth({ id: "gcp", detectCredentials: false })

    await act(async () => {
      await result.current.handleOAuthLogin()
    })
    await waitFor(() => expect(result.current.authStatus).toBe("failed"))

    // A terminal failure must not strand MAIN's 127.0.0.1 listener — nor the
    // refresh token a late consent would deposit behind it.
    expect(invoke).toHaveBeenCalledWith("google:oauth-cancel", { flowId: "flow-9" })
  })

  it('"Check again" cancels an in-flight sign-in', async () => {
    const invoke = installApi({
      "google:oauth-start": () => ({
        flowId: "flow-10",
        authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      }),
      "google:oauth-poll": () => ({ status: "pending" }),
      "google:env-credentials": () => ({ found: false }),
    })

    const { result } = renderGoogleAuth({ id: "gcp", detectCredentials: ["env"] })
    await waitFor(() => expect(result.current.detectionStatus).toBe("done"))

    await act(async () => {
      await result.current.handleOAuthLogin()
    })
    expect(result.current.oauthFlowId).toBe("flow-10")

    // The retry link unmounts the whole form subtree — including the flow's own
    // Cancel button — so it has to release the flow itself.
    await act(async () => {
      result.current.handleRetryDetection()
    })

    expect(invoke).toHaveBeenCalledWith("google:oauth-cancel", { flowId: "flow-10" })
    expect(result.current.oauthFlowId).toBeNull()
  })

  it("marks OAuth unavailable when the build has no registered client", async () => {
    installApi({
      "google:oauth-start": () => ({ error: "OAuth login is not configured for this build" }),
    })

    const { result } = renderGoogleAuth({ id: "gcp", detectCredentials: false })

    await act(async () => {
      await result.current.handleOAuthLogin()
    })

    expect(result.current.oauthUnavailable).toBe(true)
    expect(result.current.authStatus).toBe("failed")
    expect(result.current.errorMessage).toBe("OAuth login is not configured for this build")
  })

  it("reports an expired authorization request inline", async () => {
    installApi({
      "google:oauth-start": () => ({
        flowId: "flow-4",
        authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      }),
      "google:oauth-poll": () => ({ status: "expired" }),
    })

    const { result } = renderGoogleAuth({ id: "gcp", detectCredentials: false })

    await act(async () => {
      await result.current.handleOAuthLogin()
    })

    await waitFor(() => expect(result.current.authStatus).toBe("failed"))
    expect(result.current.errorMessage).toBe("Authorization request expired. Please try again.")
    expect(result.current.oauthFlowId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Tab 3 — gcloud configuration
// ---------------------------------------------------------------------------

type GcloudConfigurationIpc = Result<"google:gcloud-configurations">["configurations"][number]

const GCLOUD_LISTING: Result<"google:gcloud-configurations"> = {
  configurations: [
    {
      name: "default",
      isActive: true,
      account: "dev@example.com",
      project: "proj-a",
      region: "us-east1",
      authType: "adc-user",
    },
    { name: "staging", isActive: false, project: "proj-s", authType: "config-only" },
  ],
  activeConfiguration: "default",
  configRoot: "/home/u/.config/gcloud",
  adc: {
    path: "/home/u/.config/gcloud/application_default_credentials.json",
    type: "authorized_user",
    clientEmail: "dev@example.com",
  },
}

const ADC_SIGNED_IN: Handlers = {
  "google:env-credentials": () => ({
    found: true,
    valid: true,
    source: "adc",
    credentialType: "authorized_user",
    account: { principal: "dev@example.com", accountType: "user" },
  }),
}

describe("useGoogleAuth — gcloud tab", () => {
  it("lists configurations from disk and preselects the active usable one", async () => {
    installApi({ ...ADC_SIGNED_IN, "google:gcloud-configurations": () => GCLOUD_LISTING })

    const { result } = renderGoogleAuth({ id: "gcp", detectCredentials: false })

    await act(async () => {
      await result.current.loadGcloudConfigs()
    })

    expect(result.current.gcloudConfigs).toHaveLength(2)
    expect(result.current.selectedConfig?.name).toBe("default")
    expect(result.current.adcPrincipal).toEqual({
      status: "signed-in",
      principal: "dev@example.com",
      credentialType: "authorized_user",
    })
    expect(result.current.adcInfo?.clientEmail).toBe("dev@example.com")
  })

  it("refreshing keeps the user's pick, as the fresh entry, while it is still usable", async () => {
    const prod: GcloudConfigurationIpc = {
      name: "prod",
      isActive: false,
      project: "proj-p",
      authType: "adc-service-account",
    }
    let listing = { ...GCLOUD_LISTING, configurations: [...GCLOUD_LISTING.configurations, prod] }
    installApi({ ...ADC_SIGNED_IN, "google:gcloud-configurations": () => listing })

    const { result } = renderGoogleAuth({ id: "gcp", detectCredentials: false })

    await act(async () => {
      await result.current.loadGcloudConfigs()
    })
    expect(result.current.selectedConfig?.name).toBe("default")

    act(() =>
      result.current.setSelectedConfig(
        result.current.gcloudConfigs.find((c) => c.name === "prod")!,
      ),
    )
    listing = {
      ...listing,
      configurations: [...GCLOUD_LISTING.configurations, { ...prod, project: "proj-p2" }],
    }
    await act(async () => {
      await result.current.loadGcloudConfigs()
    })

    expect(result.current.selectedConfig).toEqual({ ...prod, project: "proj-p2" })
  })

  it("refreshing clears the selection once no usable configuration is left", async () => {
    let listing = GCLOUD_LISTING
    installApi({ ...ADC_SIGNED_IN, "google:gcloud-configurations": () => listing })

    const { result } = renderGoogleAuth({ id: "gcp", detectCredentials: false })

    await act(async () => {
      await result.current.loadGcloudConfigs()
    })
    expect(result.current.selectedConfig?.name).toBe("default")

    // `gcloud auth application-default revoke`: every configuration is config-only.
    listing = {
      ...GCLOUD_LISTING,
      configurations: GCLOUD_LISTING.configurations.map((c) => ({ ...c, authType: "config-only" })),
    }
    await act(async () => {
      await result.current.loadGcloudConfigs()
    })

    // Not the stale 'default', whose settings would otherwise still be sent.
    expect(result.current.selectedConfig).toBeNull()
  })

  it("honours the gcloudConfiguration prop and authenticates against the existing ADC", async () => {
    const invoke = installApi({
      "google:env-credentials": () => ({
        found: true,
        valid: true,
        source: "adc",
        credentialType: "service_account",
        account: { principal: "ops@example.com", accountType: "service_account" },
      }),
      "google:gcloud-configurations": () => ({
        ...GCLOUD_LISTING,
        adc: { ...GCLOUD_LISTING.adc!, type: "service_account" },
        configurations: [
          ...GCLOUD_LISTING.configurations,
          {
            name: "prod",
            isActive: false,
            account: "ops@example.com",
            project: "proj-p",
            authType: "adc-service-account",
          },
        ],
      }),
      "google:gcloud-auth": () => ({
        valid: true,
        account: { principal: "ops@example.com", accountType: "service_account" },
        projectId: "proj-p",
        credentialsPath: "/home/u/.config/gcloud/application_default_credentials.json",
      }),
      "google:check-project": () => ({ enabled: true }),
    })

    const { result } = renderGoogleAuth({
      id: "gcp",
      gcloudConfiguration: "prod",
      detectCredentials: false,
    })

    await act(async () => {
      await result.current.loadGcloudConfigs()
    })
    expect(result.current.selectedConfig?.name).toBe("prod")

    await act(async () => {
      await result.current.handleGcloudAuth()
    })

    expect(invoke).toHaveBeenCalledWith("google:gcloud-auth", {
      blockId: "gcp",
      configuration: "prod",
      projectId: "proj-p",
    })
    expect(result.current.authStatus).toBe("authenticated")
    expect(registerOutputs).toHaveBeenCalledWith(
      "gcp",
      outputs({
        GOOGLE_APPLICATION_CREDENTIALS:
          "/home/u/.config/gcloud/application_default_credentials.json",
        CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE:
          "/home/u/.config/gcloud/application_default_credentials.json",
        GOOGLE_CLOUD_PROJECT: "proj-p",
        CLOUDSDK_CORE_PROJECT: "proj-p",
        GOOGLE_PROJECT: "proj-p",
        CLOUDSDK_CORE_ACCOUNT: "ops@example.com",
        GOOGLE_AUTH_TYPE: "service_account",
      }),
    )
  })

  it("routes to the project picker when the configuration sets no core/project", async () => {
    installApi({
      ...ADC_SIGNED_IN,
      "google:gcloud-configurations": () => ({
        ...GCLOUD_LISTING,
        configurations: [
          {
            name: "scratch",
            isActive: true,
            account: "dev@example.com",
            // Listed before `gcloud config set compute/region us-west1` ran.
            region: "us-east1",
            authType: "adc-user",
          },
        ],
      }),
      // No projectId: `gcloud config configurations create scratch` without a
      // `core/project`, and no `project` prop to fall back on. MAIN reads the
      // configuration afresh and says which region it wrote.
      "google:gcloud-auth": ({ region }) => ({
        valid: true,
        account: { principal: "dev@example.com", accountType: "user" },
        credentialsPath: "/home/u/.config/gcloud/application_default_credentials.json",
        region: region ?? "us-west1",
        projects: [
          { projectId: "proj-one", displayName: "Project One" },
          { projectId: "proj-two", displayName: "Project Two" },
        ],
      }),
      // MAIN keeps the region the block authenticated with when none is sent.
      "google:set-project": ({ region }) => ({
        ok: true,
        projectName: "Project Two",
        region: region ?? "us-west1",
      }),
      "google:check-project": () => ({ enabled: true }),
    })

    const { result } = renderGoogleAuth({ id: "gcp", detectCredentials: false })

    await act(async () => {
      await result.current.loadGcloudConfigs()
    })
    await act(async () => {
      await result.current.handleGcloudAuth()
    })

    // NOT 'authenticated' with a blank project: the user picks one first.
    expect(result.current.authStatus).toBe("select_project")
    expect(result.current.projects).toHaveLength(2)
    expectNoAuthenticatedPublish(registerOutputs)
    expect(callsTo("google:set-project")).toHaveLength(0)

    await act(async () => {
      await result.current.handleProjectSelect({
        projectId: "proj-two",
        displayName: "Project Two",
      })
    })

    // The listing's stale region is sent to neither: MAIN's fresh read of the
    // configuration decides, and survives the picker detour on the block's
    // credential in MAIN.
    expect(callsTo("google:gcloud-auth")).toEqual([{ blockId: "gcp", configuration: "scratch" }])
    expect(callsTo("google:set-project")).toEqual([{ blockId: "gcp", projectId: "proj-two" }])
    expect(result.current.authStatus).toBe("authenticated")
    expect(registerOutputs).toHaveBeenLastCalledWith(
      "gcp",
      expect.objectContaining({
        GOOGLE_CLOUD_PROJECT: "proj-two",
        GOOGLE_CLOUD_REGION: "us-west1",
        CLOUDSDK_COMPUTE_REGION: "us-west1",
        GOOGLE_REGION: "us-west1",
      }),
    )
  })

  it("auto-selects the single visible project when the configuration sets none", async () => {
    const invoke = installApi({
      ...ADC_SIGNED_IN,
      "google:gcloud-configurations": () => ({
        ...GCLOUD_LISTING,
        configurations: [
          { name: "scratch", isActive: true, account: "dev@example.com", authType: "adc-user" },
        ],
      }),
      "google:gcloud-auth": () => ({
        valid: true,
        account: { principal: "dev@example.com", accountType: "user" },
        credentialsPath: "/home/u/.config/gcloud/application_default_credentials.json",
        projects: [{ projectId: "proj-solo", displayName: "Solo Project" }],
      }),
      "google:set-project": () => ({ ok: true, projectName: "Solo Project" }),
      "google:check-project": () => ({ enabled: true }),
    })

    const { result } = renderGoogleAuth({ id: "gcp", detectCredentials: false })

    await act(async () => {
      await result.current.loadGcloudConfigs()
    })
    await act(async () => {
      await result.current.handleGcloudAuth()
    })

    expect(result.current.authStatus).toBe("authenticated")
    expect(invoke).toHaveBeenCalledWith("google:set-project", {
      blockId: "gcp",
      projectId: "proj-solo",
    })
    expect(registerOutputs).toHaveBeenCalledWith(
      "gcp",
      outputs({
        GOOGLE_APPLICATION_CREDENTIALS:
          "/home/u/.config/gcloud/application_default_credentials.json",
        CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE:
          "/home/u/.config/gcloud/application_default_credentials.json",
        GOOGLE_CLOUD_PROJECT: "proj-solo",
        CLOUDSDK_CORE_PROJECT: "proj-solo",
        GOOGLE_PROJECT: "proj-solo",
        CLOUDSDK_CORE_ACCOUNT: "dev@example.com",
        GOOGLE_AUTH_TYPE: "authorized_user",
      }),
    )
  })

  it("auto-selecting the single project publishes the region/zone MAIN read, not the listing's", async () => {
    installApi({
      ...ADC_SIGNED_IN,
      "google:gcloud-configurations": () => ({
        ...GCLOUD_LISTING,
        configurations: [
          {
            name: "scratch",
            isActive: true,
            account: "dev@example.com",
            // Listed before `gcloud config set compute/region us-west1` ran.
            region: "us-east1",
            zone: "us-east1-b",
            authType: "adc-user",
          },
        ],
      }),
      // MAIN reads the configuration afresh and says what it wrote.
      "google:gcloud-auth": ({ region, zone }) => ({
        valid: true,
        account: { principal: "dev@example.com", accountType: "user" },
        credentialsPath: "/home/u/.config/gcloud/application_default_credentials.json",
        region: region ?? "us-west1",
        zone: zone ?? "us-west1-a",
        projects: [{ projectId: "proj-solo", displayName: "Solo Project" }],
      }),
      // MAIN keeps the block's own region/zone when none is sent.
      "google:set-project": ({ region, zone }) => ({
        ok: true,
        projectName: "Solo Project",
        region: region ?? "us-west1",
        zone: zone ?? "us-west1-a",
      }),
      "google:check-project": () => ({ enabled: true }),
    })

    const { result } = renderGoogleAuth({ id: "gcp", detectCredentials: false })

    await act(async () => {
      await result.current.loadGcloudConfigs()
    })
    await act(async () => {
      await result.current.handleGcloudAuth()
    })

    expect(callsTo("google:gcloud-auth")).toEqual([{ blockId: "gcp", configuration: "scratch" }])
    expect(callsTo("google:set-project")).toEqual([{ blockId: "gcp", projectId: "proj-solo" }])
    expect(result.current.authStatus).toBe("authenticated")
    expect(registerOutputs).toHaveBeenLastCalledWith(
      "gcp",
      outputs({
        GOOGLE_APPLICATION_CREDENTIALS:
          "/home/u/.config/gcloud/application_default_credentials.json",
        CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE:
          "/home/u/.config/gcloud/application_default_credentials.json",
        GOOGLE_CLOUD_PROJECT: "proj-solo",
        CLOUDSDK_CORE_PROJECT: "proj-solo",
        GOOGLE_PROJECT: "proj-solo",
        CLOUDSDK_CORE_ACCOUNT: "dev@example.com",
        GOOGLE_CLOUD_REGION: "us-west1",
        CLOUDSDK_COMPUTE_REGION: "us-west1",
        GOOGLE_REGION: "us-west1",
        CLOUDSDK_COMPUTE_ZONE: "us-west1-a",
        GOOGLE_ZONE: "us-west1-a",
        GOOGLE_AUTH_TYPE: "authorized_user",
      }),
    )
  })

  it("says so out loud when it authenticates with no project at all", async () => {
    installApi({
      ...ADC_SIGNED_IN,
      "google:gcloud-configurations": () => ({
        ...GCLOUD_LISTING,
        configurations: [
          { name: "scratch", isActive: true, account: "dev@example.com", authType: "adc-user" },
        ],
      }),
      // Authenticated, no project, and the principal cannot enumerate any.
      "google:gcloud-auth": () => ({
        valid: true,
        account: { principal: "dev@example.com", accountType: "user" },
        credentialsPath: "/home/u/.config/gcloud/application_default_credentials.json",
      }),
    })

    const { result } = renderGoogleAuth({ id: "gcp", detectCredentials: false })

    await act(async () => {
      await result.current.loadGcloudConfigs()
    })
    await act(async () => {
      await result.current.handleGcloudAuth()
    })

    expect(result.current.authStatus).toBe("authenticated")
    // The green card must not silently claim readiness with a blank project.
    expect(result.current.warningMessage).toMatch(/no Google Cloud project is set/)
    expect(registerOutputs).toHaveBeenCalledWith(
      "gcp",
      outputs({
        GOOGLE_APPLICATION_CREDENTIALS:
          "/home/u/.config/gcloud/application_default_credentials.json",
        CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE:
          "/home/u/.config/gcloud/application_default_credentials.json",
        CLOUDSDK_CORE_ACCOUNT: "dev@example.com",
        GOOGLE_AUTH_TYPE: "authorized_user",
      }),
    )
  })

  it("refuses to sign in when there are no Application Default Credentials", async () => {
    const { adc: _adc, ...listingWithoutAdc } = GCLOUD_LISTING
    const invoke = installApi({ "google:gcloud-configurations": () => listingWithoutAdc })

    const { result } = renderGoogleAuth({ id: "gcp", detectCredentials: false })

    await act(async () => {
      await result.current.loadGcloudConfigs()
    })
    expect(result.current.adcPrincipal).toEqual({ status: "missing" })
    expect(result.current.selectedConfig).toBeNull()

    await act(async () => {
      await result.current.handleGcloudAuth()
    })

    expect(result.current.authStatus).toBe("failed")
    expect(result.current.errorMessage).toBe(
      "No usable Application Default Credentials. Run `gcloud auth application-default login`, then click Refresh.",
    )
    expect(callsTo("google:env-credentials")).toEqual([])
    expect(invoke).not.toHaveBeenCalledWith("google:gcloud-auth", expect.anything())
  })

  it("keeps the choice of no configuration across a refresh, and sends none", async () => {
    installApi({
      ...ADC_SIGNED_IN,
      "google:gcloud-configurations": () => GCLOUD_LISTING,
      "google:gcloud-auth": () => ({
        valid: true,
        account: { principal: "dev@example.com", accountType: "user" },
        projectId: "proj-z",
        credentialsPath: "/home/u/.config/gcloud/application_default_credentials.json",
      }),
    })

    const { result } = renderGoogleAuth({ id: "gcp", detectCredentials: false })

    await act(async () => {
      await result.current.loadGcloudConfigs()
    })
    expect(result.current.selectedConfig?.name).toBe("default")

    act(() => result.current.setSelectedConfig(null))
    await act(async () => {
      await result.current.loadGcloudConfigs()
    })
    expect(result.current.selectedConfig).toBeNull()

    await act(async () => {
      await result.current.handleGcloudAuth()
    })
    expect(callsTo("google:gcloud-auth")).toEqual([{ blockId: "gcp" }])
  })

  it("reports why the Application Default Credentials cannot be used", async () => {
    installApi({
      "google:gcloud-configurations": () => GCLOUD_LISTING,
      "google:env-credentials": () => ({
        found: true,
        valid: false,
        source: "adc",
        warning: "invalid_grant: Token has been expired or revoked.",
      }),
    })

    const { result } = renderGoogleAuth({ id: "gcp", detectCredentials: false })

    await act(async () => {
      await result.current.loadGcloudConfigs()
    })

    expect(result.current.adcPrincipal).toEqual({
      status: "unusable",
      reason: "invalid_grant: Token has been expired or revoked.",
    })
    expect(result.current.selectedConfig).toBeNull()
  })

  describe("when a configuration is set up for another account", () => {
    const OTHER_ACCOUNT_LISTING: Result<"google:gcloud-configurations"> = {
      ...GCLOUD_LISTING,
      configurations: [
        {
          name: "default",
          isActive: true,
          account: "someone-else@example.org",
          project: "other-org-proj",
          region: "us-east1",
          authType: "adc-user",
        },
      ],
    }

    it("does not select it, and signs in with the credentials alone", async () => {
      const invoke = installApi({
        ...ADC_SIGNED_IN,
        "google:gcloud-configurations": () => OTHER_ACCOUNT_LISTING,
        "google:gcloud-auth": () => ({
          valid: true,
          account: { principal: "dev@example.com", accountType: "user" },
          credentialsPath: "/home/u/.config/gcloud/application_default_credentials.json",
          projects: [
            { projectId: "proj-a", displayName: "A" },
            { projectId: "proj-b", displayName: "B" },
          ],
        }),
      })

      const { result } = renderGoogleAuth({ id: "gcp", detectCredentials: false })

      await act(async () => {
        await result.current.loadGcloudConfigs()
      })
      expect(result.current.selectedConfig).toBeNull()

      await act(async () => {
        await result.current.handleGcloudAuth()
      })

      expect(callsTo("google:gcloud-auth")).toEqual([{ blockId: "gcp" }])
      expect(invoke).not.toHaveBeenCalledWith(
        "google:gcloud-auth",
        expect.objectContaining({ projectId: "other-org-proj" }),
      )
      expect(result.current.authStatus).toBe("select_project")
    })

    it("still offers it when the credentials are a service account's, not a user login", async () => {
      installApi({
        "google:env-credentials": () => ({
          found: true,
          valid: true,
          source: "adc",
          credentialType: "impersonated_service_account",
          account: { principal: "deployer@proj.iam.gserviceaccount.com", accountType: "user" },
        }),
        "google:gcloud-configurations": () => OTHER_ACCOUNT_LISTING,
      })

      const { result } = renderGoogleAuth({ id: "gcp", detectCredentials: false })

      await act(async () => {
        await result.current.loadGcloudConfigs()
      })

      expect(result.current.selectedConfig?.name).toBe("default")
    })

    it("does not preselect it when the gcloudConfiguration prop names it", async () => {
      installApi({
        ...ADC_SIGNED_IN,
        "google:gcloud-configurations": () => ({
          ...OTHER_ACCOUNT_LISTING,
          configurations: [
            ...OTHER_ACCOUNT_LISTING.configurations,
            { name: "mine", isActive: false, account: "dev@example.com", authType: "adc-user" },
          ],
        }),
      })

      const { result } = renderGoogleAuth({
        id: "gcp",
        gcloudConfiguration: "default",
        detectCredentials: false,
      })

      await act(async () => {
        await result.current.loadGcloudConfigs()
      })

      expect(result.current.selectedConfig?.name).toBe("mine")
    })
  })

  it('"No default region" falls through to the configuration\'s own compute/region', async () => {
    installApi({
      ...ADC_SIGNED_IN,
      "google:gcloud-configurations": () => GCLOUD_LISTING,
      // MAIN falls back to the configuration's compute/region when none is sent.
      "google:gcloud-auth": ({ region }) => ({
        valid: true,
        account: { principal: "dev@example.com", accountType: "user" },
        projectId: "proj-a",
        credentialsPath: "/home/u/.config/gcloud/application_default_credentials.json",
        region: region ?? "us-east1",
      }),
      "google:check-project": () => ({ enabled: true }),
    })

    const { result } = renderGoogleAuth({
      id: "gcp",
      defaultRegion: "europe-west1",
      detectCredentials: false,
    })

    await act(async () => {
      await result.current.loadGcloudConfigs()
    })
    act(() => result.current.setSelectedRegion(""))
    await act(async () => {
      await result.current.handleGcloudAuth()
    })

    // Not the cleared prop: no region is sent, so MAIN applies the `default`
    // configuration's compute/region, and the block publishes it.
    expect(callsTo("google:gcloud-auth")).toEqual([
      { blockId: "gcp", configuration: "default", projectId: "proj-a" },
    ])
    expect(registerOutputs).toHaveBeenLastCalledWith(
      "gcp",
      expect.objectContaining({
        GOOGLE_CLOUD_REGION: "us-east1",
        CLOUDSDK_COMPUTE_REGION: "us-east1",
        GOOGLE_REGION: "us-east1",
      }),
    )
  })

  it("publishes the region/zone MAIN read from the configuration, not the listing the renderer holds", async () => {
    const invoke = installApi({
      ...ADC_SIGNED_IN,
      // Listed before `gcloud config set compute/region us-west1` (and
      // compute/zone) ran.
      "google:gcloud-configurations": () => ({
        ...GCLOUD_LISTING,
        configurations: [
          {
            name: "default",
            isActive: true,
            account: "dev@example.com",
            project: "proj-a",
            region: "us-east1",
            zone: "us-east1-b",
            authType: "adc-user",
          },
        ],
      }),
      // MAIN reads the configuration afresh and falls back to its compute
      // defaults when the renderer sent none; it says what it wrote.
      "google:gcloud-auth": ({ region, zone }) => ({
        valid: true,
        account: { principal: "dev@example.com", accountType: "user" },
        projectId: "proj-a",
        credentialsPath: "/home/u/.config/gcloud/application_default_credentials.json",
        region: region ?? "us-west1",
        zone: zone ?? "us-west1-a",
      }),
      "google:check-project": () => ({ enabled: true }),
    })

    const { result } = renderGoogleAuth({ id: "gcp", detectCredentials: false })

    await act(async () => {
      await result.current.loadGcloudConfigs()
    })
    await act(async () => {
      await result.current.handleGcloudAuth()
    })

    expect(invoke).toHaveBeenCalledWith("google:gcloud-auth", {
      blockId: "gcp",
      configuration: "default",
      projectId: "proj-a",
    })
    expect(result.current.authStatus).toBe("authenticated")
    expect(registerOutputs).toHaveBeenLastCalledWith(
      "gcp",
      outputs({
        GOOGLE_APPLICATION_CREDENTIALS:
          "/home/u/.config/gcloud/application_default_credentials.json",
        CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE:
          "/home/u/.config/gcloud/application_default_credentials.json",
        GOOGLE_CLOUD_PROJECT: "proj-a",
        CLOUDSDK_CORE_PROJECT: "proj-a",
        GOOGLE_PROJECT: "proj-a",
        CLOUDSDK_CORE_ACCOUNT: "dev@example.com",
        GOOGLE_CLOUD_REGION: "us-west1",
        CLOUDSDK_COMPUTE_REGION: "us-west1",
        GOOGLE_REGION: "us-west1",
        CLOUDSDK_COMPUTE_ZONE: "us-west1-a",
        GOOGLE_ZONE: "us-west1-a",
        GOOGLE_AUTH_TYPE: "authorized_user",
      }),
    )
  })

  it("sends an explicitly picked region/zone and publishes it over the configuration's", async () => {
    installApi({
      ...ADC_SIGNED_IN,
      "google:gcloud-configurations": () => GCLOUD_LISTING,
      // The configuration's compute/region only applies when none is sent.
      "google:gcloud-auth": ({ region, zone }) => ({
        valid: true,
        account: { principal: "dev@example.com", accountType: "user" },
        projectId: "proj-a",
        credentialsPath: "/home/u/.config/gcloud/application_default_credentials.json",
        region: region ?? "us-east1",
        ...(zone ? { zone } : {}),
      }),
      "google:check-project": () => ({ enabled: true }),
    })

    const { result } = renderGoogleAuth({
      id: "gcp",
      defaultRegion: "europe-west1",
      defaultZone: "europe-west4-a",
      detectCredentials: false,
    })

    await act(async () => {
      await result.current.loadGcloudConfigs()
    })
    act(() => result.current.setSelectedRegion("europe-west4"))
    await act(async () => {
      await result.current.handleGcloudAuth()
    })

    expect(callsTo("google:gcloud-auth")).toEqual([
      {
        blockId: "gcp",
        configuration: "default",
        projectId: "proj-a",
        region: "europe-west4",
        zone: "europe-west4-a",
      },
    ])
    expect(result.current.authStatus).toBe("authenticated")
    expect(registerOutputs).toHaveBeenLastCalledWith(
      "gcp",
      expect.objectContaining({
        GOOGLE_CLOUD_REGION: "europe-west4",
        CLOUDSDK_COMPUTE_REGION: "europe-west4",
        GOOGLE_REGION: "europe-west4",
        CLOUDSDK_COMPUTE_ZONE: "europe-west4-a",
        GOOGLE_ZONE: "europe-west4-a",
      }),
    )
  })

  it('"Change project" keeps publishing the configuration\'s compute/region', async () => {
    installApi({
      ...ADC_SIGNED_IN,
      "google:gcloud-configurations": () => GCLOUD_LISTING,
      // MAIN falls back to the configuration's compute/region when none is sent.
      "google:gcloud-auth": ({ region }) => ({
        valid: true,
        account: { principal: "dev@example.com", accountType: "user" },
        projectId: "proj-a",
        credentialsPath: "/home/u/.config/gcloud/application_default_credentials.json",
        region: region ?? "us-east1",
        projects: [
          { projectId: "proj-a", displayName: "Project A" },
          { projectId: "proj-b", displayName: "Project B" },
        ],
      }),
      // MAIN keeps the block's own region when none is requested, and says so.
      "google:set-project": ({ region }) => ({
        ok: true,
        projectName: "Project B",
        region: region ?? "us-east1",
      }),
      "google:check-project": () => ({ enabled: true }),
    })

    const { result } = renderGoogleAuth({ id: "gcp", detectCredentials: false })

    await act(async () => {
      await result.current.loadGcloudConfigs()
    })
    await act(async () => {
      await result.current.handleGcloudAuth()
    })
    expect(registerOutputs).toHaveBeenLastCalledWith(
      "gcp",
      expect.objectContaining({ GOOGLE_CLOUD_PROJECT: "proj-a", GOOGLE_CLOUD_REGION: "us-east1" }),
    )

    await act(async () => {
      await result.current.handleChangeProject()
    })
    await act(async () => {
      await result.current.handleProjectSelect({ projectId: "proj-b", displayName: "Project B" })
    })

    // The renderer no longer knows the configuration's region; MAIN does.
    expect(callsTo("google:set-project")).toEqual([{ blockId: "gcp", projectId: "proj-b" }])
    expect(result.current.authStatus).toBe("authenticated")
    expect(registerOutputs).toHaveBeenLastCalledWith(
      "gcp",
      outputs({
        GOOGLE_APPLICATION_CREDENTIALS:
          "/home/u/.config/gcloud/application_default_credentials.json",
        CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE:
          "/home/u/.config/gcloud/application_default_credentials.json",
        GOOGLE_CLOUD_PROJECT: "proj-b",
        CLOUDSDK_CORE_PROJECT: "proj-b",
        GOOGLE_PROJECT: "proj-b",
        CLOUDSDK_CORE_ACCOUNT: "dev@example.com",
        GOOGLE_CLOUD_REGION: "us-east1",
        CLOUDSDK_COMPUTE_REGION: "us-east1",
        GOOGLE_REGION: "us-east1",
        GOOGLE_AUTH_TYPE: "authorized_user",
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// Post-auth
// ---------------------------------------------------------------------------

describe("useGoogleAuth — post-authentication", () => {
  it("surfaces a project-access warning without failing the auth", async () => {
    installApi({
      "google:validate-credentials": () => ({
        valid: true,
        account: {
          principal: "sa@key-project.iam.gserviceaccount.com",
          accountType: "service_account",
        },
        projectId: "proj-x",
        credentialType: "service_account",
        credentialsPath: "/tmp/runbooks-gcp-6/adc.json",
      }),
      "google:check-project": () => ({
        enabled: false,
        warning: 'This credential cannot read project "proj-x"',
      }),
    })

    const { result } = renderGoogleAuth({ id: "gcp", project: "proj-x", detectCredentials: false })

    act(() => result.current.setServiceAccountKey(SA_KEY))
    await act(async () => {
      result.current.handleServiceAccountSubmit()
    })

    await waitFor(() => expect(result.current.authStatus).toBe("authenticated"))
    expect(result.current.warningMessage).toBe('This credential cannot read project "proj-x"')
  })

  it('"Change project" loads the picker when the list is empty', async () => {
    const invoke = installApi({
      "google:projects": () => ({
        projects: [{ projectId: "proj-one", displayName: "Project One" }],
      }),
    })

    const { result } = renderGoogleAuth({ id: "gcp", detectCredentials: false })

    await act(async () => {
      await result.current.handleChangeProject()
    })

    expect(result.current.authStatus).toBe("select_project")
    expect(invoke).toHaveBeenCalledWith("google:projects", { blockId: "gcp" })
    expect(result.current.projects).toHaveLength(1)
  })

  it('"Change project" surfaces a project-list failure instead of swallowing it', async () => {
    installApi({
      "google:projects": () => {
        throw new Error("Cloud Resource Manager API has not been used")
      },
    })

    const { result } = renderGoogleAuth({ id: "gcp", detectCredentials: false })

    await act(async () => {
      await result.current.handleChangeProject()
    })

    expect(result.current.authStatus).toBe("select_project")
    expect(result.current.projects).toEqual([])
    expect(result.current.errorMessage).toBe("Cloud Resource Manager API has not been used")
  })

  it('cancelling "Change project" returns to the success card and keeps the outputs', async () => {
    installApi({
      "google:validate-credentials": () => ({
        valid: true,
        account: {
          principal: "sa@key-project.iam.gserviceaccount.com",
          accountType: "service_account",
        },
        projectId: "proj-x",
        credentialType: "service_account",
        credentialsPath: "/tmp/runbooks-gcp-cp/adc.json",
      }),
      "google:projects": () => ({
        projects: [],
        error: "Cloud Resource Manager API has not been used",
      }),
    })

    const { result } = renderGoogleAuth({ id: "gcp", project: "proj-x", detectCredentials: false })

    act(() => result.current.setServiceAccountKey(SA_KEY))
    await act(async () => {
      result.current.handleServiceAccountSubmit()
    })
    await waitFor(() => expect(result.current.authStatus).toBe("authenticated"))
    const accountBefore = result.current.accountInfo
    const publishedOutputs = outputs({
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/runbooks-gcp-cp/adc.json",
      CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: "/tmp/runbooks-gcp-cp/adc.json",
      GOOGLE_CLOUD_PROJECT: "proj-x",
      CLOUDSDK_CORE_PROJECT: "proj-x",
      GOOGLE_PROJECT: "proj-x",
      CLOUDSDK_CORE_ACCOUNT: "sa@key-project.iam.gserviceaccount.com",
      GOOGLE_AUTH_TYPE: "service_account",
    })
    expect(registerOutputs).toHaveBeenLastCalledWith("gcp", publishedOutputs)

    await act(async () => {
      await result.current.handleChangeProject()
    })
    act(() => result.current.setProjectSearch("proj"))
    expect(result.current.authStatus).toBe("select_project")
    expect(result.current.errorMessage).toBe("Cloud Resource Manager API has not been used")

    act(() => result.current.handleCancelProjectSelect())

    // Backing out of the picker is not a re-authentication: the credential and
    // the outputs a `<Command googleAuthId>` injects are exactly as they were.
    expect(result.current.authStatus).toBe("authenticated")
    expect(result.current.accountInfo).toEqual(accountBefore)
    expect(result.current.errorMessage).toBeNull()
    expect(result.current.projectSearch).toBe("")
    expect(registerOutputs).toHaveBeenLastCalledWith("gcp", publishedOutputs)
  })

  it("cancelling the picker a fresh sign-in routed into still starts over", async () => {
    installApi({
      "google:oauth-start": () => ({
        flowId: "flow-cancel",
        authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      }),
      "google:oauth-poll": () => ({
        status: "complete",
        account: { principal: "dev@example.com", accountType: "user" },
        credentialsPath: "/tmp/runbooks-gcp-fresh/adc.json",
        projects: [
          { projectId: "proj-one", displayName: "Project One" },
          { projectId: "proj-two", displayName: "Project Two" },
        ],
      }),
    })

    const { result } = renderGoogleAuth({ id: "gcp", detectCredentials: false })

    await act(async () => {
      await result.current.handleOAuthLogin()
    })
    await waitFor(() => expect(result.current.authStatus).toBe("select_project"))

    act(() => result.current.handleCancelProjectSelect())

    // Nothing was committed, so there is no success card to return to.
    expect(result.current.authStatus).toBe("pending")
    expect(result.current.accountInfo).toBeNull()
    expect(registerOutputs).toHaveBeenLastCalledWith("gcp", { __AUTHENTICATED: "false" })
  })

  it('a failed "Change project" commit does not let a later picker Cancel restore the old card', async () => {
    let projectsListed = false
    installApi({
      "google:validate-credentials": () => ({
        valid: true,
        account: {
          principal: "sa@key-project.iam.gserviceaccount.com",
          accountType: "service_account",
        },
        projectId: "proj-x",
        credentialType: "service_account",
        credentialsPath: "/tmp/runbooks-gcp-sa/adc.json",
      }),
      "google:projects": () => {
        projectsListed = true
        return {
          projects: [
            { projectId: "proj-x", displayName: "Project X" },
            { projectId: "proj-y", displayName: "Project Y" },
          ],
        }
      },
      "google:set-project": () => ({ ok: false, error: "Permission denied on proj-y" }),
      "google:oauth-start": () => ({
        flowId: "flow-after",
        authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      }),
      "google:oauth-poll": () => ({
        status: "complete",
        account: { principal: "dev@example.com", accountType: "user" },
        credentialsPath: "/tmp/runbooks-gcp-after/adc.json",
        projects: [
          { projectId: "proj-one", displayName: "Project One" },
          { projectId: "proj-two", displayName: "Project Two" },
        ],
      }),
    })

    const { result } = renderGoogleAuth({ id: "gcp", detectCredentials: false })

    act(() => result.current.setServiceAccountKey(SA_KEY))
    await act(async () => {
      result.current.handleServiceAccountSubmit()
    })
    await waitFor(() => expect(result.current.authStatus).toBe("authenticated"))

    await act(async () => {
      await result.current.handleChangeProject()
    })
    expect(projectsListed).toBe(true)
    await act(async () => {
      await result.current.handleProjectSelect({ projectId: "proj-y", displayName: "Project Y" })
    })
    expect(result.current.authStatus).toBe("failed")

    // The user signs in again, and that flow lands on the picker.
    await act(async () => {
      await result.current.handleOAuthLogin()
    })
    await waitFor(() => expect(result.current.authStatus).toBe("select_project"))

    act(() => result.current.handleCancelProjectSelect())

    // The new flow withdrew the old outputs, so a green card here would be a lie.
    expect(result.current.authStatus).toBe("pending")
    expect(registerOutputs).toHaveBeenLastCalledWith("gcp", { __AUTHENTICATED: "false" })
  })

  it("re-authenticating clears the account, the projects, and the detection state", async () => {
    installApi({
      "google:validate-credentials": () => ({
        valid: true,
        account: {
          principal: "sa@key-project.iam.gserviceaccount.com",
          accountType: "service_account",
        },
        projectId: "proj-x",
        credentialType: "service_account",
        credentialsPath: "/tmp/runbooks-gcp-7/adc.json",
      }),
    })

    const { result } = renderGoogleAuth({ id: "gcp", project: "proj-x", detectCredentials: false })

    act(() => result.current.setServiceAccountKey(SA_KEY))
    await act(async () => {
      result.current.handleServiceAccountSubmit()
    })
    await waitFor(() => expect(result.current.authStatus).toBe("authenticated"))

    act(() => result.current.handleManualAuth())

    expect(result.current.authStatus).toBe("pending")
    expect(result.current.accountInfo).toBeNull()
    expect(result.current.projects).toEqual([])
    expect(result.current.detectedCredentials).toBeNull()
    expect(result.current.detectionStatus).toBe("done")
  })

  it("re-authenticating WITHDRAWS the published credential path, not just the card", async () => {
    // The regression. The card going blue used to leave the block's outputs
    // standing, so a `<Command googleAuthId>` kept injecting
    // GOOGLE_APPLICATION_CREDENTIALS for a file MAIN released the moment the
    // next sign-in materialised its replacement — and because the Run button
    // reads `__AUTHENTICATED`, it stayed enabled the whole time. gcloud then
    // failed with "Failed to load credential file … was not found".
    installApi({
      "google:validate-credentials": () => ({
        valid: true,
        account: {
          principal: "sa@key-project.iam.gserviceaccount.com",
          accountType: "service_account",
        },
        projectId: "proj-x",
        credentialType: "service_account",
        credentialsPath: "/tmp/runbooks-gcp-A7oaHl/adc.json",
      }),
    })

    const { result } = renderGoogleAuth({ id: "gcp", project: "proj-x", detectCredentials: false })

    act(() => result.current.setServiceAccountKey(SA_KEY))
    await act(async () => {
      result.current.handleServiceAccountSubmit()
    })
    await waitFor(() => expect(result.current.authStatus).toBe("authenticated"))
    expect(registerOutputs).toHaveBeenLastCalledWith(
      "gcp",
      expect.objectContaining({
        GOOGLE_APPLICATION_CREDENTIALS: "/tmp/runbooks-gcp-A7oaHl/adc.json",
        __AUTHENTICATED: "true",
      }),
    )

    act(() => result.current.handleManualAuth())

    // The path is gone from the outputs, and the marker that gates the Run
    // button went with it.
    expect(registerOutputs).toHaveBeenLastCalledWith("gcp", { __AUTHENTICATED: "false" })
  })

  it("tells MAIN which credential it committed, so the superseded file can be zeroed", async () => {
    installApi({
      "google:validate-credentials": () => ({
        valid: true,
        account: {
          principal: "sa@key-project.iam.gserviceaccount.com",
          accountType: "service_account",
        },
        projectId: "proj-x",
        credentialType: "service_account",
        credentialsPath: "/tmp/runbooks-gcp-4gUk0g/adc.json",
      }),
    })

    const { result } = renderGoogleAuth({ id: "gcp", project: "proj-x", detectCredentials: false })

    act(() => result.current.setServiceAccountKey(SA_KEY))
    await act(async () => {
      result.current.handleServiceAccountSubmit()
    })
    await waitFor(() => expect(result.current.authStatus).toBe("authenticated"))

    expect(callsTo("google:credential-committed")).toEqual([
      { blockId: "gcp", credentialsPath: "/tmp/runbooks-gcp-4gUk0g/adc.json" },
    ])
  })
})

// Which tab the block opens on. Decided once, at mount, from the author's
// `defaultTab`; the user's tab clicks own it from then on.
describe("useGoogleAuth — defaultTab", () => {
  const renderWithTab = (defaultTab?: string) => {
    installApi()
    return renderGoogleAuth({ id: "gcp", detectCredentials: false, defaultTab })
  }

  it("opens on the Service Account Key tab when no defaultTab is set", () => {
    expect(renderWithTab().result.current.authMethod).toBe("service_account")
  })

  it("opens on the tab the author asked for", () => {
    expect(renderWithTab("oauth").result.current.authMethod).toBe("oauth")
    expect(renderWithTab("gcloud").result.current.authMethod).toBe("gcloud")
  })

  it("falls back to the Service Account Key tab for an unrecognized tab name", () => {
    // MDX props are untyped, so a typo must not leave the block formless.
    expect(renderWithTab("sign-in").result.current.authMethod).toBe("service_account")
  })
})
