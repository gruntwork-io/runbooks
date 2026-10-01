import { describe, it, expect, vi, afterEach } from "vitest"
import type { ReactNode } from "react"
import { render, screen, waitFor, act } from "@testing-library/react"
import { TestWrapper } from "@/test/test-utils"
import { ApiProvider, type RunbooksAPI } from "@/contexts/ApiContext"

// detectCredentials={false} against the REAL useGitAuth hook: the block must
// not read as if it searched for credentials and failed. No login suggestion,
// no "Check again", no Reload, no auto-auth FAQ, no credential annotations on
// the host picker — even when gh/glab are installed and logged in.
vi.mock("@/contexts/useSession", () => ({
  useSession: () => ({ isReady: true }),
}))

import { GitAuth } from "../GitAuth"
import { GitHubAuth } from "../../GitHubAuth"
import { GitLabAuth } from "../../GitLabAuth"

const NEUTRAL_HINT = "This runbook doesn't use existing credentials — sign in below."

// Both CLIs installed, and each has a credential for its SaaS host — exactly
// the setup where the old copy told a logged-in user to log in again.
const CLI_STATUS = {
  gh: { installed: true, version: "2.40.1", meetsFloor: true },
  glab: { installed: true, version: "1.50.0", meetsFloor: true },
}
const GITLAB_HOSTS = {
  hosts: [
    { host: "gitlab.com", sources: ["glab"], hasCredential: true },
    { host: "git.corp.example", sources: ["recent"], hasCredential: false },
  ],
  defaultHost: "gitlab.com",
}
const GITHUB_COM_ONLY = {
  hosts: [{ host: "github.com", sources: ["gh"], hasCredential: true }],
  defaultHost: "github.com",
}
const GITHUB_WITH_GHES = {
  hosts: [
    { host: "github.com", sources: ["gh"], hasCredential: true },
    { host: "ghes.corp", sources: ["gh"], hasCredential: true },
  ],
  defaultHost: "github.com",
}

let currentApi: RunbooksAPI

function installApi(overrides: Record<string, unknown> = {}) {
  const invoke = vi.fn(async (channel: string) => {
    if (channel in overrides) return overrides[channel]
    if (channel === "vcs:cli-status") return CLI_STATUS
    return { found: false }
  })
  currentApi = { invoke, on: vi.fn(() => () => {}) } as unknown as RunbooksAPI
  return invoke
}

function renderWithApi(ui: ReactNode) {
  return render(
    <TestWrapper>
      <ApiProvider api={currentApi}>{ui}</ApiProvider>
    </TestWrapper>,
  )
}

/**
 * Wait for the vcs:cli-status probe to answer and its state update to land,
 * so a negative assertion can't pass just because the old CLI-driven hint
 * hadn't rendered yet.
 */
async function settleCliStatus(invoke: ReturnType<typeof installApi>) {
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("vcs:cli-status"))
  await act(async () => {})
}

const credentialCalls = (invoke: ReturnType<typeof installApi>) =>
  invoke.mock.calls.filter(([channel]) => channel.endsWith("-credentials"))

function expectNoDetectionAffordances(label: "GitHub" | "GitLab") {
  expect(screen.getByTestId("vcs-cli-hint")).toHaveTextContent(NEUTRAL_HINT)
  expect(document.body.textContent).not.toMatch(/auth login/)
  expect(document.body.textContent).not.toMatch(/No existing credentials/)
  expect(screen.queryByRole("button", { name: "Check again" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Reload" })).toBeNull()
  expect(screen.queryByText(`How can I authenticate to ${label} automatically?`)).toBeNull()
}

afterEach(() => {
  vi.clearAllMocks()
})

describe("GitAuth — detectCredentials={false} (real hook)", () => {
  it("GitLab: neutral hint, plain host picker, no Reload or auto-auth FAQ", async () => {
    const invoke = installApi({ "gitlab:enumerate-hosts": GITLAB_HOSTS })

    renderWithApi(<GitAuth id="git" provider="gitlab" detectCredentials={false} />)
    await screen.findByPlaceholderText(/GitLab access token/i)
    const select = await screen.findByRole("combobox")
    await waitFor(() => expect(select).toHaveValue("gitlab.com"))
    await settleCliStatus(invoke)

    expectNoDetectionAffordances("GitLab")
    // The host choice still matters, so the picker stays — as a plain list.
    expect(screen.getByRole("option", { name: "git.corp.example" })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "Other instance…" })).toBeInTheDocument()
    expect(screen.queryByTestId("host-sources-git")).toBeNull()
    expect(screen.queryByTestId("host-credential-git")).toBeNull()
    expect(screen.queryByTestId("host-no-credential-git")).toBeNull()
    expect(credentialCalls(invoke)).toEqual([])
  })

  it("GitHub (github.com only, no picker): neutral hint, no Check again, OAuth without the auto-auth FAQ", async () => {
    const invoke = installApi({ "github:enumerate-hosts": GITHUB_COM_ONLY })

    renderWithApi(<GitAuth id="git" detectCredentials={false} />)
    await screen.findByText(/redirected to authorize/i)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("github:enumerate-hosts", {}))
    await settleCliStatus(invoke)

    expect(screen.queryByRole("combobox")).toBeNull()
    expectNoDetectionAffordances("GitHub")
    // The OAuth pane's other FAQ is about the sign-in itself, so it stays.
    expect(screen.getByText("What permissions does this grant?")).toBeInTheDocument()
    expect(credentialCalls(invoke)).toEqual([])
  })

  it("GitHub with an Enterprise host: the picker has no Reload or credential annotations", async () => {
    const invoke = installApi({ "github:enumerate-hosts": GITHUB_WITH_GHES })

    renderWithApi(<GitAuth id="git" detectCredentials={false} />)
    const select = await screen.findByRole("combobox")
    expect(screen.getByRole("option", { name: "ghes.corp" })).toBeInTheDocument()
    await settleCliStatus(invoke)

    expect(select).toHaveValue("github.com")
    expectNoDetectionAffordances("GitHub")
    expect(screen.queryByTestId("host-sources-git")).toBeNull()
    expect(screen.queryByTestId("host-credential-git")).toBeNull()
  })

  it("GitHub pinned to an Enterprise host without a client ID: no Check again, and the OAuth tab points at a token only", async () => {
    const invoke = installApi()

    renderWithApi(<GitAuth id="git" host="ghes.corp" detectCredentials={false} />)
    await screen.findByText(
      /Sign-in with GitHub isn't set up for ghes\.corp\. Use a personal access token instead\./,
    )
    await settleCliStatus(invoke)

    expectNoDetectionAffordances("GitHub")
    expect(credentialCalls(invoke)).toEqual([])
  })

  it.each([
    ["GitHubAuth", "GitHub", () => <GitHubAuth id="git" detectCredentials={false} />],
    ["GitLabAuth", "GitLab", () => <GitLabAuth id="git" detectCredentials={false} />],
  ] as const)("<%s> inherits it", async (_name, label, ui) => {
    const invoke = installApi({
      "github:enumerate-hosts": GITHUB_COM_ONLY,
      "gitlab:enumerate-hosts": GITLAB_HOSTS,
    })

    renderWithApi(ui())
    await screen.findByTestId("vcs-cli-hint")
    await settleCliStatus(invoke)

    expectNoDetectionAffordances(label)
    expect(credentialCalls(invoke)).toEqual([])
  })
})

// Control: with detection on and nothing found, the same setups still offer
// the login suggestion and the FAQ, so the negative assertions above can't
// pass vacuously.
describe("GitAuth — default detection finds nothing (control)", () => {
  it("GitHub: login hint, Check again and the auto-auth FAQ", async () => {
    installApi({ "github:enumerate-hosts": GITHUB_COM_ONLY })

    renderWithApi(<GitAuth id="git" />)

    expect(await screen.findByTestId("vcs-cli-hint")).toHaveTextContent("run 'gh auth login'")
    expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument()
    expect(screen.getByText("How can I authenticate to GitHub automatically?")).toBeInTheDocument()
  })

  it("GitLab: login hint, Reload, host annotations and the auto-auth FAQ", async () => {
    installApi({ "gitlab:enumerate-hosts": GITLAB_HOSTS })

    renderWithApi(<GitAuth id="git" provider="gitlab" />)

    expect(await screen.findByTestId("vcs-cli-hint")).toHaveTextContent("run 'glab auth login'")
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument()
    expect(screen.getByTestId("host-sources-git")).toHaveTextContent("glab")
    expect(screen.getByTestId("host-credential-git")).toBeInTheDocument()
    expect(screen.getByText("How can I authenticate to GitLab automatically?")).toBeInTheDocument()
  })
})
