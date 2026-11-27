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

  const SIGNED_IN: Handlers = {
    "google:env-credentials": () => ({
      found: true,
      valid: true,
      source: "adc",
      credentialType: "authorized_user",
      account: { principal: "dev@example.com", accountType: "user" },
    }),
  }

  const openGcloudTab = async () => {
    fireEvent.click(await screen.findByRole("button", { name: "gcloud Config" }))
    await screen.findAllByRole("button", { name: "Reload" })
  }

  it("names the account before the click, and continues with the configuration's settings", async () => {
    installApi({
      ...SIGNED_IN,
      "google:gcloud-configurations": () => listing,
      "google:gcloud-auth": () => ({
        valid: true,
        account: { principal: "dev@example.com", accountType: "user" },
        projectId: "proj-a",
        credentialsPath: "/home/u/.config/gcloud/application_default_credentials.json",
      }),
      "google:check-project": () => ({ enabled: true }),
    })

    renderBlock(<GoogleAuth id="gcp" detectCredentials={false} />)
    await openGcloudTab()

    expect(screen.getAllByText("You will sign in as")).toHaveLength(1)
    expect(screen.getAllByText("dev@example.com")).toHaveLength(1)
    expect(callsTo("google:env-credentials")).toEqual([{ source: "adc" }])
    expect(screen.getAllByText("proj-a")).toHaveLength(1)
    expect(screen.getAllByText("from your gcloud configuration default")).toHaveLength(1)
    expect(screen.queryAllByText("Signed in as")).toHaveLength(0)

    fireEvent.click(screen.getByRole("button", { name: "Continue as dev@example.com" }))

    expect(await screen.findByText("✓ Authenticated to Google Cloud")).toBeInTheDocument()
    expect(callsTo("google:gcloud-auth")).toEqual([
      {
        blockId: "gcp",
        configuration: "default",
        confirmedPrincipal: "dev@example.com",
        projectId: "proj-a",
      },
    ])
  })

  it("does not use a configuration set up for another account, and says so", async () => {
    installApi({
      ...SIGNED_IN,
      "google:gcloud-configurations": () => ({
        ...listing,
        configurations: [
          {
            name: "default",
            isActive: true,
            account: "someone-else@example.org",
            project: "other-org-proj",
            authType: "adc-user",
          },
        ],
      }),
      "google:gcloud-auth": () => ({
        valid: true,
        account: { principal: "dev@example.com", accountType: "user" },
        projects: [
          { projectId: "proj-a", displayName: "A" },
          { projectId: "proj-b", displayName: "B" },
        ],
      }),
    })

    renderBlock(<GoogleAuth id="gcp" detectCredentials={false} />)
    await openGcloudTab()

    expect(screen.getAllByText("Chosen after sign-in")).toHaveLength(1)
    expect(screen.queryAllByText("other-org-proj")).toHaveLength(0)
    expect(screen.getAllByText(/is set up for someone-else@example\.org/)).toHaveLength(1)

    fireEvent.click(screen.getByRole("button", { name: "Change" }))
    expect(screen.getByText("default").closest("button")!).toBeDisabled()
    expect(screen.getByRole("button", { pressed: true })).toHaveTextContent("No configuration")

    fireEvent.click(screen.getByRole("button", { name: "Continue as dev@example.com" }))

    await waitFor(() =>
      expect(callsTo("google:gcloud-auth")).toEqual([
        { blockId: "gcp", confirmedPrincipal: "dev@example.com" },
      ]),
    )
  })

  it("keeps the search box while a search is typed, after a reload shortens the list", async () => {
    const named = (name: string) => ({ name, isActive: false, authType: "config-only" as const })
    const sevenMore = ["one", "two", "three", "four", "five", "six", "seven"].map(named)
    let configurations = [...listing.configurations, ...sevenMore]
    installApi({
      ...SIGNED_IN,
      "google:gcloud-configurations": () => ({ ...listing, configurations }),
    })

    renderBlock(<GoogleAuth id="gcp" detectCredentials={false} />)
    await openGcloudTab()
    fireEvent.click(screen.getByRole("button", { name: "Change" }))
    fireEvent.change(screen.getByPlaceholderText("Search configurations..."), {
      target: { value: "stag" },
    })

    configurations = listing.configurations
    fireEvent.click(screen.getAllByRole("button", { name: "Reload" })[0]!)
    await waitFor(() => expect(callsTo("google:gcloud-configurations")).toHaveLength(2))
    fireEvent.click(await screen.findByRole("button", { name: "Change" }))

    expect(screen.getAllByPlaceholderText("Search configurations...")).toHaveLength(1)
    expect(screen.getByPlaceholderText("Search configurations...")).toHaveValue("stag")
  })

  it("lets the reader choose no configuration under Change", async () => {
    installApi({
      ...SIGNED_IN,
      "google:gcloud-configurations": () => listing,
      "google:gcloud-auth": () => ({
        valid: true,
        account: { principal: "dev@example.com", accountType: "user" },
        projectId: "proj-z",
      }),
    })

    renderBlock(<GoogleAuth id="gcp" detectCredentials={false} />)
    await openGcloudTab()
    fireEvent.click(screen.getByRole("button", { name: "Change" }))
    fireEvent.click(screen.getByText("No configuration"))
    fireEvent.click(screen.getByRole("button", { name: "Done" }))

    expect(screen.getAllByText("Chosen after sign-in")).toHaveLength(1)

    fireEvent.click(screen.getByRole("button", { name: "Continue as dev@example.com" }))

    await waitFor(() =>
      expect(callsTo("google:gcloud-auth")).toEqual([
        { blockId: "gcp", confirmedPrincipal: "dev@example.com" },
      ]),
    )
  })

  it("shows the project the runbook pins, over the configuration's", async () => {
    installApi({ ...SIGNED_IN, "google:gcloud-configurations": () => listing })

    renderBlock(<GoogleAuth id="gcp" detectCredentials={false} project="pinned-proj" />)
    await openGcloudTab()

    expect(screen.getAllByText("pinned-proj")).toHaveLength(1)
    expect(screen.getAllByText("set by this runbook")).toHaveLength(1)
    expect(screen.queryAllByText("proj-a")).toHaveLength(0)
  })

  it("says before the click when the login lacks a scope the runbook needs", async () => {
    const directory = "https://www.googleapis.com/auth/admin.directory.rolemanagement"
    const cloudPlatform = "https://www.googleapis.com/auth/cloud-platform"
    installApi({
      "google:env-credentials": () => ({
        found: true,
        valid: false,
        source: "adc",
        account: { principal: "dev@example.com", accountType: "user" },
        insufficientScopes: true,
        missingScopes: [directory],
      }),
      "google:gcloud-configurations": () => listing,
    })

    renderBlock(
      <GoogleAuth id="gcp" detectCredentials={false} scopes={[cloudPlatform, directory]} />,
    )
    await openGcloudTab()

    expect(
      screen.getAllByText("Your gcloud login is missing scopes this runbook needs"),
    ).toHaveLength(1)
    expect(screen.getAllByText(directory)).toHaveLength(1)
    expect(
      screen.getAllByText(
        `gcloud auth application-default login --scopes=${cloudPlatform},${directory}`,
      ),
    ).toHaveLength(1)
    expect(callsTo("google:env-credentials")).toEqual([
      { source: "adc", scopes: [cloudPlatform, directory] },
    ])
    expect(screen.queryAllByRole("button", { name: /^Continue/ })).toHaveLength(0)
  })

  it("says Google did not confirm the login, and gives the reason", async () => {
    installApi({
      "google:env-credentials": () => ({
        found: true,
        valid: false,
        source: "adc",
        warning: "getaddrinfo ENOTFOUND oauth2.googleapis.com",
      }),
      "google:gcloud-configurations": () => listing,
    })

    renderBlock(<GoogleAuth id="gcp" detectCredentials={false} />)
    await openGcloudTab()

    expect(screen.getAllByText("Google did not confirm your gcloud login")).toHaveLength(1)
    expect(screen.getAllByText("getaddrinfo ENOTFOUND oauth2.googleapis.com")).toHaveLength(1)
    expect(screen.queryAllByRole("button", { name: /^Continue/ })).toHaveLength(0)
    expect(screen.queryAllByRole("button", { name: "Change" })).toHaveLength(0)
  })

  it("says how to create the login when there is none", async () => {
    const { adc: _adc, ...listingWithoutAdc } = listing
    installApi({ ...NO_CREDENTIALS, "google:gcloud-configurations": () => listingWithoutAdc })

    renderBlock(<GoogleAuth id="gcp" detectCredentials={false} />)
    await openGcloudTab()

    expect(screen.getAllByText("No gcloud login found")).toHaveLength(1)
    expect(screen.getAllByText("gcloud auth application-default login")).toHaveLength(1)
    expect(screen.queryAllByRole("button", { name: /^Continue/ })).toHaveLength(0)
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
      confirmedPrincipal: "dev@example.com",
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

  it("sends the reader to another sign-in method, with a command that runs as copied, when Sign-In has no client", async () => {
    installApi({
      "google:oauth-available": () => ({ available: false }),
      "google:env-credentials": () => insufficient,
    })

    renderBlock(<GoogleAuth id="gcp" detectCredentials={["env"]} scopes={requiredScopes} />)

    expect(await screen.findByText("Credentials missing required scopes")).toBeInTheDocument()
    expect(
      screen.getAllByText(
        `gcloud auth application-default login --scopes=${CLOUD_PLATFORM},${DIRECTORY}`,
      ),
    ).toHaveLength(1)
    expect(screen.queryAllByText(/GOOGLE_OAUTH_CLIENT_CREDENTIALS/)).toHaveLength(0)
    expect(screen.queryAllByText(/unavailable in this build/)).toHaveLength(0)
    expect(screen.queryAllByText(/OAuth client/)).toHaveLength(0)
    expect(screen.queryAllByRole("button", { name: "Sign in with required scopes" })).toHaveLength(
      0,
    )
    expect(screen.getAllByRole("button", { name: "Check again" })).toHaveLength(1)

    fireEvent.click(screen.getByRole("button", { name: "Use Different Credentials" }))

    expect(await screen.findAllByRole("button", { name: "gcloud Config" })).toHaveLength(1)
    expect(screen.queryAllByText("Credentials missing required scopes")).toHaveLength(0)
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

describe("GoogleAuth setup guidance", () => {
  const consoleLinks = (guide: HTMLElement) =>
    [...guide.querySelectorAll("a")].map((link) => link.getAttribute("href"))

  const guideFor = (question: string) => screen.getByText(question).closest("details")!

  it("explains the OAuth client to the reader, with the steps closed until asked for", async () => {
    installApi({ ...NO_CREDENTIALS, "google:oauth-available": () => ({ available: false }) })

    renderBlock(<GoogleAuth id="gcp" detectCredentials={false} defaultTab="oauth" />)

    expect(await screen.findAllByText("Sign in as yourself in your browser.")).toHaveLength(1)
    expect(screen.queryAllByText(/oauthClientFile|GOOGLE_OAUTH_CLIENT_CREDENTIALS/)).toHaveLength(0)
    const guide = guideFor("How do I create an OAuth client?")
    expect(guide.open).toBe(false)
    expect(consoleLinks(guide)).toEqual([
      "https://console.cloud.google.com/",
      "https://console.developers.google.com/apis/api/cloudresourcemanager.googleapis.com/overview",
      "https://console.developers.google.com/auth/branding",
      "https://console.developers.google.com/auth/clients",
      "https://console.developers.google.com/auth/audience",
      "https://console.developers.google.com/auth/scopes",
    ])
  })

  it("lists the runbook's own scopes in the OAuth client steps", async () => {
    installApi({ ...NO_CREDENTIALS, "google:oauth-available": () => ({ available: false }) })
    const drive = "https://www.googleapis.com/auth/drive"

    renderBlock(
      <GoogleAuth id="gcp" detectCredentials={false} defaultTab="oauth" scopes={[drive]} />,
    )

    await screen.findAllByText("Sign in as yourself in your browser.")
    const scopes = [...guideFor("How do I create an OAuth client?").querySelectorAll("ul li")]
    expect(scopes.map((scope) => scope.textContent)).toEqual([drive])
  })

  it("says how to get a service account key", async () => {
    renderBlock(<GoogleAuth id="gcp" detectCredentials={false} />)

    expect(
      await screen.findAllByText("Sign in as a service account, using its key file."),
    ).toHaveLength(1)
    const guide = guideFor("How do I get a key?")
    expect(guide.open).toBe(false)
    expect(consoleLinks(guide)).toEqual([
      "https://console.cloud.google.com/iam-admin/serviceaccounts",
    ])
    expect(guide.querySelectorAll("ol > li")).toHaveLength(5)
  })

  it("gives the same gcloud login steps when there is no login and when the account is wrong", async () => {
    installApi({
      "google:env-credentials": () => ({
        found: true,
        valid: true,
        source: "adc",
        account: { principal: "dev@example.com", accountType: "user" },
      }),
      "google:gcloud-configurations": () => ({
        configurations: [],
        adc: { path: "/home/u/.config/gcloud/adc.json", type: "authorized_user" },
      }),
    })

    renderBlock(<GoogleAuth id="gcp" detectCredentials={false} defaultTab="gcloud" />)

    await screen.findAllByText("You will sign in as")
    const guide = guideFor("Not the right account?")
    expect(guide.querySelectorAll("ol > li")).toHaveLength(4)
    expect(consoleLinks(guide)).toEqual(["https://docs.cloud.google.com/sdk/docs/install"])
    expect(screen.getAllByText("Use your existing gcloud login on this machine.")).toHaveLength(1)
  })
})

describe("GoogleAuth methods prop", () => {
  const TAB_NAMES = ["Service Account Key", "Google Sign-In", "gcloud Config"]
  const tabNames = () =>
    screen
      .queryAllByRole("button")
      .map((button) => button.textContent ?? "")
      .filter((name) => TAB_NAMES.includes(name))
  const detectionSources = () => callsTo("google:env-credentials").map((call) => call.source)
  const OTHER_METHOD_HINT = /use another sign-in method/

  it("shows one listed method without a tab bar", async () => {
    renderBlock(<GoogleAuth id="gcp" methods={["oauth"]} />)

    expect(await screen.findAllByText("Sign in as yourself in your browser.")).toHaveLength(1)
    expect(tabNames()).toEqual([])
    expect(screen.queryAllByLabelText("Service account key JSON")).toHaveLength(0)
  })

  it("shows the listed methods as tabs in the author's order, opening on the first", async () => {
    renderBlock(<GoogleAuth id="gcp" methods={["oauth", "service_account"]} />)

    expect(await screen.findAllByText("Sign in as yourself in your browser.")).toHaveLength(1)
    expect(tabNames()).toEqual(["Google Sign-In", "Service Account Key"])
  })

  it("does not check the gcloud login on load when gcloud is not listed", async () => {
    renderBlock(<GoogleAuth id="gcp" methods={["oauth", "service_account"]} />)

    await screen.findAllByText("Sign in as yourself in your browser.")
    expect(detectionSources()).toEqual(["env"])
  })

  it("still checks the gcloud login on load when gcloud is listed", async () => {
    renderBlock(<GoogleAuth id="gcp" methods={["service_account", "gcloud"]} />)

    await screen.findAllByLabelText("Service account key JSON")
    expect(detectionSources()).toEqual(["env", "adc"])
  })

  it("shows a configuration error, and no sign-in form, when defaultTab is not listed", async () => {
    renderBlock(<GoogleAuth id="gcp" methods={["oauth"]} defaultTab="gcloud" />)

    expect(await screen.findAllByText("Invalid Configuration:")).toHaveLength(1)
    expect(
      screen.getAllByText(
        'The chosen GoogleAuth defaultTab must appear in the list of methods. The defaultTab is "gcloud" and methods lists: oauth.',
      ),
    ).toHaveLength(1)
    expect(screen.queryAllByText("Sign in as yourself in your browser.")).toHaveLength(0)
    expect(detectionSources()).toEqual([])
  })

  it("points to another sign-in method only when there is one", async () => {
    const { unmount } = renderBlock(
      <GoogleAuth id="gcp" detectCredentials={false} methods={["service_account"]} />,
    )
    await screen.findAllByText("How do I get a key?")
    expect(screen.queryAllByText(OTHER_METHOD_HINT)).toHaveLength(0)
    unmount()

    renderBlock(
      <GoogleAuth id="gcp" detectCredentials={false} methods={["service_account", "oauth"]} />,
    )
    await screen.findAllByText("How do I get a key?")
    expect(screen.queryAllByText(OTHER_METHOD_HINT)).toHaveLength(1)
  })

  it("does not point away from a gcloud login that lacks scopes when gcloud is the only method", async () => {
    const directory = "https://www.googleapis.com/auth/admin.directory.rolemanagement"
    const missingScopes: Handlers = {
      "google:env-credentials": () => ({
        found: true,
        valid: false,
        source: "adc",
        account: { principal: "dev@example.com", accountType: "user" },
        insufficientScopes: true,
        missingScopes: [directory],
      }),
      "google:gcloud-configurations": () => ({
        configurations: [],
        configRoot: "/home/u/.config/gcloud",
        adc: { path: "/home/u/.config/gcloud/adc.json", type: "authorized_user" },
      }),
    }
    const blockWith = (methods: ("gcloud" | "oauth")[]) => (
      <GoogleAuth id="gcp" detectCredentials={false} scopes={[directory]} methods={methods} />
    )
    const ANOTHER_METHOD = /sign in with another method/
    const MISSING = "Your gcloud login is missing scopes this runbook needs"

    installApi(missingScopes)
    const { unmount } = renderBlock(blockWith(["gcloud"]))
    expect(await screen.findAllByText(MISSING)).toHaveLength(1)
    expect(screen.queryAllByText(ANOTHER_METHOD)).toHaveLength(0)
    unmount()

    renderBlock(blockWith(["gcloud", "oauth"]))
    expect(await screen.findAllByText(MISSING)).toHaveLength(1)
    expect(screen.queryAllByText(ANOTHER_METHOD)).toHaveLength(1)
  })
})
