import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createElement, type ReactNode } from "react"
import { renderHook, act, waitFor } from "@testing-library/react"
import { ApiProvider } from "@/contexts/ApiContext"
import { makeTestApi, type Handlers, type Result, type TestApi } from "@/test/test-api"
import { useGitAuth } from "../useGitAuth"
import { PROVIDERS } from "../../providers"
import { sensitiveOutput, type OutputValues } from "@/lib/outputValues"

// The hook depends on the runbook + session contexts; mock them so the test
// can focus on the provider-aware IPC behavior. Reassign `blockOutputs` (and
// rerender) to simulate another block registering outputs: the hook watches
// the map by identity, as it does the real context's state. IPC is the one
// faked boundary, injected through the real ApiProvider.
const registerOutputs = vi.fn()
let blockOutputs: Record<string, { values: OutputValues }> = {}

vi.mock("@/contexts/useRunbook", () => ({
  useRunbookContext: () => ({ registerOutputs, blockOutputs }),
}))
vi.mock("@/contexts/useSession", () => ({
  useSession: () => ({ isReady: true }),
}))

// Both CLIs installed, for the manual UI's hint.
const CLI_STATUS: Result<"vcs:cli-status"> = {
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
 * Install a fake IPC surface answering with `handlers`, over NOTHING_FOUND.
 * Returns it so channels/params can be asserted.
 */
function installApi(handlers: Handlers) {
  currentApi = makeTestApi({ ...NOTHING_FOUND, ...handlers })
  return currentApi
}

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(ApiProvider, { api: currentApi.api }, children)

type Options = Parameters<typeof useGitAuth>[0]

const renderGitAuth = (options: Options) => renderHook(() => useGitAuth(options), { wrapper })

afterEach(() => {
  blockOutputs = {}
  vi.clearAllMocks()
})

beforeEach(() => {
  registerOutputs.mockClear()
})

describe("useGitAuth — GitLab provider", () => {
  it("runs detection against gitlab:* channels only (never github:* or oauth)", async () => {
    const testApi = installApi({
      "gitlab:env-credentials": () => ({ found: false }),
      "gitlab:cli-credentials": () => ({ found: false }),
    })

    renderGitAuth({ id: "git", provider: PROVIDERS.gitlab })

    await waitFor(() => {
      expect(testApi.invoke).toHaveBeenCalledWith("gitlab:env-credentials", expect.anything())
      expect(testApi.invoke).toHaveBeenCalledWith("gitlab:cli-credentials", expect.anything())
    })

    const channelsCalled = testApi.calls.map(({ channel }) => channel)
    expect(channelsCalled.some((c) => c.startsWith("github:"))).toBe(false)
    expect(channelsCalled.some((c) => c.includes("oauth"))).toBe(false)
  })

  it("PAT success registers GITLAB_TOKEN/GITLAB_USER and writes session env", async () => {
    const testApi = installApi({
      "gitlab:validate": () => {
        return {
          valid: true,
          user: { login: "tanuki", name: "Tanuki" },
          tokenType: "pat",
        }
      },
      "session:set-env": () => ({ ok: true }),
    })

    const { result } = renderGitAuth({
      id: "git",
      provider: PROVIDERS.gitlab,
      detectCredentials: false,
    })

    act(() => result.current.setPatToken("glpat-abc"))
    await act(async () => {
      await result.current.handlePatSubmit()
    })

    expect(testApi.invoke).toHaveBeenCalledWith("gitlab:validate", {
      token: "glpat-abc",
      host: "gitlab.com",
      registerSession: true,
    })
    // GIT_PROVIDER + __AUTHENTICATED are registered as block outputs so
    // downstream blocks can derive the linked instance / chain via session.
    expect(registerOutputs).toHaveBeenCalledWith("git", {
      GITLAB_TOKEN: sensitiveOutput("glpat-abc"),
      GITLAB_USER: "tanuki",
      GITLAB_HOST: "gitlab.com",
      GIT_PROVIDER: "gitlab",
      __AUTHENTICATED: "true",
    })
    expect(testApi.invoke).not.toHaveBeenCalledWith("session:set-env", expect.anything())
    expect(result.current.authStatus).toBe("authenticated")
    // No scopes returned (introspection unavailable) → no claim about missing scopes.
    expect(result.current.missingScope).toBe(false)
  })

  it("sends a self-hosted instanceUrl to gitlab:validate when supplying a token", async () => {
    const testApi = installApi({
      "gitlab:validate": () => {
        return { valid: true, user: { login: "tanuki" }, tokenType: "pat" }
      },
      "session:set-env": () => ({ ok: true }),
    })

    const { result } = renderGitAuth({
      id: "git",
      provider: PROVIDERS.gitlab,
      instanceUrl: "https://gitlab.acme.com",
      detectCredentials: false,
    })

    act(() => result.current.setPatToken("glpat-abc"))
    await act(async () => {
      await result.current.handlePatSubmit()
    })

    expect(testApi.invoke).toHaveBeenCalledWith("gitlab:validate", {
      token: "glpat-abc",
      registerSession: true,
      instanceUrl: "https://gitlab.acme.com",
    })
  })

  it("pairs the PAT with the entered instance host (not the default) in the banner and validate call", async () => {
    // Regression for the token<->host mismatch: when a self-managed instance URL
    // is supplied, the validate call (whose handler writes GITLAB_HOST into the
    // session env main-side) and the success banner must match that
    // instance — not the picker's gitlab.com default.
    const testApi = installApi({
      "gitlab:validate": () => {
        return { valid: true, user: { login: "tanuki" }, tokenType: "pat" }
      },
      "session:set-env": () => ({ ok: true }),
    })

    const { result } = renderGitAuth({
      id: "git",
      provider: PROVIDERS.gitlab,
      instanceUrl: "https://gitlab.acme.com",
      detectCredentials: false,
    })

    act(() => result.current.setPatToken("glpat-abc"))
    await act(async () => {
      await result.current.handlePatSubmit()
    })

    expect(testApi.invoke).toHaveBeenCalledWith("gitlab:validate", {
      token: "glpat-abc",
      registerSession: true,
      instanceUrl: "https://gitlab.acme.com",
    })
    expect(testApi.invoke).not.toHaveBeenCalledWith("session:set-env", expect.anything())
    expect(result.current.selectedHost).toBe("gitlab.acme.com")
  })

  it("a runtime instance-URL edit overrides the seeded prop on validate", async () => {
    const testApi = installApi({
      "gitlab:validate": () => {
        return { valid: true, user: { login: "tanuki" }, tokenType: "pat" }
      },
      "session:set-env": () => ({ ok: true }),
    })

    const { result } = renderGitAuth({
      id: "git",
      provider: PROVIDERS.gitlab,
      instanceUrl: "https://seed.example.com",
      detectCredentials: false,
    })

    act(() => {
      result.current.setGitlabInstanceUrl("https://edited.example.com")
      result.current.setPatToken("glpat-abc")
    })
    await act(async () => {
      await result.current.handlePatSubmit()
    })

    expect(testApi.invoke).toHaveBeenCalledWith("gitlab:validate", {
      token: "glpat-abc",
      registerSession: true,
      instanceUrl: "https://edited.example.com",
    })
  })

  it("threads the instanceUrl through env/cli credential detection", async () => {
    const testApi = installApi({
      "gitlab:env-credentials": () => ({ found: false }),
      "gitlab:cli-credentials": () => ({ found: false }),
    })

    renderGitAuth({
      id: "git",
      provider: PROVIDERS.gitlab,
      instanceUrl: "https://gitlab.acme.com",
    })

    await waitFor(() => {
      expect(testApi.invoke).toHaveBeenCalledWith(
        "gitlab:env-credentials",
        expect.objectContaining({ instanceUrl: "https://gitlab.acme.com" }),
      )
      expect(testApi.invoke).toHaveBeenCalledWith(
        "gitlab:cli-credentials",
        expect.objectContaining({ instanceUrl: "https://gitlab.acme.com" }),
      )
    })
  })

  it("shows introspected scopes and does not warn when write_repository is present", async () => {
    installApi({
      "gitlab:validate": () => {
        return {
          valid: true,
          user: { login: "tanuki" },
          tokenType: "pat",
          scopes: ["read_user", "write_repository"],
        }
      },
      "session:set-env": () => ({ ok: true }),
    })

    const { result } = renderGitAuth({
      id: "git",
      provider: PROVIDERS.gitlab,
      detectCredentials: false,
    })

    act(() => result.current.setPatToken("glpat-abc"))
    await act(async () => {
      await result.current.handlePatSubmit()
    })

    expect(result.current.detectedScopes).toEqual(["read_user", "write_repository"])
    expect(result.current.missingScope).toBe(false)
  })

  it("does not warn when the token has the api superset scope", async () => {
    installApi({
      "gitlab:validate": () => {
        return { valid: true, user: { login: "tanuki" }, tokenType: "pat", scopes: ["api"] }
      },
      "session:set-env": () => ({ ok: true }),
    })

    const { result } = renderGitAuth({
      id: "git",
      provider: PROVIDERS.gitlab,
      detectCredentials: false,
    })

    act(() => result.current.setPatToken("glpat-abc"))
    await act(async () => {
      await result.current.handlePatSubmit()
    })

    expect(result.current.detectedScopes).toEqual(["api"])
    expect(result.current.missingScope).toBe(false)
  })

  it("warns when the token grants no repository write access", async () => {
    installApi({
      "gitlab:validate": () => {
        return {
          valid: true,
          user: { login: "tanuki" },
          tokenType: "pat",
          scopes: ["read_user", "read_repository"],
        }
      },
      "session:set-env": () => ({ ok: true }),
    })

    const { result } = renderGitAuth({
      id: "git",
      provider: PROVIDERS.gitlab,
      detectCredentials: false,
    })

    act(() => result.current.setPatToken("glpat-abc"))
    await act(async () => {
      await result.current.handlePatSubmit()
    })

    expect(result.current.detectedScopes).toEqual(["read_user", "read_repository"])
    expect(result.current.missingScope).toBe(true)
  })

  it("detection warnings reference GITLAB_TOKEN / glab, never GITHUB_TOKEN", async () => {
    installApi({
      "gitlab:env-credentials": () => {
        return { found: true, valid: false, error: "bad token" }
      },
      "gitlab:cli-credentials": () => ({ found: false }),
    })

    const { result } = renderGitAuth({ id: "git", provider: PROVIDERS.gitlab })

    await waitFor(() => {
      expect(result.current.detectionWarning).toContain("GITLAB_TOKEN")
    })
    expect(result.current.detectionWarning).not.toContain("GITHUB_TOKEN")
  })

  it("enumerates glab hosts and detects against glab's default host", async () => {
    const testApi = installApi({
      "gitlab:enumerate-hosts": () => {
        return {
          hosts: [
            { host: "gitlab.com", sources: ["glab"], hasCredential: true },
            { host: "gitlab.gruntwork.io", sources: ["glab"], hasCredential: true },
          ],
          defaultHost: "gitlab.gruntwork.io",
        }
      },
      "gitlab:env-credentials": () => ({ found: false }),
      "gitlab:cli-credentials": (args) => {
        const host = args.host
        return host === "gitlab.gruntwork.io"
          ? { found: true, user: { login: "root" }, scopes: ["api"], host }
          : { found: false }
      },
      "session:set-env": () => ({ ok: true }),
    })

    const { result } = renderGitAuth({ id: "git", provider: PROVIDERS.gitlab })

    await waitFor(() => expect(result.current.authStatus).toBe("authenticated"))
    expect(result.current.availableHosts.map((h) => h.host)).toEqual([
      "gitlab.com",
      "gitlab.gruntwork.io",
    ])
    expect(result.current.selectedHost).toBe("gitlab.gruntwork.io")
    // Detection targeted the self-managed default host, not gitlab.com.
    expect(testApi.invoke).toHaveBeenCalledWith("gitlab:cli-credentials", {
      host: "gitlab.gruntwork.io",
    })
  })

  it("changeHost re-runs detection against the newly selected host", async () => {
    const testApi = installApi({
      "gitlab:enumerate-hosts": () => {
        return {
          hosts: [
            { host: "gitlab.com", sources: ["glab"], hasCredential: true },
            { host: "gitlab.gruntwork.io", sources: ["glab"], hasCredential: true },
          ],
          defaultHost: "gitlab.com",
        }
      },
      "gitlab:env-credentials": () => ({ found: false }),
      "gitlab:cli-credentials": (args) => {
        const host = args.host
        return host === "gitlab.gruntwork.io"
          ? { found: true, user: { login: "root" }, host }
          : { found: false }
      },
      "session:set-env": () => ({ ok: true }),
    })

    const { result } = renderGitAuth({ id: "git", provider: PROVIDERS.gitlab })

    // Initial detection targets glab's default (gitlab.com) and finds nothing.
    await waitFor(() => expect(result.current.detectionStatus).toBe("done"))
    expect(result.current.authStatus).not.toBe("authenticated")

    await act(async () => {
      result.current.changeHost("gitlab.gruntwork.io")
    })

    await waitFor(() => expect(result.current.authStatus).toBe("authenticated"))
    expect(testApi.invoke).toHaveBeenCalledWith("gitlab:cli-credentials", {
      host: "gitlab.gruntwork.io",
    })
  })

  it("flags a found-but-invalid CLI token even when the error is a bare 401", async () => {
    // Regression for the silent-failure bug: an expired OAuth token validates as
    // "401 Unauthorized" (no "invalid"/"expired" keyword). Main classifies it
    // authoritatively as outcome 'invalid', so detection surfaces it from that
    // typed signal instead of looking like "no credentials" — never from
    // error-string matching.
    installApi({
      "gitlab:enumerate-hosts": () => ({
        hosts: [{ host: "gitlab.com", sources: ["glab"], hasCredential: true }],
        defaultHost: "gitlab.com",
      }),
      "gitlab:env-credentials": () => ({ found: false }),
      "gitlab:cli-credentials": () => {
        return {
          found: true,
          valid: false,
          outcome: "invalid",
          error: "401 Unauthorized",
          status: 401,
          host: "gitlab.com",
        }
      },
    })

    const { result } = renderGitAuth({ id: "git", provider: PROVIDERS.gitlab })

    await waitFor(() => expect(result.current.detectionStatus).toBe("done"))
    expect(result.current.authStatus).not.toBe("authenticated")
    expect(result.current.detectionWarning).toContain("glab CLI")
    expect(result.current.detectionWarning).toContain("gitlab.com")
  })
})

describe("useGitAuth — GitHub provider (regression)", () => {
  it('warns about a missing "repo" scope and uses GITHUB_TOKEN wording', async () => {
    const testApi = installApi({
      "github:validate": () => {
        return {
          valid: true,
          user: { login: "octocat" },
          tokenType: "classic_pat",
          scopes: ["read:org"],
        }
      },
      "session:set-env": () => ({ ok: true }),
    })

    const { result } = renderGitAuth({
      id: "gh",
      provider: PROVIDERS.github,
      detectCredentials: false,
    })

    act(() => result.current.setPatToken("ghp_abc"))
    await act(async () => {
      await result.current.handlePatSubmit()
    })

    expect(testApi.invoke).toHaveBeenCalledWith("github:validate", {
      token: "ghp_abc",
      host: "github.com",
      registerSession: true,
    })
    expect(result.current.authStatus).toBe("authenticated")
    expect(result.current.missingScope).toBe(true)
    expect(registerOutputs).toHaveBeenCalledWith("gh", {
      GITHUB_TOKEN: sensitiveOutput("ghp_abc"),
      GITHUB_USER: "octocat",
      GITHUB_HOST: "github.com",
      GIT_PROVIDER: "github",
      __AUTHENTICATED: "true",
    })
  })

  it("does not warn for a CLI-detected token with no readable scopes (e.g. fine-grained PAT)", async () => {
    // gh auth token can surface a fine-grained PAT whose X-OAuth-Scopes is empty;
    // we can't claim "repo" is missing when scopes are unknown, so no warning.
    installApi({
      "github:env-credentials": () => ({ found: false }),
      "github:cli-credentials": () => {
        return {
          found: true,
          user: { login: "octocat" },
          tokenType: "fine_grained_pat",
        }
      },
      "session:set-env": () => ({ ok: true }),
    })

    const { result } = renderGitAuth({ id: "gh", provider: PROVIDERS.github })

    await waitFor(() => expect(result.current.authStatus).toBe("authenticated"))
    expect(result.current.missingScope).toBe(false)
  })
})

describe("useGitAuth — tri-state unreachable", () => {
  it("an 'unreachable' env outcome stops the chain without consuming later sources", async () => {
    const testApi = installApi({
      "gitlab:env-credentials": () => {
        return {
          found: true,
          valid: false,
          outcome: "unreachable",
          errorKind: "tls",
          coldReadOk: true,
          error: "TypeError: fetch failed",
          host: "gitlab.corp.example",
        }
      },
    })

    const { result } = renderGitAuth({ id: "git", provider: PROVIDERS.gitlab })

    await waitFor(() => expect(result.current.detectionStatus).toBe("done"))

    // The chain stopped: the CLI source was never consulted.
    const channelsCalled = testApi.calls.map(({ channel }) => channel)
    expect(channelsCalled).not.toContain("gitlab:cli-credentials")

    // The card data is set, and it is NOT an invalid-credentials warning.
    expect(result.current.unreachableInfo).toEqual({
      errorKind: "tls",
      host: "gitlab.corp.example",
      coldReadOk: true,
    })
    expect(result.current.detectionWarning).toBeNull()
    expect(result.current.authStatus).toBe("pending")
  })

  it("an 'invalid' (401) outcome warns and CONTINUES the chain", async () => {
    const testApi = installApi({
      "gitlab:env-credentials": () => {
        return {
          found: true,
          valid: false,
          outcome: "invalid",
          status: 401,
          error: "401 Unauthorized",
        }
      },
      "gitlab:cli-credentials": () => ({ found: false }),
    })

    const { result } = renderGitAuth({ id: "git", provider: PROVIDERS.gitlab })

    await waitFor(() => expect(result.current.detectionStatus).toBe("done"))

    const channelsCalled = testApi.calls.map(({ channel }) => channel)
    expect(channelsCalled).toContain("gitlab:cli-credentials")
    expect(result.current.detectionWarning).toContain("GITLAB_TOKEN")
    expect(result.current.unreachableInfo).toBeNull()
  })

  it("a PAT submission hitting a TLS wall renders the card, never an auth failure", async () => {
    installApi({
      "gitlab:validate": () => {
        return {
          valid: false,
          outcome: "unreachable",
          errorKind: "tls",
          coldReadOk: false,
          error: "TypeError: fetch failed",
        }
      },
    })

    const { result } = renderGitAuth({
      id: "git",
      provider: PROVIDERS.gitlab,
      detectCredentials: false,
    })

    act(() => result.current.setPatToken("glpat-abc"))
    await act(async () => {
      await result.current.handlePatSubmit()
    })

    expect(result.current.authStatus).toBe("pending")
    expect(result.current.errorMessage).toBeNull()
    expect(result.current.unreachableInfo).toEqual({
      errorKind: "tls",
      host: "gitlab.com",
      coldReadOk: false,
    })
  })

  it("disables the GitHub OAuth tab while github.com is unreachable, and Retry re-runs detection", async () => {
    let unreachable = true
    const testApi = installApi({
      "github:env-credentials": () => {
        if (unreachable) {
          return {
            found: true,
            valid: false,
            outcome: "unreachable",
            errorKind: "network",
            error: "getaddrinfo ENOTFOUND api.github.com",
          }
        }
        return { found: true, valid: true, user: { login: "octocat" }, tokenType: "classic_pat" }
      },
      "session:set-env": () => ({ ok: true }),
    })

    const { result } = renderGitAuth({ id: "gh", provider: PROVIDERS.github })

    await waitFor(() => expect(result.current.detectionStatus).toBe("done"))
    expect(result.current.unreachableInfo?.errorKind).toBe("network")
    expect(result.current.unreachableInfo?.host).toBe("github.com")
    expect(result.current.oauthUnavailableReason).toContain("github.com is unreachable")

    // Connectivity restored: Retry clears the card and re-runs the chain.
    unreachable = false
    act(() => result.current.retryUnreachable())
    await waitFor(() => expect(result.current.authStatus).toBe("authenticated"))
    expect(result.current.unreachableInfo).toBeNull()
    expect(result.current.oauthUnavailableReason).toBeNull()
    expect(testApi.callsTo("github:env-credentials").length).toBe(2)
  })

  it("a 'server-cert' failure does not disable the OAuth tab (trust changes can't fix it; the device flow may still work)", async () => {
    installApi({
      "github:env-credentials": () => {
        return {
          found: true,
          valid: false,
          outcome: "unreachable",
          errorKind: "server-cert",
          error: "certificate has expired",
        }
      },
    })

    const { result } = renderGitAuth({ id: "gh", provider: PROVIDERS.github })

    await waitFor(() => expect(result.current.detectionStatus).toBe("done"))
    expect(result.current.unreachableInfo?.errorKind).toBe("server-cert")
    expect(result.current.oauthUnavailableReason).toBeNull()
  })
})

describe("useGitAuth — copy contracts", () => {
  it("renders the main-supplied warning copy VERBATIM for an invalid env token", async () => {
    installApi({
      "gitlab:env-credentials": () => {
        return {
          found: true,
          valid: false,
          outcome: "invalid",
          status: 401,
          error: "401 Unauthorized",
          envVar: "OAUTH_TOKEN",
          warning: "OAUTH_TOKEN is not valid for gitlab.com",
        }
      },
    })

    const { result } = renderGitAuth({ id: "git", provider: PROVIDERS.gitlab })

    await waitFor(() => expect(result.current.detectionStatus).toBe("done"))
    // Exact chip copy — never "expired" (a 401 can't prove that).
    expect(result.current.detectionWarning).toBe("OAUTH_TOKEN is not valid for gitlab.com")
  })

  it("surfaces a keyring-blocked hint as a manual-UI hint, not a warning chip", async () => {
    const KEYRING_COPY =
      "glab stores this token in the OS keyring but could not read it — unlock your keyring or paste a token."
    installApi({
      "gitlab:cli-credentials": () => {
        return { found: false, outcome: "absent", hint: KEYRING_COPY }
      },
    })

    const { result } = renderGitAuth({ id: "git", provider: PROVIDERS.gitlab })

    await waitFor(() => expect(result.current.detectionStatus).toBe("done"))
    expect(result.current.manualHint).toBe(KEYRING_COPY)
    expect(result.current.detectionWarning).toBeNull()
  })

  it("exposes the both-env-vars-set divergence hint on env-detected success", async () => {
    const DIVERGENCE =
      "GH_TOKEN is also set and differs; Runbooks used GITHUB_TOKEN — gh would use GH_TOKEN."
    installApi({
      "github:env-credentials": () => {
        return {
          found: true,
          valid: true,
          user: { login: "octocat" },
          tokenType: "classic_pat",
          envVar: "GITHUB_TOKEN",
          divergenceHint: DIVERGENCE,
        }
      },
      "session:set-env": () => ({ ok: true }),
    })

    const { result } = renderGitAuth({ id: "gh", provider: PROVIDERS.github })

    await waitFor(() => expect(result.current.authStatus).toBe("authenticated"))
    expect(result.current.divergenceHint).toBe(DIVERGENCE)
  })

  it("drives the no-credentials hint from vcs:cli-status (gh installed vs absent)", async () => {
    installApi({
      "vcs:cli-status": () => {
        return {
          gh: { installed: true, version: "2.40.1", meetsFloor: true },
          glab: { installed: false, meetsFloor: false },
        }
      },
    })

    const { result } = renderGitAuth({ id: "gh", provider: PROVIDERS.github })

    await waitFor(() => expect(result.current.detectionStatus).toBe("done"))
    await waitFor(() =>
      expect(result.current.manualHint).toBe(
        "No existing credentials found. Sign in below, set GITHUB_TOKEN, or run 'gh auth login'.",
      ),
    )
  })

  // With detection off, nothing was looked for: the hint must not read as a
  // failed search or send the user to a CLI login the block will ignore.
  it.each([
    ["GitHub", PROVIDERS.github],
    ["GitLab", PROVIDERS.gitlab],
  ])("uses neutral hint copy when detectCredentials is false (%s)", async (_label, provider) => {
    const testApi = installApi({
      "vcs:cli-status": () => {
        return {
          gh: { installed: true, version: "2.40.1", meetsFloor: true },
          glab: { installed: true, version: "1.50.0", meetsFloor: true },
        }
      },
    })

    const { result } = renderGitAuth({ id: "git", provider, detectCredentials: false })

    // The CLI probe still runs (the success card's schannel suggestion needs
    // it); wait for it so the hint below is the settled one.
    await waitFor(() => expect(result.current.cliStatus).not.toBeNull())
    expect(result.current.detectionStatus).toBe("done")
    expect(result.current.manualHint).toBe(
      "This runbook doesn't use existing credentials — sign in below.",
    )
    expect(result.current.manualHint).not.toContain("auth login")
    expect(result.current.manualHint).not.toContain("No existing credentials")
    expect(testApi.calls.filter(({ channel }) => channel.endsWith("-credentials"))).toEqual([])
  })
})

describe("useGitAuth — host union UX", () => {
  const HOSTS: Result<"gitlab:enumerate-hosts"> = {
    hosts: [
      { host: "gitlab.com", sources: ["glab"], hasCredential: true },
      { host: "git.corp.example", sources: ["recent"], hasCredential: false },
    ],
    defaultHost: "gitlab.com",
  }

  const detectionCalls = (testApi: TestApi) =>
    testApi.callsTo("gitlab:cli-credentials").length +
    testApi.callsTo("gitlab:env-credentials").length

  it("the 'Other instance…' sentinel leaves the success card without changing the host or running detection", async () => {
    const testApi = installApi({
      "gitlab:enumerate-hosts": () => HOSTS,
      "gitlab:env-credentials": () => {
        return {
          found: true,
          valid: true,
          user: { login: "tanuki" },
          host: "gitlab.com",
          envVar: "GITLAB_TOKEN",
        }
      },
    })

    const { result } = renderGitAuth({ id: "git", provider: PROVIDERS.gitlab })
    await waitFor(() => expect(result.current.authStatus).toBe("authenticated"))
    const detectionCallsBefore = detectionCalls(testApi)

    act(() => result.current.handleHostSelect("__other__"))

    // The card gives way to the PAT form, whose instance-URL field is asked for,
    // and takes the old instance's credential out of the outputs with it.
    expect(result.current.authStatus).toBe("pending")
    expect(result.current.userInfo).toBeNull()
    expect(registerOutputs).toHaveBeenLastCalledWith("git", { GIT_PROVIDER: "gitlab" })
    expect(result.current.instanceFieldFocusNonce).toBe(1)
    expect(result.current.selectedHost).toBe("gitlab.com")
    // No re-detection fired and no pick was persisted.
    expect(detectionCalls(testApi)).toBe(detectionCallsBefore)
    expect(testApi.callsTo("gitlab:host-picked").length).toBe(0)
  })

  it("the 'Other instance…' sentinel keeps an unauthenticated form's typed token", async () => {
    installApi({
      "gitlab:enumerate-hosts": () => HOSTS,
    })

    const { result } = renderGitAuth({ id: "git", provider: PROVIDERS.gitlab })
    await waitFor(() => expect(result.current.detectionStatus).toBe("done"))
    act(() => result.current.setPatToken("glpat-abc"))

    act(() => result.current.handleHostSelect("__other__"))

    expect(result.current.patToken).toBe("glpat-abc")
    expect(result.current.instanceFieldFocusNonce).toBe(1)
  })

  it("a host pick replaces an entered instance URL, even the previously picked host", async () => {
    const testApi = installApi({
      "gitlab:enumerate-hosts": () => HOSTS,
    })

    const { result } = renderGitAuth({ id: "git", provider: PROVIDERS.gitlab })
    await waitFor(() => expect(result.current.detectionStatus).toBe("done"))

    act(() => result.current.handleHostSelect("__other__"))
    act(() => result.current.setGitlabInstanceUrl("https://gitlab.new.example"))
    expect(result.current.selectedHost).toBe("gitlab.new.example")

    // gitlab.com is still the internal pick; going back to it must not be a no-op.
    const callsBefore = testApi.calls.length
    act(() => result.current.handleHostSelect("gitlab.com"))

    expect(result.current.selectedHost).toBe("gitlab.com")
    expect(result.current.gitlabInstanceUrl).toBe("")
    await waitFor(() => {
      expect(testApi.calls.slice(callsBefore)).toContainEqual({
        channel: "gitlab:cli-credentials",
        params: { host: "gitlab.com" },
      })
    })
    expect(testApi.invoke).toHaveBeenCalledWith("gitlab:host-picked", { host: "gitlab.com" })
  })

  it("a host pick overrides the instanceUrl prop for detection", async () => {
    const testApi = installApi({
      "gitlab:enumerate-hosts": () => HOSTS,
    })

    const { result } = renderGitAuth({
      id: "git",
      provider: PROVIDERS.gitlab,
      instanceUrl: "https://gitlab.acme.com",
    })
    await waitFor(() => expect(result.current.detectionStatus).toBe("done"))
    expect(result.current.selectedHost).toBe("gitlab.acme.com")

    const callsBefore = testApi.calls.length
    act(() => result.current.handleHostSelect("git.corp.example"))

    expect(result.current.selectedHost).toBe("git.corp.example")
    await waitFor(() => expect(result.current.detectionStatus).toBe("done"))
    const redetection = testApi.calls
      .slice(callsBefore)
      .filter(
        ({ channel }) =>
          channel === "gitlab:cli-credentials" || channel === "gitlab:env-credentials",
      )
    expect(redetection.length).toBe(2)
    for (const { params } of redetection) {
      expect(params).toEqual(expect.objectContaining({ host: "git.corp.example" }))
      expect(params).not.toHaveProperty("instanceUrl")
    }
  })

  it("an explicit host pick is persisted via gitlab:host-picked", async () => {
    const testApi = installApi({
      "gitlab:enumerate-hosts": () => HOSTS,
      "gitlab:host-picked": () => ({ ok: true }),
      "vcs:invalidate-cache": () => ({ ok: true }),
    })

    const { result } = renderGitAuth({ id: "git", provider: PROVIDERS.gitlab })
    await waitFor(() => expect(result.current.detectionStatus).toBe("done"))

    act(() => result.current.handleHostSelect("git.corp.example"))

    await waitFor(() => {
      expect(testApi.invoke).toHaveBeenCalledWith("gitlab:host-picked", {
        host: "git.corp.example",
      })
    })
    expect(result.current.selectedHost).toBe("git.corp.example")
  })

  it("flags the session as stale when another block authenticates a different host", async () => {
    const testApi = installApi({
      "gitlab:enumerate-hosts": () => HOSTS,
      "gitlab:env-credentials": () => ({
        found: true,
        valid: true,
        user: { login: "tanuki" },
        host: "gitlab.com",
        envVar: "GITLAB_TOKEN",
      }),
      "session:set-env": () => ({ ok: true }),
    })

    const { result } = renderGitAuth({ id: "git", provider: PROVIDERS.gitlab })
    await waitFor(() => expect(result.current.authStatus).toBe("authenticated"))
    expect(result.current.sessionStale).toBe(false)

    // A second block authenticates a DIFFERENT host → this card is stale.
    act(() =>
      testApi.emit("vcs:session-changed", {
        provider: "gitlab",
        host: "git.corp.example",
        source: "cli",
      }),
    )
    expect(result.current.sessionStale).toBe(true)
  })

  it("ignores session changes for the other provider or the same host", async () => {
    const testApi = installApi({
      "gitlab:enumerate-hosts": () => HOSTS,
      "gitlab:env-credentials": () => ({
        found: true,
        valid: true,
        user: { login: "tanuki" },
        host: "gitlab.com",
        envVar: "GITLAB_TOKEN",
      }),
      "session:set-env": () => ({ ok: true }),
    })

    const { result } = renderGitAuth({ id: "git", provider: PROVIDERS.gitlab })
    await waitFor(() => expect(result.current.authStatus).toBe("authenticated"))

    act(() => testApi.emit("vcs:session-changed", { provider: "github", host: "github.com" }))
    expect(result.current.sessionStale).toBe(false)
    act(() => testApi.emit("vcs:session-changed", { provider: "gitlab", host: "gitlab.com" }))
    expect(result.current.sessionStale).toBe(false)
  })
})

describe("useGitAuth — custody", () => {
  it("chains a referenced GitAuth block via useSessionToken — no token crosses IPC", async () => {
    // The referenced GitAuth block authenticated earlier: metadata-only
    // outputs (no GITHUB_TOKEN), just the __AUTHENTICATED marker.
    blockOutputs["github_auth"] = { values: { __AUTHENTICATED: "true", GIT_PROVIDER: "github" } } // normalizeBlockId maps github-auth → github_auth
    const testApi = installApi({
      "github:validate": (params) => {
        if (params.useSessionToken && params.token === undefined) {
          return { valid: true, user: { login: "octocat" }, tokenType: "oauth" }
        }
        return { valid: false, error: "unexpected payload" }
      },
    })

    const { result } = renderGitAuth({
      id: "gh2",
      provider: PROVIDERS.github,
      detectCredentials: [{ block: "github-auth" }],
    })

    await waitFor(() => expect(result.current.authStatus).toBe("authenticated"))
    expect(testApi.invoke).toHaveBeenCalledWith(
      "github:validate",
      expect.objectContaining({ useSessionToken: true }),
    )
    // The consuming block's outputs stay metadata-only too.
    expect(registerOutputs).toHaveBeenCalledWith(
      "gh2",
      expect.objectContaining({ __AUTHENTICATED: "true" }),
    )
    const outputCalls = registerOutputs.mock.calls.filter((c) => c[0] === "gh2")
    for (const call of outputCalls) {
      expect(call[1].GITHUB_TOKEN).toBeUndefined()
    }
    delete blockOutputs["github_auth"]
  })

  it("OAuth completion is metadata-only: no token in outputs, no renderer session write", async () => {
    vi.useFakeTimers()
    try {
      const testApi = installApi({
        "github:oauth-start": () => {
          return {
            deviceCode: "dev123",
            userCode: "ABCD-1234",
            verificationUri: "https://github.com/login/device",
            interval: 0,
          }
        },
        "github:oauth-poll": () => {
          return {
            status: "complete",
            user: { login: "octocat" },
            tokenType: "oauth",
            scopes: ["repo"],
          }
        },
      })

      const { result } = renderGitAuth({
        id: "gh",
        provider: PROVIDERS.github,
        detectCredentials: false,
      })

      await act(async () => {
        await result.current.startOAuth()
        await vi.runOnlyPendingTimersAsync()
      })

      await vi.waitFor(() => expect(result.current.authStatus).toBe("authenticated"))
      // Metadata-only outputs; main owns the session env.
      expect(registerOutputs).toHaveBeenCalledWith("gh", {
        GITHUB_USER: "octocat",
        GITHUB_HOST: "github.com",
        GIT_PROVIDER: "github",
        __AUTHENTICATED: "true",
      })
      expect(testApi.invoke).not.toHaveBeenCalledWith("session:set-env", expect.anything())
      // clientId was not sent — main owns the default app id.
      const [startParams] = testApi.callsTo("github:oauth-start")
      expect(startParams?.clientId).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("useGitAuth — OAuth device-code polling", () => {
  const DEVICE_CODE = {
    deviceCode: "dev123",
    userCode: "ABCD-1234",
    verificationUri: "https://github.com/login/device",
    interval: 5,
  }

  function installOAuthApi(
    start: Result<"github:oauth-start">,
    nextPoll: () => Result<"github:oauth-poll">,
  ) {
    return installApi({
      "github:oauth-start": () => start,
      "github:oauth-poll": () => nextPoll(),
    })
  }

  const pollCount = (testApi: TestApi) => testApi.callsTo("github:oauth-poll").length

  const renderOAuthHook = () =>
    renderGitAuth({ id: "gh", provider: PROVIDERS.github, detectCredentials: false })

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("keeps polling past 2 minutes while the device code is still valid", async () => {
    const testApi = installOAuthApi({ ...DEVICE_CODE, expiresIn: 900 }, () => ({
      status: "pending",
    }))
    const { result } = renderOAuthHook()

    await act(async () => {
      await result.current.startOAuth()
      await vi.advanceTimersByTimeAsync(3 * 60_000)
    })

    expect(result.current.authStatus).toBe("authenticating")
    expect(result.current.errorMessage).toBeNull()
    expect(pollCount(testApi)).toBeGreaterThan(24)
  })

  it('reports an expired code, not "Authorization failed", once the code outlives its expiry', async () => {
    const testApi = installOAuthApi({ ...DEVICE_CODE, expiresIn: 60 }, () => ({
      status: "pending",
    }))
    const { result } = renderOAuthHook()

    await act(async () => {
      await result.current.startOAuth()
      await vi.advanceTimersByTimeAsync(65_000)
    })

    expect(result.current.authStatus).toBe("failed")
    expect(result.current.errorMessage).toBe("Authorization request expired. Please try again.")
    // Polling stopped at the deadline.
    const polls = pollCount(testApi)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(pollCount(testApi)).toBe(polls)
  })

  it("backs off to the interval GitHub sends with slow_down, for every later poll", async () => {
    let polls = 0
    const testApi = installOAuthApi({ ...DEVICE_CODE, expiresIn: 900 }, () =>
      ++polls === 1 ? { status: "pending", slowDown: true, interval: 15 } : { status: "pending" },
    )
    const { result } = renderOAuthHook()

    await act(async () => {
      await result.current.startOAuth()
    })
    expect(pollCount(testApi)).toBe(1)

    // GitHub's 15s beats the 5s + 5s increment.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_999)
    })
    expect(pollCount(testApi)).toBe(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(pollCount(testApi)).toBe(2)

    // The slower interval sticks after GitHub stops sending slow_down.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_999)
    })
    expect(pollCount(testApi)).toBe(2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(pollCount(testApi)).toBe(3)
  })

  it("a poll in flight when the flow is cancelled and reset never publishes its result", async () => {
    const testApi = installApi({
      "github:oauth-start": () => ({ ...DEVICE_CODE, expiresIn: 900 }),
    })
    const polls = testApi.hold("github:oauth-poll")
    const { result } = renderOAuthHook()

    await act(async () => {
      await result.current.startOAuth()
    })
    expect(pollCount(testApi)).toBe(1)

    // GitAuth's provider switch, while GitHub is still answering the poll.
    act(() => {
      result.current.cancelOAuth()
      result.current.resetAuth()
    })
    await act(async () => {
      polls.at(-1)!.resolve({
        status: "complete",
        user: { login: "octocat" },
        tokenType: "oauth",
        scopes: ["repo"],
      })
    })

    expect(result.current.authStatus).toBe("pending")
    expect(result.current.userInfo).toBeNull()
    expect(registerOutputs).not.toHaveBeenCalled()
  })

  it("cancel then restart polls only the new device code", async () => {
    let starts = 0
    let resolveFirstPoll: (value: Result<"github:oauth-poll">) => void = () => {}
    const testApi = installApi({
      "github:oauth-start": () => {
        starts += 1
        return {
          ...DEVICE_CODE,
          deviceCode: `dev-${starts}`,
          userCode: `CODE-${starts}`,
          expiresIn: 900,
        }
      },
      "github:oauth-poll": (args) => {
        if (args.deviceCode === "dev-1") {
          return new Promise((resolve) => {
            resolveFirstPoll = resolve
          })
        }
        return { status: "pending" }
      },
    })
    const polledCodes = () =>
      testApi.callsTo("github:oauth-poll").map(({ deviceCode }) => deviceCode)
    const { result } = renderOAuthHook()

    await act(async () => {
      await result.current.startOAuth()
    })
    // Cancel while dev-1's first poll is in flight, then start over.
    act(() => result.current.cancelOAuth())
    await act(async () => {
      await result.current.startOAuth()
    })
    await act(async () => {
      resolveFirstPoll({ status: "pending" })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })

    expect(polledCodes()[0]).toBe("dev-1")
    expect(polledCodes().slice(1).length).toBeGreaterThan(1)
    expect(
      polledCodes()
        .slice(1)
        .every((code) => code === "dev-2"),
    ).toBe(true)
    expect(result.current.oauthUserCode).toBe("CODE-2")
    expect(result.current.authStatus).toBe("authenticating")
  })
})

describe("useGitAuth — Re-authenticate", () => {
  const envCalls = (testApi: TestApi) => testApi.callsTo("github:env-credentials").length

  const focusWindow = async () => {
    act(() => {
      window.dispatchEvent(new Event("focus"))
    })
    // Give a re-detection every chance to start and settle.
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 20)
      })
    })
  }

  it("withdraws the credential from the outputs and keeps GIT_PROVIDER", async () => {
    installApi({
      "github:validate": () => ({
        valid: true,
        user: { login: "octocat" },
        tokenType: "classic_pat",
        scopes: ["repo"],
      }),
    })
    const { result } = renderGitAuth({
      id: "gh",
      provider: PROVIDERS.github,
      detectCredentials: false,
    })

    act(() => result.current.setPatToken("ghp_abc"))
    await act(async () => {
      await result.current.handlePatSubmit()
    })
    expect(registerOutputs).toHaveBeenLastCalledWith(
      "gh",
      expect.objectContaining({ GITHUB_TOKEN: sensitiveOutput("ghp_abc") }),
    )

    act(() => result.current.reAuthenticate())

    expect(result.current.authStatus).toBe("pending")
    expect(registerOutputs).toHaveBeenLastCalledWith("gh", { GIT_PROVIDER: "github" })
  })

  it("does not re-detect the ambient credential on window focus", async () => {
    const testApi = installApi({
      "github:env-credentials": () => {
        return { found: true, valid: true, user: { login: "ambient" }, envVar: "GITHUB_TOKEN" }
      },
    })
    const { result } = renderGitAuth({ id: "gh", provider: PROVIDERS.github })
    await waitFor(() => expect(result.current.authStatus).toBe("authenticated"))

    act(() => result.current.reAuthenticate())
    // The user leaves to create a new token and comes back.
    await focusWindow()

    expect(result.current.authStatus).toBe("pending")
    expect(envCalls(testApi)).toBe(1)

    // An explicit "Check again" still re-detects.
    act(() => result.current.retryUnreachable())
    await waitFor(() => expect(result.current.authStatus).toBe("authenticated"))
    expect(envCalls(testApi)).toBe(2)
  })

  it("still re-detects on window focus when detection found nothing", async () => {
    // The zero-click path: sign in with `gh auth login` in a terminal, come back.
    const testApi = installApi({})
    const { result } = renderGitAuth({ id: "gh", provider: PROVIDERS.github })
    await waitFor(() => expect(result.current.detectionStatus).toBe("done"))
    expect(envCalls(testApi)).toBe(1)

    await focusWindow()

    await waitFor(() => expect(envCalls(testApi)).toBe(2))
  })
})

describe("useGitAuth — empty detection sources", () => {
  it("ends detection without trying anything", async () => {
    const testApi = installApi({})

    const { result } = renderGitAuth({
      id: "gh",
      provider: PROVIDERS.github,
      detectCredentials: [],
    })

    await waitFor(() => expect(result.current.detectionStatus).toBe("done"))
    expect(result.current.detectionWarning).toBeNull()
    expect(testApi.calls.map(({ channel }) => channel)).not.toContainEqual(
      expect.stringMatching(/-credentials$/),
    )
  })
})

describe("useGitAuth — {block} detection sources", () => {
  it("falls through to the next source when the block ran without a token", async () => {
    // The block ran and registered outputs, just none this provider reads.
    blockOutputs = { mint: { values: { GH_PAT: "ghp_abc" } } }
    const testApi = installApi({
      "github:env-credentials": () => {
        return { found: true, valid: true, user: { login: "octocat" }, envVar: "GITHUB_TOKEN" }
      },
    })

    const { result } = renderGitAuth({
      id: "gh",
      provider: PROVIDERS.github,
      detectCredentials: [{ block: "mint" }, "env"],
    })

    await waitFor(() => expect(result.current.authStatus).toBe("authenticated"))
    expect(result.current.detectionSource).toBe("env")
    expect(result.current.waitingForBlockId).toBeNull()
    expect(testApi.invoke).not.toHaveBeenCalledWith("github:validate", expect.anything())
  })

  it("pauses on a block that has not run, then resumes the later sources once it runs empty", async () => {
    const testApi = installApi({
      "github:env-credentials": () => {
        return { found: true, valid: true, user: { login: "octocat" }, envVar: "GITHUB_TOKEN" }
      },
    })

    const { result, rerender } = renderGitAuth({
      id: "gh",
      provider: PROVIDERS.github,
      detectCredentials: [{ block: "mint" }, "env"],
    })

    await waitFor(() => expect(result.current.waitingForBlockId).toBe("mint"))
    expect(result.current.detectionStatus).toBe("pending")
    // The author's order is the priority order: env waits behind the block.
    expect(testApi.invoke).not.toHaveBeenCalledWith("github:env-credentials", expect.anything())

    // The block finishes without outputs (e.g. its script failed).
    blockOutputs = { mint: { values: {} } }
    rerender()

    await waitFor(() => expect(result.current.authStatus).toBe("authenticated"))
    expect(result.current.detectionSource).toBe("env")
    expect(testApi.callsTo("github:env-credentials")).toHaveLength(1)
  })

  it("keeps waiting on a GitAuth block's pre-auth placeholder, then chains its auth", async () => {
    // What an upstream <GitAuth> registers when its provider is switched
    // before it authenticates: GIT_PROVIDER only.
    blockOutputs = { git_auth: { values: { GIT_PROVIDER: "github" } } }
    const testApi = installApi({
      "github:validate": ({ useSessionToken }) =>
        useSessionToken
          ? { valid: true, user: { login: "octocat" }, tokenType: "oauth" }
          : { valid: false },
      "github:env-credentials": () => ({
        found: true,
        valid: true,
        user: { login: "ambient" },
        envVar: "GITHUB_TOKEN",
      }),
    })

    const { result, rerender } = renderGitAuth({
      id: "gh2",
      provider: PROVIDERS.github,
      detectCredentials: [{ block: "git-auth" }, "env"],
    })

    await waitFor(() => expect(result.current.waitingForBlockId).toBe("git-auth"))
    expect(testApi.invoke).not.toHaveBeenCalledWith("github:env-credentials", expect.anything())

    blockOutputs = {
      git_auth: {
        values: { GITHUB_USER: "octocat", GIT_PROVIDER: "github", __AUTHENTICATED: "true" },
      },
    }
    rerender()

    await waitFor(() => expect(result.current.authStatus).toBe("authenticated"))
    expect(result.current.detectionSource).toBe("block")
    expect(result.current.userInfo?.login).toBe("octocat")
    expect(testApi.invoke).not.toHaveBeenCalledWith("github:env-credentials", expect.anything())
  })

  it("shows the unreachable card when the awaited block's token hits a TLS wall", async () => {
    const testApi = installApi({
      "github:validate": () => {
        return {
          valid: false,
          outcome: "unreachable",
          errorKind: "tls",
          coldReadOk: true,
          error: "TypeError: fetch failed",
        }
      },
    })

    const { result, rerender } = renderGitAuth({
      id: "gh",
      provider: PROVIDERS.github,
      detectCredentials: [{ block: "mint" }, "env"],
    })
    await waitFor(() => expect(result.current.waitingForBlockId).toBe("mint"))

    blockOutputs = { mint: { values: { GITHUB_TOKEN: "ghp_abc" } } }
    rerender()

    await waitFor(() => expect(result.current.detectionStatus).toBe("done"))
    expect(result.current.unreachableInfo).toEqual({
      errorKind: "tls",
      host: "github.com",
      coldReadOk: true,
    })
    expect(result.current.authStatus).toBe("pending")
    // Every later source would hit the same wall, so the chain stops.
    expect(testApi.invoke).not.toHaveBeenCalledWith("github:env-credentials", expect.anything())
  })

  it("keeps the warnings collected before it paused on a block", async () => {
    const WARNING = "GITHUB_TOKEN is not valid for github.com"
    installApi({
      "github:env-credentials": () => {
        return {
          found: true,
          valid: false,
          outcome: "invalid",
          envVar: "GITHUB_TOKEN",
          warning: WARNING,
        }
      },
    })

    const { result, rerender } = renderGitAuth({
      id: "gh",
      provider: PROVIDERS.github,
      detectCredentials: ["env", { block: "mint" }],
    })
    await waitFor(() => expect(result.current.waitingForBlockId).toBe("mint"))

    // The block finishes without outputs, which ends the walk.
    blockOutputs = { mint: { values: {} } }
    rerender()

    await waitFor(() => expect(result.current.detectionStatus).toBe("done"))
    expect(result.current.detectionWarning).toBe(WARNING)
  })

  it("validates a token the block marked sensitive with its real value", async () => {
    blockOutputs = { mint: { values: { GITHUB_TOKEN: sensitiveOutput("ghp_abc") } } }
    const testApi = installApi({
      "github:validate": () => {
        return {
          valid: true,
          user: { login: "octocat" },
          tokenType: "classic_pat",
          scopes: ["repo"],
          validatedVia: "direct",
        }
      },
    })

    const { result } = renderGitAuth({
      id: "gh",
      provider: PROVIDERS.github,
      detectCredentials: [{ block: "mint" }],
    })

    await waitFor(() => expect(result.current.authStatus).toBe("authenticated"))
    expect(result.current.detectionSource).toBe("block")
    expect(testApi.invoke).toHaveBeenCalledWith(
      "github:validate",
      expect.objectContaining({ token: "ghp_abc" }),
    )
  })

  // GitAuth reads the real token and must publish it sensitive again, or a
  // template showing {{ .outputs.gh.GITHUB_TOKEN }} would show the secret.
  it.each([
    ["a plain", "ghp_abc"],
    ["a sensitive", sensitiveOutput("ghp_abc")],
  ])("publishes %s block token as a sensitive output", async (_label, token) => {
    blockOutputs = { mint: { values: { GITHUB_TOKEN: token } } }
    installApi({
      "github:validate": () => {
        return {
          valid: true,
          user: { login: "octocat" },
          tokenType: "classic_pat",
          scopes: ["repo"],
          validatedVia: "direct",
        }
      },
    })

    const { result } = renderGitAuth({
      id: "gh",
      provider: PROVIDERS.github,
      detectCredentials: [{ block: "mint" }],
    })

    await waitFor(() => expect(result.current.authStatus).toBe("authenticated"))
    const [, published] = registerOutputs.mock.calls.at(-1) as [string, OutputValues]
    expect(published).toEqual(
      expect.objectContaining({
        GITHUB_TOKEN: sensitiveOutput("ghp_abc"),
        __AUTHENTICATED: "true",
      }),
    )
    expect(JSON.stringify(published)).not.toContain("ghp_abc")
  })

  it("shows the CLI hint and downgrade while it waits on a later block", async () => {
    const KEYRING_COPY = "gh stores this token in the OS keyring but could not read it."
    installApi({
      "github:cli-credentials": () => {
        return { found: false, outcome: "absent", hint: KEYRING_COPY }
      },
    })

    const { result } = renderGitAuth({
      id: "gh",
      provider: PROVIDERS.github,
      detectCredentials: ["cli", { block: "mint" }],
    })

    await waitFor(() => expect(result.current.waitingForBlockId).toBe("mint"))
    expect(result.current.detectionStatus).toBe("pending")
    expect(result.current.manualHint).toBe(KEYRING_COPY)
    expect(result.current.downgradedHosts.has("github.com")).toBe(true)
  })

  it("warns about a block token that lacks the repo scope", async () => {
    blockOutputs = { mint: { values: { GITHUB_TOKEN: "ghp_abc" } } }
    installApi({
      "github:validate": () => {
        return {
          valid: true,
          user: { login: "octocat" },
          tokenType: "classic_pat",
          scopes: ["read:org"],
          validatedVia: "direct",
        }
      },
    })

    const { result } = renderGitAuth({
      id: "gh",
      provider: PROVIDERS.github,
      detectCredentials: [{ block: "mint" }],
    })

    await waitFor(() => expect(result.current.authStatus).toBe("authenticated"))
    expect(result.current.detectionSource).toBe("block")
    expect(result.current.detectedScopes).toEqual(["read:org"])
    expect(result.current.detectedTokenType).toBe("classic_pat")
    expect(result.current.successMeta).toEqual({ validatedVia: "direct" })
    expect(result.current.missingScope).toBe(true)
  })
})

// A GitHub → GitLab switch while a GitHub token is still being validated. The
// stale validation must not sign the GitLab card in or publish GitHub outputs
// over the GIT_PROVIDER the switch wrote: an `*AuthId` step would run with
// the GitHub token.
describe("useGitAuth — provider switch mid-validation", () => {
  const GITHUB_USER = {
    valid: true,
    user: { login: "octocat" },
    tokenType: "classic_pat",
    scopes: ["repo"],
  }

  function renderSwitchable(options: Options) {
    return renderHook((props: Options) => useGitAuth(props), { wrapper, initialProps: options })
  }

  /** GitAuth.tsx's handleSelectProvider, at the hook level. */
  function switchToGitLab(
    { result, rerender }: ReturnType<typeof renderSwitchable>,
    options: Options,
  ) {
    act(() => {
      result.current.cancelOAuth()
      result.current.clearRegisteredOutputs("gitlab")
      result.current.resetAuth()
      result.current.resetDetectionState()
    })
    rerender({ ...options, provider: PROVIDERS.gitlab })
  }

  /** Every github:validate stays in flight until the test settles it. */
  function installDeferredValidate() {
    const testApi = installApi({})
    const validations = testApi.hold("github:validate")
    return { testApi, validations }
  }

  const expectSignedOutOnGitLab = (result: ReturnType<typeof renderSwitchable>["result"]) => {
    expect(result.current.authStatus).toBe("pending")
    expect(result.current.userInfo).toBeNull()
    expect(result.current.detectionSource).toBeNull()
    // The switch's GIT_PROVIDER is the only output ever published.
    expect(registerOutputs.mock.calls).toEqual([["gh", { GIT_PROVIDER: "gitlab" }]])
  }

  it("drops a {block} token validated by the detection walk", async () => {
    blockOutputs = { mint: { values: { GITHUB_TOKEN: "ghp_abc" } } }
    const { testApi, validations } = installDeferredValidate()
    const options: Options = {
      id: "gh",
      provider: PROVIDERS.github,
      detectCredentials: [{ block: "mint" }],
    }
    const hook = renderSwitchable(options)
    await waitFor(() =>
      expect(testApi.invoke).toHaveBeenCalledWith("github:validate", expect.anything()),
    )

    switchToGitLab(hook, options)
    await waitFor(() => expect(hook.result.current.detectionStatus).toBe("done"))
    await act(async () => {
      validations.at(-1)!.resolve(GITHUB_USER)
    })

    expectSignedOutOnGitLab(hook.result)
  })

  it("drops a {block} token validated after the walk resumed", async () => {
    const { testApi, validations } = installDeferredValidate()
    const options: Options = {
      id: "gh",
      provider: PROVIDERS.github,
      detectCredentials: [{ block: "mint" }],
    }
    const hook = renderSwitchable(options)
    await waitFor(() => expect(hook.result.current.waitingForBlockId).toBe("mint"))

    blockOutputs = { mint: { values: { GITHUB_TOKEN: "ghp_abc" } } }
    hook.rerender(options)
    await waitFor(() =>
      expect(testApi.invoke).toHaveBeenCalledWith("github:validate", expect.anything()),
    )

    switchToGitLab(hook, options)
    await waitFor(() => expect(hook.result.current.detectionStatus).toBe("done"))
    await act(async () => {
      validations.at(-1)!.resolve(GITHUB_USER)
    })

    expectSignedOutOnGitLab(hook.result)
  })

  it("drops the warning of a walk whose env check was in flight", async () => {
    const testApi = installApi({})
    const envChecks = testApi.hold("github:env-credentials")
    const options: Options = { id: "gh", provider: PROVIDERS.github, detectCredentials: ["env"] }
    const hook = renderSwitchable(options)
    await waitFor(() =>
      expect(testApi.invoke).toHaveBeenCalledWith("github:env-credentials", expect.anything()),
    )

    switchToGitLab(hook, options)
    await waitFor(() => expect(hook.result.current.detectionStatus).toBe("done"))
    await act(async () => {
      envChecks.at(-1)!.resolve({
        found: true,
        valid: false,
        outcome: "invalid",
        envVar: "GITHUB_TOKEN",
        warning: "GITHUB_TOKEN is not valid for github.com",
      })
    })

    expect(hook.result.current.detectionWarning).toBeNull()
    expectSignedOutOnGitLab(hook.result)
  })

  it("drops a PAT validated after the switch", async () => {
    const { testApi, validations } = installDeferredValidate()
    const options: Options = { id: "gh", provider: PROVIDERS.github, detectCredentials: false }
    const hook = renderSwitchable(options)

    act(() => hook.result.current.setPatToken("ghp_abc"))
    let submitted: Promise<void> = Promise.resolve()
    act(() => {
      submitted = hook.result.current.handlePatSubmit()
    })
    await waitFor(() =>
      expect(testApi.invoke).toHaveBeenCalledWith("github:validate", expect.anything()),
    )

    switchToGitLab(hook, options)
    await act(async () => {
      validations.at(-1)!.resolve(GITHUB_USER)
      await submitted
    })

    expectSignedOutOnGitLab(hook.result)
  })
})

// A host pick, Reload or Check again sends the card back through detection.
// Whatever the card held or was signing in with belongs to what it just left,
// so none of it may stay published or land afterwards: an `*AuthId` step
// would run with the wrong instance's credential.
describe("useGitAuth — re-detection drops the previous credential", () => {
  const HOSTS: Result<"gitlab:enumerate-hosts"> = {
    hosts: [
      { host: "gitlab.com", sources: ["glab"], hasCredential: true },
      { host: "git.corp.example", sources: ["recent"], hasCredential: false },
    ],
    defaultHost: "gitlab.com",
  }
  const TANUKI: Result<"gitlab:env-credentials"> = {
    found: true,
    valid: true,
    user: { login: "tanuki" },
    host: "gitlab.com",
    envVar: "GITLAB_TOKEN",
  }

  it("a host pick on an authenticated card withdraws its outputs, and nothing is found on the new host", async () => {
    installApi({
      "gitlab:enumerate-hosts": () => HOSTS,
      "gitlab:env-credentials": (args) => {
        return args.host === "gitlab.com" ? TANUKI : { found: false }
      },
    })
    const { result } = renderGitAuth({ id: "git", provider: PROVIDERS.gitlab })
    await waitFor(() => expect(result.current.authStatus).toBe("authenticated"))
    expect(registerOutputs).toHaveBeenLastCalledWith(
      "git",
      expect.objectContaining({ __AUTHENTICATED: "true" }),
    )
    registerOutputs.mockClear()

    act(() => result.current.handleHostSelect("git.corp.example"))

    // Withdrawn before detection on the new host starts ("Checking…").
    expect(result.current.detectionStatus).toBe("pending")
    expect(registerOutputs).toHaveBeenLastCalledWith("git", { GIT_PROVIDER: "gitlab" })

    await waitFor(() => expect(result.current.detectionStatus).toBe("done"))
    expect(result.current.authStatus).toBe("pending")
    expect(result.current.selectedHost).toBe("git.corp.example")
    expect(registerOutputs.mock.calls).toEqual([["git", { GIT_PROVIDER: "gitlab" }]])
  })

  it("Reload on an authenticated card withdraws its outputs until detection signs back in", async () => {
    let envCalls = 0
    const second: { resolve: (value: Result<"gitlab:env-credentials">) => void } = {
      resolve: () => {},
    }
    installApi({
      "gitlab:enumerate-hosts": () => HOSTS,
      "gitlab:env-credentials": () => {
        return ++envCalls === 1
          ? TANUKI
          : new Promise((resolve) => {
              second.resolve = resolve
            })
      },
    })
    const { result } = renderGitAuth({ id: "git", provider: PROVIDERS.gitlab })
    await waitFor(() => expect(result.current.authStatus).toBe("authenticated"))

    act(() => result.current.reloadDetection())

    expect(registerOutputs).toHaveBeenLastCalledWith("git", { GIT_PROVIDER: "gitlab" })
    await waitFor(() => expect(envCalls).toBe(2))
    // Still checking: the old credential stays withdrawn.
    expect(result.current.detectionStatus).toBe("pending")
    expect(registerOutputs).toHaveBeenLastCalledWith("git", { GIT_PROVIDER: "gitlab" })

    await act(async () => {
      second.resolve(TANUKI)
    })

    await waitFor(() => expect(result.current.authStatus).toBe("authenticated"))
    expect(registerOutputs).toHaveBeenLastCalledWith("git", {
      GITLAB_USER: "tanuki",
      GITLAB_HOST: "gitlab.com",
      GIT_PROVIDER: "gitlab",
      __AUTHENTICATED: "true",
    })
  })

  it.each([
    [
      "a host pick",
      (auth: ReturnType<typeof useGitAuth>) => auth.handleHostSelect("git.corp.example"),
    ],
    ["Reload", (auth: ReturnType<typeof useGitAuth>) => auth.reloadDetection()],
  ])("drops a PAT validated after %s", async (_label, redetect) => {
    const testApi = installApi({
      "gitlab:enumerate-hosts": () => HOSTS,
    })
    const validations = testApi.hold("gitlab:validate")
    const { result } = renderGitAuth({ id: "git", provider: PROVIDERS.gitlab })
    await waitFor(() => expect(result.current.detectionStatus).toBe("done"))

    act(() => result.current.setPatToken("glpat-old"))
    let submitted: Promise<void> = Promise.resolve()
    act(() => {
      submitted = result.current.handlePatSubmit()
    })
    await waitFor(() =>
      expect(testApi.invoke).toHaveBeenCalledWith("gitlab:validate", expect.anything()),
    )
    expect(result.current.authStatus).toBe("authenticating")

    act(() => redetect(result.current))
    await waitFor(() => expect(result.current.detectionStatus).toBe("done"))
    await act(async () => {
      validations.at(-1)!.resolve({ valid: true, user: { login: "tanuki" }, tokenType: "pat" })
      await submitted
    })

    expect(result.current.authStatus).toBe("pending")
    expect(result.current.userInfo).toBeNull()
    expect(registerOutputs).not.toHaveBeenCalled()
  })

  it("Check again ends a device flow in progress", async () => {
    const testApi = installApi({
      "github:oauth-start": () => {
        return {
          deviceCode: "dev123",
          userCode: "ABCD-1234",
          verificationUri: "https://github.com/login/device",
          interval: 5,
          expiresIn: 900,
        }
      },
    })
    const polls = testApi.hold("github:oauth-poll")
    const { result } = renderGitAuth({ id: "gh", provider: PROVIDERS.github })
    await waitFor(() => expect(result.current.detectionStatus).toBe("done"))

    await act(async () => {
      await result.current.startOAuth()
    })
    expect(testApi.invoke).toHaveBeenCalledWith("github:oauth-poll", expect.anything())

    act(() => result.current.retryUnreachable())
    await waitFor(() => expect(result.current.detectionStatus).toBe("done"))
    await act(async () => {
      polls.at(-1)!.resolve({
        status: "complete",
        user: { login: "octocat" },
        tokenType: "oauth",
        scopes: ["repo"],
      })
    })

    expect(result.current.authStatus).toBe("pending")
    expect(result.current.userInfo).toBeNull()
    expect(result.current.oauthUserCode).toBeNull()
    expect(registerOutputs).not.toHaveBeenCalled()
  })
})

describe("useGitAuth — success details", () => {
  it("keeps the token type of a CLI-detected token", async () => {
    installApi({
      "github:cli-credentials": () => {
        return { found: true, user: { login: "my-app[bot]" }, tokenType: "github_app" }
      },
    })

    const { result } = renderGitAuth({ id: "gh", provider: PROVIDERS.github })

    await waitFor(() => expect(result.current.authStatus).toBe("authenticated"))
    expect(result.current.detectionSource).toBe("cli")
    expect(result.current.detectedTokenType).toBe("github_app")
  })

  it("names the variable and the transport of a prefixed env token", async () => {
    const DIVERGENCE = "PROD_GH_TOKEN is also set and differs; Runbooks used PROD_GITHUB_TOKEN."
    const testApi = installApi({
      "github:env-credentials": () => {
        return {
          found: true,
          valid: true,
          user: { login: "octocat" },
          tokenType: "fine_grained_pat",
          envVar: "PROD_GITHUB_TOKEN",
          validatedVia: "cli",
          divergenceHint: DIVERGENCE,
        }
      },
    })

    const { result } = renderGitAuth({
      id: "gh",
      provider: PROVIDERS.github,
      detectCredentials: [{ env: { prefix: "PROD_" } }],
    })

    await waitFor(() => expect(result.current.authStatus).toBe("authenticated"))
    expect(testApi.invoke).toHaveBeenCalledWith(
      "github:env-credentials",
      expect.objectContaining({ prefix: "PROD_" }),
    )
    expect(result.current.successMeta).toEqual({
      source: "env",
      envVar: "PROD_GITHUB_TOKEN",
      validatedVia: "cli",
    })
    expect(result.current.divergenceHint).toBe(DIVERGENCE)
    expect(result.current.detectedTokenType).toBe("fine_grained_pat")
  })
})

describe("useGitAuth — GitHub Enterprise hosts", () => {
  const GH_HOSTS: Result<"github:enumerate-hosts"> = {
    hosts: [
      { host: "github.com", sources: [], hasCredential: false },
      { host: "ghes.corp", sources: ["gh"], hasCredential: true },
    ],
    defaultHost: "ghes.corp",
  }

  it("enumerates gh hosts and sends the default host on every detection invoke", async () => {
    const testApi = installApi({
      "github:enumerate-hosts": () => GH_HOSTS,
      "github:cli-credentials": () => {
        return { found: true, valid: true, user: { login: "mona" }, host: "ghes.corp" }
      },
    })

    const { result } = renderGitAuth({ id: "gh", provider: PROVIDERS.github })

    await waitFor(() => expect(result.current.authStatus).toBe("authenticated"))
    expect(testApi.invoke).toHaveBeenCalledWith("github:enumerate-hosts", {})
    expect(testApi.invoke).toHaveBeenCalledWith(
      "github:env-credentials",
      expect.objectContaining({ host: "ghes.corp" }),
    )
    expect(testApi.invoke).toHaveBeenCalledWith("github:cli-credentials", { host: "ghes.corp" })
    expect(result.current.selectedHost).toBe("ghes.corp")
    // The authenticated host is a block output (GitClone builds URLs from it).
    expect(registerOutputs).toHaveBeenCalledWith(
      "gh",
      expect.objectContaining({ GITHUB_HOST: "ghes.corp" }),
    )
    // Never a gitlab channel.
    expect(testApi.calls.some(({ channel }) => channel.startsWith("gitlab:"))).toBe(false)
  })

  it("an explicit host pick is persisted via github:host-picked and re-detects", async () => {
    const testApi = installApi({
      "github:enumerate-hosts": () => ({ ...GH_HOSTS, defaultHost: "github.com" }),
      "github:host-picked": () => ({ ok: true }),
    })

    const { result } = renderGitAuth({ id: "gh", provider: PROVIDERS.github })
    await waitFor(() => expect(result.current.detectionStatus).toBe("done"))
    expect(testApi.invoke).toHaveBeenCalledWith("github:cli-credentials", { host: "github.com" })

    act(() => result.current.handleHostSelect("ghes.corp"))

    await waitFor(() => {
      expect(testApi.invoke).toHaveBeenCalledWith("github:host-picked", { host: "ghes.corp" })
      expect(testApi.invoke).toHaveBeenCalledWith("github:cli-credentials", { host: "ghes.corp" })
    })
    expect(testApi.calls.some(({ channel }) => channel === "gitlab:host-picked")).toBe(false)
    expect(result.current.selectedHost).toBe("ghes.corp")
  })

  it("an authored host pins (and normalizes) the host without enumerating", async () => {
    const testApi = installApi({
      "github:validate": () => ({
        valid: true,
        user: { login: "mona" },
        tokenType: "classic_pat",
        scopes: ["repo"],
      }),
    })

    const { result } = renderGitAuth({
      id: "gh",
      provider: PROVIDERS.github,
      host: "https://GHES.corp/",
      detectCredentials: false,
    })

    act(() => result.current.setPatToken("ghp_abc"))
    await act(async () => {
      await result.current.handlePatSubmit()
    })

    expect(testApi.invoke).toHaveBeenCalledWith("github:validate", {
      token: "ghp_abc",
      host: "ghes.corp",
      registerSession: true,
    })
    expect(testApi.invoke).not.toHaveBeenCalledWith("github:enumerate-hosts", expect.anything())
    expect(result.current.hostSelectable).toBe(false)
    expect(registerOutputs).toHaveBeenCalledWith(
      "gh",
      expect.objectContaining({ GITHUB_HOST: "ghes.corp" }),
    )
  })

  it("disables OAuth for an enterprise host without a client ID (string prop targets github.com only)", async () => {
    installApi({})

    const { result } = renderGitAuth({
      id: "gh",
      provider: PROVIDERS.github,
      host: "ghes.corp",
      oauthClientId: undefined,
    })

    expect(result.current.effectiveClientId).toBeUndefined()
    expect(result.current.oauthUnavailableReason).toMatch(/isn't set up for ghes\.corp/)
    expect(result.current.oauthUnavailableReason).toContain("gh auth login --hostname ghes.corp")
    await waitFor(() => expect(result.current.detectionStatus).toBe("done"))
  })

  it("with detection off, points an enterprise host without a client ID at a token only, not gh auth login", async () => {
    installApi({})

    const { result } = renderGitAuth({
      id: "gh",
      provider: PROVIDERS.github,
      host: "ghes.corp",
      detectCredentials: false,
    })

    expect(result.current.oauthUnavailableReason).toBe(
      "Sign-in with GitHub isn't set up for ghes.corp. Use a personal access token instead.",
    )
    await waitFor(() => expect(result.current.cliStatus).not.toBeNull())
  })

  it("never applies an unscoped string client ID to a picked enterprise host", async () => {
    installApi({
      "github:enumerate-hosts": () => GH_HOSTS,
    })

    const { result } = renderGitAuth({
      id: "gh",
      provider: PROVIDERS.github,
      oauthClientId: "Iv1.dotcom",
    })

    await waitFor(() => expect(result.current.selectedHost).toBe("ghes.corp"))
    expect(result.current.effectiveClientId).toBeUndefined()
    expect(result.current.oauthUnavailableReason).toMatch(/ghes\.corp/)
  })

  it("resolves a client-ID map by host and sends host + clientId on oauth-start/poll", async () => {
    vi.useFakeTimers()
    try {
      const testApi = installApi({
        "github:oauth-start": () => {
          return {
            deviceCode: "dev",
            userCode: "ABCD-1234",
            verificationUri: "https://ghes.corp/login/device",
            interval: 0,
          }
        },
        "github:oauth-poll": () => ({ status: "complete", user: { login: "mona" } }),
      })

      const { result } = renderGitAuth({
        id: "gh",
        provider: PROVIDERS.github,
        host: "ghes.corp",
        oauthClientId: { "https://GHES.corp": "Iv1.ghes", "github.com": "Iv1.dotcom" },
        detectCredentials: false,
      })

      expect(result.current.effectiveClientId).toBe("Iv1.ghes")
      expect(result.current.oauthUnavailableReason).toBeNull()
      // No "use the default app" warning — there is no default on an enterprise host.
      expect(result.current.isCustomClientId).toBe(false)

      await act(async () => {
        await result.current.startOAuth()
        await vi.runOnlyPendingTimersAsync()
      })

      expect(testApi.invoke).toHaveBeenCalledWith("github:oauth-start", {
        clientId: "Iv1.ghes",
        scopes: ["repo"],
        host: "ghes.corp",
      })
      expect(testApi.invoke).toHaveBeenCalledWith("github:oauth-poll", {
        clientId: "Iv1.ghes",
        deviceCode: "dev",
        host: "ghes.corp",
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("github.com keeps OAuth on the main default and sends host github.com", async () => {
    const testApi = installApi({
      "github:oauth-start": () => {
        throw new Error("stop here")
      },
    })

    const { result } = renderGitAuth({
      id: "gh",
      provider: PROVIDERS.github,
      detectCredentials: false,
    })

    expect(result.current.oauthUnavailableReason).toBeNull()
    await act(async () => {
      await result.current.startOAuth()
    })
    expect(testApi.invoke).toHaveBeenCalledWith("github:oauth-start", {
      scopes: ["repo"],
      host: "github.com",
    })
  })
})
