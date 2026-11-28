import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { ReactNode } from "react"
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react"
import { TestWrapper } from "@/test/test-utils"
import { ApiProvider } from "@/contexts/ApiContext"
import { makeTestApi, type Handlers, type TestApi } from "@/test/test-api"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { useRunbookContext } from "@/contexts/useRunbook"

// Integration test that exercises the REAL useGitAuth hook (not mocked) across a
// runtime provider switch. detectCredentials={false} disables auto-detection so
// the manual auth forms render immediately without any IPC.
vi.mock("@/contexts/useSession", () => ({
  useSession: () => ({ isReady: true }),
}))

import { GitAuth } from "../GitAuth"

// Both CLIs installed, for the manual UI's hint.
const CLI_STATUS = {
  gh: { installed: true, version: "2.60.0", meetsFloor: true },
  glab: { installed: true, version: "1.80.0", meetsFloor: true },
}

/** A machine with no credential to detect and no host configured beyond the SaaS ones. */
const NOTHING_FOUND: Handlers = {
  "github:enumerate-hosts": () => ({
    hosts: [{ host: "github.com", sources: [], hasCredential: false }],
    defaultHost: "github.com",
  }),
  "gitlab:enumerate-hosts": () => ({ hosts: [], defaultHost: "gitlab.com" }),
  "github:env-credentials": () => ({ found: false }),
  "github:cli-credentials": () => ({ found: false }),
  "gitlab:env-credentials": () => ({ found: false }),
  "gitlab:cli-credentials": () => ({ found: false }),
  "github:host-picked": () => ({ ok: true }),
  "gitlab:host-picked": () => ({ ok: true }),
  "vcs:invalidate-cache": () => ({ ok: true }),
  "vcs:cli-status": () => CLI_STATUS,
}

let currentApi: TestApi

/**
 * Install a fake IPC surface: `handlers`, over a machine where detection finds
 * no credential. Returns it so channels/params can be asserted.
 */
function installApi(handlers: Handlers = {}) {
  currentApi = makeTestApi({ ...NOTHING_FOUND, ...handlers })
  return currentApi
}

// ApiProvider sits inside TestWrapper so only the block's IPC reaches the spy
// (the theme provider skips its own call when there is no API).
function renderWithApi(ui: ReactNode) {
  return render(
    <TestWrapper>
      <ApiProvider api={currentApi.api}>{ui}</ApiProvider>
    </TestWrapper>,
  )
}

/** Reads the outputs the block published, so withdrawals can be asserted directly. */
function OutputsProbe({ id }: { id: string }) {
  const { blockOutputs } = useRunbookContext()
  return (
    <div data-testid="published-outputs">{JSON.stringify(blockOutputs[id]?.values ?? null)}</div>
  )
}

const publishedOutputs = () =>
  JSON.parse(screen.getByTestId("published-outputs").textContent || "null")

beforeEach(() => {
  installApi()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("GitAuth — provider switch (real hook)", () => {
  it("GitHub→GitLab switch renders the GitLab PAT form (not an empty form region)", async () => {
    renderWithApi(<GitAuth id="git" detectCredentials={false} />)

    // Starts on GitHub with the OAuth device flow visible.
    expect(screen.getByText(/redirected to authorize/i)).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/GitLab access token/i)).toBeNull()

    // Switch to GitLab via the provider picker.
    fireEvent.click(screen.getByRole("tab", { name: /GitLab/ }))

    // Regression guard: the GitLab PAT form must appear. Before the fix, the
    // auth method stayed 'oauth' and GitLab (which has no OAuth) rendered
    // nothing in the form region.
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/GitLab access token/i)).toBeInTheDocument()
    })
    expect(screen.queryByText(/redirected to authorize/i)).toBeNull()
  })

  it("keeps the host switcher visible after auto-authenticating, so you can move to a self-managed host", async () => {
    // Reproduces the reported issue: auto-detection lands on glab's default host
    // (gitlab.com), and the user still needs to reach their private instance.
    const testApi = installApi({
      "gitlab:enumerate-hosts": () => ({
        hosts: [
          { host: "gitlab.com", sources: ["glab"], hasCredential: true },
          { host: "gitlab.gruntwork.io", sources: ["glab"], hasCredential: true },
        ],
        defaultHost: "gitlab.com",
      }),
      "gitlab:cli-credentials": ({ host }) => ({
        found: true,
        user: { login: host === "gitlab.gruntwork.io" ? "root" : "odgrim" },
        ...(host === undefined ? {} : { host }),
      }),
      "session:clear-env-export": () => ({ ok: true }),
    })

    renderWithApi(<GitAuth id="git" provider="gitlab" />)

    // Auto-detects against glab's default host first.
    await waitFor(() => {
      expect(screen.getByText(/Authenticated to GitLab \(gitlab\.com\)/i)).toBeInTheDocument()
    })

    // The host switcher must still be on screen (it was previously hidden once
    // authenticated), offering the private instance.
    const select = screen.getByRole("combobox")
    expect(screen.getByRole("option", { name: "gitlab.gruntwork.io" })).toBeInTheDocument()

    // Switching hosts re-detects against the chosen instance.
    fireEvent.change(select, { target: { value: "gitlab.gruntwork.io" } })

    await waitFor(() => {
      expect(
        screen.getByText(/Authenticated to GitLab \(gitlab\.gruntwork\.io\)/i),
      ).toBeInTheDocument()
    })
    expect(testApi.invoke).toHaveBeenCalledWith("gitlab:cli-credentials", {
      componentId: "git",
      host: "gitlab.gruntwork.io",
    })
  })

  it("GitHub→GitLab switch detects only once the GitLab hosts are known", async () => {
    // The glab default (or the persisted pick) is a self-managed host. Nothing
    // may be detected against the gitlab.com default before the enumeration
    // says so — a gitlab.com env hit would authenticate the wrong instance.
    const testApi = installApi({
      "gitlab:env-credentials": ({ host }) =>
        host === "gitlab.com"
          ? {
              found: true,
              valid: true,
              user: { login: "tanuki" },
              envVar: "GITLAB_TOKEN",
              host: "gitlab.com",
            }
          : { found: false },
    })
    const enumerations = testApi.hold("gitlab:enumerate-hosts")

    renderWithApi(<GitAuth id="git" />)

    // GitHub detection finds nothing, so the manual UI renders.
    await waitFor(() => {
      expect(screen.getByText(/redirected to authorize/i)).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole("tab", { name: /GitLab/ }))
    await waitFor(() => expect(testApi.invoke).toHaveBeenCalledWith("gitlab:enumerate-hosts", {}))
    const gitlabDetectionCalls = () => [
      ...testApi.callsTo("gitlab:env-credentials"),
      ...testApi.callsTo("gitlab:cli-credentials"),
    ]
    expect(gitlabDetectionCalls()).toEqual([])

    await act(async () => {
      enumerations.at(-1)!.resolve({
        hosts: [{ host: "gitlab.corp", sources: ["glab"], hasCredential: true }],
        defaultHost: "gitlab.corp",
      })
    })

    await waitFor(() =>
      expect(testApi.invoke).toHaveBeenCalledWith("gitlab:cli-credentials", {
        componentId: "git",
        host: "gitlab.corp",
      }),
    )
    expect(testApi.invoke).toHaveBeenCalledWith(
      "gitlab:env-credentials",
      expect.objectContaining({ host: "gitlab.corp" }),
    )
    expect(gitlabDetectionCalls().every(({ host }) => host === "gitlab.corp")).toBe(true)
    expect(screen.queryByText(/Authenticated to GitLab/i)).toBeNull()
  })

  it("Reload detects only against the host the re-read glab config names", async () => {
    // The card signed in on gitlab.com; the user then ran `glab auth login`
    // for a self-managed host, which is now glab's default. Reload must not
    // re-detect against gitlab.com before the new host list arrives.
    let enumerations = 0
    const testApi = installApi({
      "gitlab:enumerate-hosts": () => {
        enumerations += 1
        return {
          hosts: [
            { host: "gitlab.com", sources: ["env"], hasCredential: true },
            { host: "git.corp.example", sources: ["glab"], hasCredential: true },
          ],
          defaultHost: enumerations === 1 ? "gitlab.com" : "git.corp.example",
        }
      },
      "gitlab:env-credentials": ({ host }) =>
        host === "gitlab.com"
          ? {
              found: true,
              valid: true,
              user: { login: "tanuki" },
              envVar: "GITLAB_TOKEN",
              host: "gitlab.com",
            }
          : { found: false },
      "gitlab:cli-credentials": ({ host }) =>
        host === "git.corp.example"
          ? { found: true, user: { login: "corp-user" }, host: "git.corp.example" }
          : { found: false },
    })
    // The detection calls since `before`, a count of each channel's calls.
    const detectionCount = () => ({
      env: testApi.callsTo("gitlab:env-credentials").length,
      cli: testApi.callsTo("gitlab:cli-credentials").length,
    })
    const detectionCallsSince = (before: { env: number; cli: number }) => [
      ...testApi.callsTo("gitlab:env-credentials").slice(before.env),
      ...testApi.callsTo("gitlab:cli-credentials").slice(before.cli),
    ]

    renderWithApi(<GitAuth id="git" provider="gitlab" />)
    await screen.findByText(/Authenticated to GitLab \(gitlab\.com\)/i)
    const before = detectionCount()

    fireEvent.click(screen.getByRole("button", { name: "Reload" }))

    await screen.findByText(/Authenticated to GitLab \(git\.corp\.example\)/i)
    expect((await screen.findAllByText(/corp-user/)).length).toBeGreaterThan(0)
    const afterReload = detectionCallsSince(before)
    expect(afterReload.length).toBeGreaterThan(0)
    expect(afterReload.every(({ host }) => host === "git.corp.example")).toBe(true)
  })

  it("GitLab→GitHub switch restores the GitHub OAuth flow", async () => {
    renderWithApi(<GitAuth id="git" provider="gitlab" detectCredentials={false} />)

    expect(screen.getByPlaceholderText(/GitLab access token/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole("tab", { name: /GitHub/ }))

    await waitFor(() => {
      expect(screen.getByText(/redirected to authorize/i)).toBeInTheDocument()
    })
  })

  it("publishes the new provider as GIT_PROVIDER on a switch", async () => {
    renderWithApi(
      <>
        <GitAuth id="git" detectCredentials={false} />
        <OutputsProbe id="git" />
      </>,
    )

    fireEvent.click(screen.getByRole("tab", { name: /GitLab/ }))

    // Downstream PR/MR blocks read it before the new provider authenticates.
    await waitFor(() => expect(publishedOutputs()).toEqual({ GIT_PROVIDER: "gitlab" }))
  })
})

describe("GitAuth — Re-authenticate (real hook)", () => {
  it("withdraws the credential from the block outputs, keeping GIT_PROVIDER", async () => {
    installApi({
      "gitlab:validate": () => ({ valid: true, user: { login: "tanuki" }, tokenType: "pat" }),
    })

    renderWithApi(
      <>
        <GitAuth id="git" provider="gitlab" detectCredentials={false} />
        <OutputsProbe id="git" />
      </>,
    )

    fireEvent.change(screen.getByPlaceholderText(/GitLab access token/i), {
      target: { value: "glpat-abc" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Authenticate" }))
    await screen.findByRole("button", { name: "Re-authenticate" })
    // The token is a sensitive output, so the probe's JSON shows it as <redacted>
    expect(publishedOutputs()).toMatchObject({
      GITLAB_TOKEN: "<redacted>",
      __AUTHENTICATED: "true",
    })

    fireEvent.click(screen.getByRole("button", { name: "Re-authenticate" }))

    // A gitAuthId step is gated again until the user signs in anew.
    await waitFor(() => expect(publishedOutputs()).toEqual({ GIT_PROVIDER: "gitlab" }))
    expect(screen.getByPlaceholderText(/GitLab access token/i)).toBeInTheDocument()
  })

  it("does not sign back in with the ambient credential on window focus until a provider switch", async () => {
    const testApi = installApi({
      "github:env-credentials": () => ({
        found: true,
        valid: true,
        user: { login: "ambient" },
        envVar: "GITHUB_TOKEN",
      }),
    })
    const detections = (channel: "github:env-credentials" | "gitlab:cli-credentials") =>
      testApi.callsTo(channel).length

    renderWithApi(<GitAuth id="git" />)
    fireEvent.click(await screen.findByRole("button", { name: "Re-authenticate" }))
    await screen.findByText(/redirected to authorize/i)

    // The user leaves to create a new token and comes back.
    act(() => {
      window.dispatchEvent(new Event("focus"))
    })
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 20)
      })
    })
    expect(detections("github:env-credentials")).toBe(1)
    expect(screen.queryByRole("button", { name: "Re-authenticate" })).toBeNull()

    // A provider switch re-arms it: GitLab finds nothing, and focus re-checks.
    fireEvent.click(screen.getByRole("tab", { name: /GitLab/ }))
    await waitFor(() => expect(detections("gitlab:cli-credentials")).toBe(1))
    await screen.findByPlaceholderText(/GitLab access token/i)
    act(() => {
      window.dispatchEvent(new Event("focus"))
    })
    await waitFor(() => expect(detections("gitlab:cli-credentials")).toBe(2))
  })

  it("offers Check again on a host-pinned GitLab block, which has no Reload", async () => {
    const testApi = installApi({
      "gitlab:env-credentials": () => ({
        found: true,
        valid: true,
        user: { login: "ambient" },
        envVar: "GITLAB_TOKEN",
        host: "gitlab.corp",
      }),
      "vcs:cli-status": () => CLI_STATUS,
    })
    const detections = () => testApi.callsTo("gitlab:env-credentials").length

    renderWithApi(<GitAuth id="git" provider="gitlab" host="gitlab.corp" />)
    fireEvent.click(await screen.findByRole("button", { name: "Re-authenticate" }))
    await screen.findByPlaceholderText(/GitLab access token/i)
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull()

    // Focus re-detection is off after Re-authenticate; Check again is the
    // user's way to ask for detection again.
    fireEvent.click(await screen.findByRole("button", { name: "Check again" }))
    await screen.findByRole("button", { name: "Re-authenticate" })
    expect(detections()).toBe(2)
  })
  it("offers Check again on a github.com-only GitHub block, which shows no host picker", async () => {
    const testApi = installApi({
      "github:enumerate-hosts": () => ({
        hosts: [{ host: "github.com", sources: [], hasCredential: true }],
        defaultHost: "github.com",
      }),
      "github:env-credentials": () => ({
        found: true,
        valid: true,
        user: { login: "ambient" },
        envVar: "GITHUB_TOKEN",
      }),
      "vcs:cli-status": () => CLI_STATUS,
    })
    const detections = () => testApi.callsTo("github:env-credentials").length

    renderWithApi(<GitAuth id="git" />)
    fireEvent.click(await screen.findByRole("button", { name: "Re-authenticate" }))
    await screen.findByText(/redirected to authorize/i)
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull()

    fireEvent.click(await screen.findByRole("button", { name: "Check again" }))
    await screen.findByRole("button", { name: "Re-authenticate" })
    expect(detections()).toBe(2)
  })
})

describe("GitAuth — defaultTab (real hook)", () => {
  it("opens on the PAT form when the author asks for it", () => {
    renderWithApi(<GitAuth id="git" defaultTab="pat" detectCredentials={false} />)

    expect(screen.getByPlaceholderText(/github_pat_/i)).toBeInTheDocument()
    expect(screen.queryByText(/redirected to authorize/i)).toBeNull()
  })

  it("re-applies defaultTab after a provider switch", async () => {
    renderWithApi(<GitAuth id="git" provider="gitlab" defaultTab="pat" detectCredentials={false} />)

    expect(screen.getByPlaceholderText(/GitLab access token/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole("tab", { name: /GitHub/ }))

    // GitHub defaults to OAuth, but the author pinned the PAT tab.
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/github_pat_/i)).toBeInTheDocument()
    })
    expect(screen.queryByText(/redirected to authorize/i)).toBeNull()
  })

  it("ignores a tab the provider does not offer", () => {
    // GitLab has no OAuth device flow — the PAT form must still render.
    renderWithApi(
      <GitAuth id="git" provider="gitlab" defaultTab="oauth" detectCredentials={false} />,
    )

    expect(screen.getByPlaceholderText(/GitLab access token/i)).toBeInTheDocument()
  })
})

describe("GitAuth — configuration errors (real hook)", () => {
  function ReportedErrors() {
    const { errors } = useErrorReporting()
    return <div data-testid="reported-errors">{errors.map((e) => e.message).join("|")}</div>
  }

  it("reports an unknown provider instead of crashing the runbook, and detects nothing", async () => {
    const testApi = installApi()

    renderWithApi(
      <>
        {/* A case typo an author can easily make in MDX. */}
        <GitAuth id="git" provider={"GitLab" as never} />
        <p>The next step</p>
        <ReportedErrors />
      </>,
    )

    expect(screen.getByTestId("component-error")).toHaveTextContent(
      `invalid 'provider' prop: "GitLab"`,
    )
    // The rest of the runbook still renders.
    expect(screen.getByText("The next step")).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByTestId("reported-errors").textContent).toContain("invalid 'provider' prop")
    })
    const channels = testApi.calls.map(({ channel }) => channel)
    expect(channels.filter((c) => c.endsWith("-credentials") || c.endsWith(":validate"))).toEqual(
      [],
    )
  })

  it("skips an unrecognized detectCredentials entry and still tries the rest", async () => {
    const testApi = installApi()

    renderWithApi(<GitAuth id="git" detectCredentials={["gh" as never, "env"]} />)

    // Detection finishes (no hung "Checking…" spinner) and the sign-in form renders.
    await waitFor(() => {
      expect(screen.getByText(/redirected to authorize/i)).toBeInTheDocument()
    })
    expect(testApi.invoke).toHaveBeenCalledWith("github:env-credentials", expect.anything())
  })
})
