import { describe, it, expect, vi, beforeEach } from "vitest"
import type { ReactNode } from "react"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { RunbookProgressProbe, TestWrapper } from "@/test/test-utils"
import { ApiProvider } from "@/contexts/ApiContext"
import { makeTestApi, type Handlers, type Result, type TestApi } from "@/test/test-api"

/**
 * Integration coverage for the whole `<GoogleAuth>` block: the real component,
 * the real `useGoogleAuth` state machine, and the real sub-components. The only
 * thing faked is the IPC surface behind `useApi()` — the true boundary — plus
 * session readiness, which is ambient state rather than behaviour under test.
 *
 * Each of the three tabs gets a happy path, detection gets its confirm gate, a
 * rejected credential proves runtime errors render INLINE (never via
 * `reportError`), and the configuration errors (missing/duplicate id, two block
 * sources) prove the opposite.
 */

vi.mock("@/contexts/useSession", () => ({
  useSession: () => ({ isReady: true }),
}))

import GoogleAuth from "../GoogleAuth"

let testApi: TestApi
let invoke: TestApi["invoke"]

/**
 * Install the typed IPC fake, answering each channel with its handler in
 * `handlers`.
 *
 * A few calls are answered unless a test says otherwise:
 * - The block probes `google:oauth-available` on mount so the Google Sign-In
 *   tab can render disabled on first paint: "configured", so only the tests
 *   that care about an unconfigured build have to say so.
 * - The fire-and-forget calls (committing a credential, opening the browser):
 *   done.
 */
function installApi(handlers: Handlers) {
  testApi = makeTestApi({
    "google:oauth-available": () => ({ available: true }),
    "google:credential-committed": () => ({ ok: true }),
    "native:open-external": () => ({ ok: true }),
    ...handlers,
  })
  invoke = testApi.invoke
}

/** The params of each call to one channel, ignoring the mount-time capability probe. */
const callsTo = <C extends Parameters<TestApi["callsTo"]>[0]>(channel: C) =>
  testApi.callsTo(channel)

function renderBlock(children: ReactNode) {
  return render(
    <TestWrapper>
      <ApiProvider api={testApi.api}>{children}</ApiProvider>
      <RunbookProgressProbe />
    </TestWrapper>,
  )
}

const SA_KEY = JSON.stringify({
  type: "service_account",
  project_id: "key-project",
  client_email: "sa@key-project.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nzzz\n-----END PRIVATE KEY-----\n",
})

/** Nothing ambient to find — the block falls through to the manual tabs. */
const NO_CREDENTIALS: Handlers = { "google:env-credentials": () => ({ found: false }) }

beforeEach(() => {
  installApi(NO_CREDENTIALS)
})

// ---------------------------------------------------------------------------
// Rendering + configuration errors
// ---------------------------------------------------------------------------

describe("GoogleAuth — rendering", () => {
  it("renders the default title and all three auth tabs once detection settles", async () => {
    renderBlock(<GoogleAuth id="gcp" />)

    expect(screen.getByTestId("gcp")).toBeInTheDocument()
    expect(screen.getByText("Google Cloud Authentication")).toBeInTheDocument()
    // Detection runs first and is announced while it is in flight.
    expect(screen.getByText("Checking for existing credentials...")).toBeInTheDocument()

    expect(await screen.findByRole("button", { name: "Service Account Key" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Google Sign-In" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "gcloud Config" })).toBeInTheDocument()
    // Service-account key is the default tab.
    expect(screen.getByLabelText("Service account key JSON")).toBeInTheDocument()
    expect(screen.getByTestId("gcp").querySelector('[data-testid^="error-"]')).toBeNull()
  })

  it("renders a custom title and description", async () => {
    renderBlock(<GoogleAuth id="gcp" title="Connect to GCP" description="Authenticate first." />)

    expect(screen.getByText("Connect to GCP")).toBeInTheDocument()
    expect(screen.getByText("Authenticate first.")).toBeInTheDocument()
    await screen.findByRole("button", { name: "Service Account Key" })
  })

  it("shows a configuration error for a missing id", () => {
    renderBlock(<GoogleAuth id="" />)
    expect(screen.getByText(/requires a non-empty 'id' prop/)).toBeInTheDocument()
  })

  it("shows a configuration error for a duplicate id", async () => {
    renderBlock(
      <>
        <GoogleAuth id="dup" />
        <GoogleAuth id="dup" />
      </>,
    )

    // Both instances flag the collision — neither can claim the id.
    expect(await screen.findAllByText("Duplicate Component ID:")).not.toHaveLength(0)
    expect(screen.getAllByText("<GoogleAuth>")).not.toHaveLength(0)
    expect(screen.queryByLabelText("Service account key JSON")).toBeNull()
  })

  it("shows a configuration error for more than one { block } detection source", async () => {
    renderBlock(<GoogleAuth id="gcp" detectCredentials={[{ block: "one" }, { block: "two" }]} />)

    expect(await screen.findByText("Invalid Configuration:")).toBeInTheDocument()
    // The card early-returns: no auth UI at all.
    expect(screen.queryByRole("button", { name: "Service Account Key" })).toBeNull()
  })

  it("shows a configuration error when oauthClientFile is mixed with id/secret", async () => {
    renderBlock(
      <GoogleAuth
        id="gcp"
        detectCredentials={false}
        oauthClientFile="~/.config/gcloud/client_secret.json"
        oauthClientId="custom.apps.googleusercontent.com"
        oauthClientSecret="not-confidential"
      />,
    )

    expect(await screen.findByText("Invalid Configuration:")).toBeInTheDocument()
    expect(screen.getByText(/oauthClientFile/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Service Account Key" })).toBeNull()
  })

  it("detectCredentials={false} skips detection entirely and shows the tabs immediately", () => {
    installApi(NO_CREDENTIALS)
    renderBlock(<GoogleAuth id="gcp" detectCredentials={false} />)

    expect(screen.getByRole("button", { name: "Service Account Key" })).toBeInTheDocument()
    expect(screen.queryByText("Checking for existing credentials...")).toBeNull()
    // Nothing is probed for credentials. (The OAuth capability probe is not a
    // credential read — it only asks whether a Desktop OAuth client resolves.)
    expect(callsTo("google:env-credentials")).toHaveLength(0)
    expect(callsTo("google:validate-credentials")).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Tab 1 — service account key
// ---------------------------------------------------------------------------

describe("GoogleAuth — service account tab", () => {
  it("authenticates with a pasted key and shows the success card", async () => {
    installApi({
      ...NO_CREDENTIALS,
      "google:validate-credentials": () => ({
        valid: true,
        account: {
          principal: "sa@key-project.iam.gserviceaccount.com",
          accountType: "service_account",
        },
        projectId: "proj-x",
        projectName: "Project X",
        credentialType: "service_account",
        credentialsPath: "/tmp/runbooks-gcp-a/adc.json",
      }),
      "google:check-project": () => ({ enabled: true }),
    })

    renderBlock(<GoogleAuth id="gcp" project="proj-x" />)

    const keyField = await screen.findByLabelText("Service account key JSON")
    fireEvent.change(keyField, { target: { value: SA_KEY } })
    fireEvent.click(screen.getByRole("button", { name: "Authenticate" }))

    expect(await screen.findByText("✓ Authenticated to Google Cloud")).toBeInTheDocument()
    expect(screen.getByText("sa@key-project.iam.gserviceaccount.com")).toBeInTheDocument()
    expect(screen.getByText("Service account key")).toBeInTheDocument()
    // The credentials PATH is published (it is not a secret); the contents never are.
    expect(
      screen.getByText("GOOGLE_APPLICATION_CREDENTIALS=/tmp/runbooks-gcp-a/adc.json"),
    ).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith("google:validate-credentials", {
      blockId: "gcp",
      keyJson: SA_KEY,
      projectId: "proj-x",
      registerSession: true,
    })
  })

  it("counts as a step of the runbook, done once it shows it's signed in", async () => {
    installApi({
      ...NO_CREDENTIALS,
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
    renderBlock(<GoogleAuth id="gcp" project="proj-x" />)

    fireEvent.change(await screen.findByLabelText("Service account key JSON"), {
      target: { value: SA_KEY },
    })
    expect(screen.getByTestId("runbook-progress")).toHaveTextContent("0/1")
    fireEvent.click(screen.getByRole("button", { name: "Authenticate" }))

    expect(await screen.findByText("✓ Authenticated to Google Cloud")).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId("runbook-progress")).toHaveTextContent("1/1"))
  })

  it("turns red when the access token expires within minutes, and signs in again on request", async () => {
    installApi({
      ...NO_CREDENTIALS,
      "google:validate-credentials": () => ({
        valid: true,
        account: {
          principal: "dev@example.com",
          accountType: "user",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        projectId: "proj-x",
        credentialType: "access_token",
      }),
      "google:check-project": () => ({ enabled: true }),
    })
    renderBlock(<GoogleAuth id="gcp" project="proj-x" />)

    fireEvent.change(await screen.findByLabelText("Service account key JSON"), {
      target: { value: SA_KEY },
    })
    fireEvent.click(screen.getByRole("button", { name: "Authenticate" }))

    expect(
      await screen.findByText("These credentials expire in less than 5 minutes"),
    ).toBeInTheDocument()
    expect(screen.getByTestId("gcp")).toHaveClass("bg-destructive-muted")
    // Red, so not a step that's done
    expect(screen.getByTestId("runbook-progress")).toHaveTextContent("0/1")

    fireEvent.click(screen.getByRole("button", { name: "Sign in again" }))
    expect(screen.queryByText("✓ Authenticated to Google Cloud")).toBeNull()
    expect(screen.queryByText(/These credentials/)).toBeNull()
  })

  it("renders a rejected key inline as a runtime error, not a reported one", async () => {
    installApi({
      ...NO_CREDENTIALS,
      "google:validate-credentials": () => ({
        valid: false,
        error: "Not a service account key (expected type: service_account)",
      }),
    })

    renderBlock(<GoogleAuth id="gcp" />)

    const keyField = await screen.findByLabelText("Service account key JSON")
    fireEvent.change(keyField, { target: { value: '{"type":"authorized_user"}' } })
    fireEvent.click(screen.getByRole("button", { name: "Authenticate" }))

    expect(await screen.findByText("Authentication failed:")).toBeInTheDocument()
    expect(
      screen.getByText(/Not a service account key \(expected type: service_account\)/),
    ).toBeInTheDocument()
    // Runtime failures never escalate to the configuration-error channel, and
    // the form stays on screen so the user can correct the key.
    const block = screen.getByTestId("gcp")
    expect(block.querySelector('[data-testid^="error-"]')).toBeNull()
    expect(screen.getByLabelText("Service account key JSON")).toBeInTheDocument()
  })

  it("routes to the project picker when the key sees more than one project", async () => {
    installApi({
      ...NO_CREDENTIALS,
      "google:validate-credentials": () => ({
        valid: true,
        account: {
          principal: "sa@key-project.iam.gserviceaccount.com",
          accountType: "service_account",
        },
        credentialType: "service_account",
        credentialsPath: "/tmp/runbooks-gcp-b/adc.json",
        projects: [
          { projectId: "proj-one", displayName: "Project One" },
          { projectId: "proj-two", displayName: "Project Two" },
        ],
      }),
      "google:set-project": () => ({ ok: true, projectName: "Project Two" }),
      "google:check-project": () => ({ enabled: true }),
    })

    renderBlock(<GoogleAuth id="gcp" />)

    const keyField = await screen.findByLabelText("Service account key JSON")
    fireEvent.change(keyField, { target: { value: SA_KEY } })
    fireEvent.click(screen.getByRole("button", { name: "Authenticate" }))

    expect(
      await screen.findByText("Select a Google Cloud project to continue:"),
    ).toBeInTheDocument()
    // The tabs are hidden for the duration of the sub-selection.
    expect(screen.queryByRole("button", { name: "Service Account Key" })).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: /Project Two/ }))

    expect(await screen.findByText("✓ Authenticated to Google Cloud")).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith("google:set-project", {
      blockId: "gcp",
      projectId: "proj-two",
    })
  })
})

// ---------------------------------------------------------------------------
// Change project
// ---------------------------------------------------------------------------

describe("GoogleAuth — change project", () => {
  const LIST_ERROR = "Cloud Resource Manager API has not been used in project 123"

  it("shows a project-list failure in the picker, and Cancel keeps the authentication", async () => {
    installApi({
      ...NO_CREDENTIALS,
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
      "google:projects": () => ({ projects: [], error: LIST_ERROR }),
      "google:check-project": () => ({ enabled: true }),
    })

    renderBlock(<GoogleAuth id="gcp" project="proj-x" />)

    const keyField = await screen.findByLabelText("Service account key JSON")
    fireEvent.change(keyField, { target: { value: SA_KEY } })
    fireEvent.click(screen.getByRole("button", { name: "Authenticate" }))
    expect(await screen.findByText("✓ Authenticated to Google Cloud")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Change Project" }))

    // The listing failed; the picker must say so rather than claim the
    // credential can see no projects.
    expect(await screen.findByText("Could not list projects:")).toBeInTheDocument()
    expect(screen.getByText(LIST_ERROR)).toBeInTheDocument()
    expect(screen.queryByText("No projects are visible to these credentials.")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    // Backing out is not a re-authentication.
    expect(await screen.findByText("✓ Authenticated to Google Cloud")).toBeInTheDocument()
    expect(screen.getByText("sa@key-project.iam.gserviceaccount.com")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Service Account Key" })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Tab 2 — Google sign-in
// ---------------------------------------------------------------------------

describe("GoogleAuth — Google sign-in tab", () => {
  it("starts the loopback flow, shows the browser handoff, and completes", async () => {
    let pollCount = 0
    installApi({
      ...NO_CREDENTIALS,
      "google:oauth-start": () => ({
        flowId: "flow-1",
        authUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=abc",
        redirectUri: "http://127.0.0.1:53211/oauth2callback",
      }),
      "google:oauth-poll": () => {
        pollCount += 1
        return {
          status: "complete",
          account: { principal: "dev@example.com", accountType: "user" },
          credentialsPath: "/tmp/runbooks-gcp-c/adc.json",
          projects: [{ projectId: "proj-solo", displayName: "Solo Project" }],
        }
      },
      "google:set-project": () => ({ ok: true, projectName: "Solo Project" }),
      "google:check-project": () => ({ enabled: true }),
    })

    renderBlock(<GoogleAuth id="gcp" />)

    fireEvent.click(await screen.findByRole("button", { name: "Google Sign-In" }))
    expect(screen.getByRole("button", { name: /Sign in with Google/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: /Sign in with Google/ }))

    expect(await screen.findByText("✓ Authenticated to Google Cloud")).toBeInTheDocument()
    expect(screen.getByText("dev@example.com")).toBeInTheDocument()
    expect(screen.getByText("User credentials (ADC)")).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith("native:open-external", {
      url: "https://accounts.google.com/o/oauth2/v2/auth?state=abc",
    })
    expect(pollCount).toBeGreaterThan(0)
  })

  it("offers a Desktop OAuth client picker on FIRST PAINT when the build has no client", async () => {
    installApi({ ...NO_CREDENTIALS, "google:oauth-available": () => ({ available: false }) })

    renderBlock(<GoogleAuth id="gcp" />)

    // The mount-time capability probe labels the tab; the panel offers a file
    // picker so Sign-In works without author props or a Runbooks restart.
    const tab = await screen.findByRole("button", { name: /Google Sign-In/ })
    await waitFor(() => expect(screen.getByText("(needs OAuth client)")).toBeInTheDocument())
    expect(tab).not.toBeDisabled()

    fireEvent.click(tab)
    expect(
      await screen.findByRole("button", { name: /Choose Desktop OAuth client JSON/ }),
    ).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Sign in with Google/ })).toBeNull()
    expect(callsTo("google:oauth-start")).toHaveLength(0)
  })

  it("starts Sign-In with an operator-chosen Desktop OAuth client JSON", async () => {
    installApi({
      ...NO_CREDENTIALS,
      "google:oauth-available": () => ({ available: false }),
      "native:show-open-dialog": () => ({
        filePaths: ["/tmp/client_secret_example.apps.googleusercontent.com.json"],
      }),
      "google:oauth-start": () => ({
        flowId: "flow-1",
        authUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=x",
        redirectUri: "http://127.0.0.1:9/",
        expiresInSeconds: 600,
      }),
      "google:oauth-poll": () => ({ status: "pending" }),
    })

    renderBlock(<GoogleAuth id="gcp" />)

    fireEvent.click(await screen.findByRole("button", { name: /Google Sign-In/ }))
    fireEvent.click(await screen.findByRole("button", { name: /Choose Desktop OAuth client JSON/ }))

    expect(
      await screen.findByText("client_secret_example.apps.googleusercontent.com.json"),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /Sign in with Google/ }))

    await waitFor(() => expect(callsTo("google:oauth-start")).toHaveLength(1))
    expect(invoke).toHaveBeenCalledWith("google:oauth-start", {
      clientFile: "/tmp/client_secret_example.apps.googleusercontent.com.json",
    })
  })

  it("falls back to the client picker when oauth-start reports it is not configured", async () => {
    // The probe says the build is fine, but the flow is refused at start time.
    installApi({
      ...NO_CREDENTIALS,
      "google:oauth-start": () => ({ error: "OAuth login is not configured for this build" }),
    })

    renderBlock(<GoogleAuth id="gcp" />)

    fireEvent.click(await screen.findByRole("button", { name: "Google Sign-In" }))
    fireEvent.click(screen.getByRole("button", { name: /Sign in with Google/ }))

    expect(
      await screen.findByText(/OAuth login is not configured for this build/),
    ).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText("(needs OAuth client)")).toBeInTheDocument())
    expect(
      screen.getByRole("button", { name: /Choose Desktop OAuth client JSON/ }),
    ).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Sign in with Google/ })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Tab 3 — gcloud configuration
// ---------------------------------------------------------------------------

describe("GoogleAuth — gcloud tab", () => {
  const listing: Result<"google:gcloud-configurations"> = {
    configurations: [
      {
        name: "default",
        isActive: true,
        account: "dev@example.com",
        project: "proj-a",
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

  it("lists configurations on tab entry and authenticates with the selected one", async () => {
    installApi({
      ...NO_CREDENTIALS,
      "google:gcloud-configurations": () => listing,
      "google:gcloud-auth": () => ({
        valid: true,
        account: { principal: "dev@example.com", accountType: "user" },
        projectId: "proj-a",
        credentialsPath: "/home/u/.config/gcloud/application_default_credentials.json",
      }),
      "google:check-project": () => ({ enabled: true }),
    })

    renderBlock(<GoogleAuth id="gcp" />)

    fireEvent.click(await screen.findByRole("button", { name: "gcloud Config" }))

    // The listing is a pure disk read in MAIN; no gcloud binary is invoked.
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("google:gcloud-configurations", {}))
    expect(await screen.findByText("default")).toBeInTheDocument()
    // A configuration with no ADC is listed but not selectable.
    const staging = screen.getByText("staging").closest("button")!
    expect(staging).toBeDisabled()
    expect(screen.getByText("No ADC")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Use Selected Configuration" }))

    expect(await screen.findByText("✓ Authenticated to Google Cloud")).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith("google:gcloud-auth", {
      blockId: "gcp",
      configuration: "default",
      projectId: "proj-a",
    })
  })
})

// ---------------------------------------------------------------------------
// Detection + confirmation gate
// ---------------------------------------------------------------------------

describe("GoogleAuth — credential detection", () => {
  const detected: Result<"google:env-credentials"> = {
    found: true,
    valid: true,
    projectId: "proj-a",
    projectName: "Project A",
    account: { principal: "dev@example.com", accountType: "user" },
    credentialType: "authorized_user",
    envVar: "GOOGLE_APPLICATION_CREDENTIALS",
  }

  it("prompts for confirmation before using detected credentials", async () => {
    installApi({
      "google:env-credentials": () => detected,
      "google:env-credentials-confirm": () => ({
        valid: true,
        account: { principal: "dev@example.com", accountType: "user" },
        projectId: "proj-a",
        credentialsPath: "/tmp/runbooks-gcp-d/adc.json",
        credentialType: "authorized_user",
      }),
      "google:check-project": () => ({ enabled: true }),
    })

    renderBlock(<GoogleAuth id="gcp" detectCredentials={["env"]} />)

    expect(await screen.findByText("Google Cloud Credentials Detected")).toBeInTheDocument()
    expect(screen.getByText("Source: Environment Variables")).toBeInTheDocument()
    expect(screen.getByText("GOOGLE_APPLICATION_CREDENTIALS")).toBeInTheDocument()
    // Nothing has been used yet — the confirm gate is what makes it this block's.
    expect(screen.queryByText("✓ Authenticated to Google Cloud")).toBeNull()
    expect(invoke).not.toHaveBeenCalledWith("google:env-credentials-confirm", expect.anything())

    fireEvent.click(screen.getByRole("button", { name: "Use These Credentials" }))

    expect(await screen.findByText("✓ Authenticated to Google Cloud")).toBeInTheDocument()
    expect(screen.getByText("Environment Variables")).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith("google:env-credentials-confirm", {
      blockId: "gcp",
      source: "env",
      projectId: "proj-a",
    })
  })

  it('"Use Different Credentials" falls through to the manual tabs', async () => {
    installApi({ "google:env-credentials": () => detected })

    renderBlock(<GoogleAuth id="gcp" detectCredentials={["env"]} />)

    fireEvent.click(await screen.findByRole("button", { name: "Use Different Credentials" }))

    expect(await screen.findByRole("button", { name: "Service Account Key" })).toBeInTheDocument()
    expect(screen.queryByText("Google Cloud Credentials Detected")).toBeNull()
  })

  it("warns inline when the ambient credentials are found but invalid", async () => {
    installApi({ "google:env-credentials": () => ({ found: true, valid: false }) })

    renderBlock(<GoogleAuth id="gcp" detectCredentials={["env"]} />)

    expect(await screen.findByText("Invalid credentials detected:")).toBeInTheDocument()
    expect(
      screen.getByText(/Google Cloud credentials in the environment are invalid or expired/),
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Service Account Key" })).toBeInTheDocument()
  })

  it("adds MAIN's reason to the invalid-credentials warning", async () => {
    installApi({
      "google:env-credentials": ({ source }) => {
        if (source === "adc") {
          return {
            found: true,
            valid: false,
            source: "adc",
            path: "/home/u/.config/gcloud/application_default_credentials.json",
            warning: "ENOENT: no such file or directory",
          }
        }
        return { found: false }
      },
    })

    renderBlock(<GoogleAuth id="gcp" detectCredentials={["adc"]} />)

    expect(await screen.findByText("Invalid credentials detected:")).toBeInTheDocument()
    expect(
      screen.getByText(
        /Application Default Credentials are invalid or expired \(ENOENT: no such file or directory\)/,
      ),
    ).toBeInTheDocument()
  })

  it("names a prefixed env var once, exactly as MAIN read it", async () => {
    installApi({
      "google:env-credentials": () => ({
        ...detected,
        envVar: "PROD_GOOGLE_APPLICATION_CREDENTIALS",
      }),
    })

    renderBlock(<GoogleAuth id="gcp" detectCredentials={[{ env: { prefix: "PROD_" } }]} />)

    expect(await screen.findByText("Google Cloud Credentials Detected")).toBeInTheDocument()
    expect(screen.getByText("PROD_GOOGLE_APPLICATION_CREDENTIALS")).toBeInTheDocument()
    expect(screen.queryByText(/PROD_PROD_/)).toBeNull()
  })

  it("offers 'Check again' from the manual form", async () => {
    installApi(NO_CREDENTIALS)
    renderBlock(<GoogleAuth id="gcp" detectCredentials={["env"]} />)

    const checkAgain = await screen.findByRole("button", { name: "Check again" })
    expect(screen.getByTestId("detection-hint")).toHaveTextContent(
      "No existing credentials found. Sign in below.",
    )
    expect(callsTo("google:env-credentials")).toHaveLength(1)

    fireEvent.click(checkAgain)

    await waitFor(() => expect(callsTo("google:env-credentials")).toHaveLength(2))
    expect(await screen.findByTestId("detection-hint")).toHaveTextContent(
      "No existing credentials found. Sign in below.",
    )
  })
})

// ---------------------------------------------------------------------------
// Required scopes on detected ADC
// ---------------------------------------------------------------------------

describe("GoogleAuth — required scopes", () => {
  const DIRECTORY = "https://www.googleapis.com/auth/admin.directory.rolemanagement"
  const CLOUD_PLATFORM = "https://www.googleapis.com/auth/cloud-platform"
  const requiredScopes = [CLOUD_PLATFORM, DIRECTORY]

  const insufficient: Result<"google:env-credentials"> = {
    found: true,
    valid: false,
    insufficientScopes: true,
    missingScopes: [DIRECTORY],
    grantedScopes: [CLOUD_PLATFORM],
    projectId: "proj-a",
    projectName: "Project A",
    account: { principal: "admin@example.com", accountType: "user", scopes: [CLOUD_PLATFORM] },
    credentialType: "authorized_user",
    envVar: "GOOGLE_APPLICATION_CREDENTIALS",
  }

  it("shows the insufficient-scopes recovery card instead of Use These Credentials", async () => {
    installApi({
      "google:env-credentials": ({ scopes }) => {
        expect(scopes).toEqual(requiredScopes)
        return insufficient
      },
    })

    renderBlock(<GoogleAuth id="gcp" detectCredentials={["env"]} scopes={requiredScopes} />)

    expect(await screen.findByText("Credentials missing required scopes")).toBeInTheDocument()
    expect(screen.getByText(DIRECTORY)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Use These Credentials" })).toBeNull()
    expect(screen.getByRole("button", { name: "Sign in with required scopes" })).toBeInTheDocument()
  })

  it("starts Google Sign-In with the required scopes from the recovery card", async () => {
    installApi({
      "google:env-credentials": () => insufficient,
      "google:oauth-start": () => ({
        flowId: "flow-scopes",
        authUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=scopes",
      }),
      "google:oauth-poll": () => ({ status: "pending" }),
    })

    renderBlock(<GoogleAuth id="gcp" detectCredentials={["env"]} scopes={requiredScopes} />)

    fireEvent.click(await screen.findByRole("button", { name: "Sign in with required scopes" }))

    await waitFor(() => expect(callsTo("google:oauth-start")).toHaveLength(1))
    expect(invoke).toHaveBeenCalledWith("google:oauth-start", { scopes: requiredScopes })
    expect(await screen.findByText(/Waiting for browser sign-in/i)).toBeInTheDocument()
  })

  it("shows the gcloud --scopes command when Sign-In is unavailable", async () => {
    installApi({
      "google:oauth-available": () => ({ available: false }),
      "google:env-credentials": () => insufficient,
    })

    renderBlock(<GoogleAuth id="gcp" detectCredentials={["env"]} scopes={requiredScopes} />)

    expect(await screen.findByText("Credentials missing required scopes")).toBeInTheDocument()
    expect(
      screen.getByText(
        `gcloud auth application-default login --client-id-file="$GOOGLE_OAUTH_CLIENT_CREDENTIALS" --scopes=${CLOUD_PLATFORM},${DIRECTORY}`,
      ),
    ).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Sign in with required scopes" })).toBeNull()
    expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument()
  })

  it("does not enforce default scopes when the author omits the prop", async () => {
    installApi({
      "google:env-credentials": ({ scopes }) => {
        expect(scopes).toBeUndefined()
        return {
          found: true,
          valid: true,
          projectId: "proj-a",
          account: { principal: "dev@example.com", accountType: "user" },
          credentialType: "authorized_user",
        }
      },
    })

    renderBlock(<GoogleAuth id="gcp" detectCredentials={["env"]} />)

    expect(await screen.findByText("Google Cloud Credentials Detected")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Use These Credentials" })).toBeInTheDocument()
  })
})
