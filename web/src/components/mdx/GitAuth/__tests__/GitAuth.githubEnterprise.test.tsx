import { describe, it, expect, vi, afterEach } from "vitest"
import type { ReactNode } from "react"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { TestWrapper } from "@/test/test-utils"
import { ApiProvider } from "@/contexts/ApiContext"
import { makeTestApi, type Handlers, type Result, type TestApi } from "@/test/test-api"

// Exercises the REAL useGitAuth hook for GitHub Enterprise host handling.
vi.mock("@/contexts/useSession", () => ({
  useSession: () => ({ isReady: true }),
}))

import { GitAuth } from "../GitAuth"
import { GitHubAuth } from "../../GitHubAuth"

// Both CLIs installed, for the manual UI's hint.
const CLI_STATUS = {
  gh: { installed: true, version: "2.60.0", meetsFloor: true },
  glab: { installed: true, version: "1.80.0", meetsFloor: true },
}

let currentApi: TestApi

/** A machine with no GitHub credential to detect and only github.com known, plus `handlers`. */
function installApi(handlers: Handlers = {}) {
  currentApi = makeTestApi({
    "github:env-credentials": () => ({ found: false }),
    "github:cli-credentials": () => ({ found: false }),
    "github:enumerate-hosts": () => ONLY_GITHUB_COM,
    "github:host-picked": () => ({ ok: true }),
    "vcs:invalidate-cache": () => ({ ok: true }),
    "vcs:cli-status": () => CLI_STATUS,
    ...handlers,
  })
  return currentApi
}

afterEach(() => {
  vi.clearAllMocks()
})

// GitAuth reaches IPC through useApi(); hand it the installed fake.
function renderWithApi(ui: ReactNode) {
  return render(
    <TestWrapper>
      <ApiProvider api={currentApi.api}>{ui}</ApiProvider>
    </TestWrapper>,
  )
}

const ONLY_GITHUB_COM: Result<"github:enumerate-hosts"> = {
  hosts: [{ host: "github.com", sources: [], hasCredential: false }],
  defaultHost: "github.com",
}

const TWO_HOSTS: Result<"github:enumerate-hosts"> = {
  hosts: [
    { host: "github.com", sources: [], hasCredential: false },
    { host: "ghes.corp", sources: ["gh"], hasCredential: true },
  ],
  defaultHost: "github.com",
}

describe("GitAuth (GitHub) — host picker", () => {
  it("shows no picker when only github.com is available (unchanged UI)", async () => {
    const { invoke } = installApi({ "github:enumerate-hosts": () => ONLY_GITHUB_COM })

    renderWithApi(<GitAuth id="git" />)

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("github:cli-credentials", {
        componentId: "git",
        host: "github.com",
      })
    })
    await screen.findByText(/redirected to authorize/i)
    expect(screen.queryByText(/GitHub host:/)).toBeNull()
    expect(screen.queryByRole("combobox")).toBeNull()
  })

  it('shows a GitHub host picker (without "Other instance…") when gh knows several hosts', async () => {
    const { invoke } = installApi({ "github:enumerate-hosts": () => TWO_HOSTS })

    renderWithApi(<GitAuth id="git" />)

    const select = await screen.findByLabelText("GitHub host:")
    expect(screen.getByRole("option", { name: "ghes.corp" })).toBeInTheDocument()
    expect(screen.queryByRole("option", { name: /Other instance/ })).toBeNull()

    await waitFor(() => expect(select).not.toBeDisabled())
    fireEvent.change(select, { target: { value: "ghes.corp" } })

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("github:host-picked", { host: "ghes.corp" })
      expect(invoke).toHaveBeenCalledWith("github:cli-credentials", {
        componentId: "git",
        host: "ghes.corp",
      })
    })
    // OAuth isn't set up for ghes.corp (no client ID): the tab is disabled
    // with the reason, and the PAT form takes over.
    await screen.findByText(/isn't set up for ghes\.corp/)
    expect(screen.getByRole("button", { name: /Sign in with GitHub/ })).toBeDisabled()
    expect(screen.getByPlaceholderText(/github_pat_/)).toBeInTheDocument()
  })

  it("names the enterprise host on the success card", async () => {
    installApi({
      "github:cli-credentials": () => ({
        found: true,
        valid: true,
        user: { login: "mona" },
        host: "ghes.corp",
      }),
    })

    renderWithApi(<GitHubAuth id="gh" host="ghes.corp" />)

    await screen.findByText(/Authenticated to GitHub \(ghes\.corp\)/)
  })
})

describe("GitAuth (GitHub) — authored host", () => {
  it("pins the host: no picker, PAT link follows the GHES host", async () => {
    const { invoke } = installApi()

    renderWithApi(
      <GitHubAuth id="gh" host="https://ghes.corp/" defaultTab="pat" detectCredentials={false} />,
    )

    expect(screen.queryByRole("combobox")).toBeNull()
    fireEvent.click(screen.getByText("How do I create a token?"))
    expect(screen.getByRole("link", { name: /ghes\.corp\/settings\/tokens\/new/ })).toHaveAttribute(
      "href",
      "https://ghes.corp/settings/tokens/new",
    )
    expect(invoke).not.toHaveBeenCalledWith("github:enumerate-hosts", expect.anything())
  })

  it("keeps the OAuth tab for an enterprise host with a client ID from the map", async () => {
    installApi()

    renderWithApi(
      <GitHubAuth
        id="gh"
        host="acme.ghe.com"
        oauthClientId={{ "acme.ghe.com": "Iv1.acme" }}
        detectCredentials={false}
      />,
    )

    for (const button of screen.getAllByRole("button", { name: /Sign in with GitHub/ })) {
      expect(button).not.toBeDisabled()
    }
    expect(screen.getByText(/redirected to authorize/i)).toBeInTheDocument()
    // No "custom OAuth app — use the default instead?" prompt on an enterprise host.
    expect(screen.queryByText("Custom OAuth App")).toBeNull()
  })

  it("reports an unparseable host as a configuration error and sends nothing", async () => {
    installApi()

    renderWithApi(<GitHubAuth id="gh" host="ftp://ghes.corp" />)

    expect(screen.getByText(/invalid 'host' prop/)).toBeInTheDocument()
    expect(currentApi.calls.some(({ channel }) => channel.startsWith("github:"))).toBe(false)
  })
})
