/**
 * IPC contract tests for the github:* handlers (GitHub Enterprise support).
 *
 * The handlers run against the REAL main-process stack — runtime.ts (AppLive),
 * vcs-tristate.ts, VcsCredentialsLive, GitHubHttpClient, recent-hosts.ts —
 * with the true boundaries replaced: `electron` (ipcMain capture +
 * app.getPath → a temp userData dir), global `fetch`, process.env / the gh
 * config dir, and the two main-process modules vcs-tristate pulls in only
 * for TLS recovery / window broadcasts (index.ts, window.ts).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, mock } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"
import { Effect } from "effect"

// ---------------------------------------------------------------------------
// Boundary mocks (must be registered before the handler module is imported)
// ---------------------------------------------------------------------------

type Handler = (event: unknown, params?: unknown) => unknown
const handlers = new Map<string, Handler>()
let userDataDir = ""
let exposedApi: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> } | undefined
const rendererInvokes: string[] = []

mock.module("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn)
    },
  },
  app: {
    getPath: (name: string) => {
      if (name === "userData") return userDataDir
      throw new Error(`unexpected app.getPath(${name})`)
    },
  },
  contextBridge: {
    exposeInMainWorld: (_key: string, api: typeof exposedApi) => {
      exposedApi = api
    },
  },
  ipcRenderer: {
    invoke: (channel: string) => {
      rendererInvokes.push(channel)
      return Promise.resolve({ ok: true })
    },
    on: () => {},
    once: () => {},
    removeListener: () => {},
  },
}))
mock.module("../index.ts", () => ({
  refreshSystemTrust: async () => ({ coldReadOk: true }),
}))
mock.module("../window.ts", () => ({
  getMainWindow: () => null,
}))

const { registerGitHubHandlers, resolveRequestedGitHubHost } = await import("./github.ts")
const { sessionManager, vcsSessionMeta } = await import("./runtime.ts")
const { makeTestEnvironment } = await import("../../../src/test-utils/TestEnvironment.ts")
const { DEFAULT_GITHUB_OAUTH_CLIENT_ID } = await import("../../../src/domain/github/auth.ts")

registerGitHubHandlers()

const invoke = (channel: string, params?: unknown) => {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return Promise.resolve(handler({}, params)) as Promise<any>
}

// ---------------------------------------------------------------------------
// fetch + env + session fixtures
// ---------------------------------------------------------------------------

const GHES = "ghes.example.com"
const GHEC = "acme.ghe.com"

const originalFetch = globalThis.fetch
let fetchCalls: Array<{ url: string; method: string; body?: string; authorization?: string }> = []

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json", ...headers } })

const mockFetch = (respond: (url: string) => Response) => {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    fetchCalls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
      authorization: headers.Authorization,
    })
    return Promise.resolve(respond(String(input)))
  }) as typeof fetch
}

/** Answers GitHub's /user and the device-flow endpoints on any host. */
const githubResponder = (url: string): Response => {
  if (url.endsWith("/login/device/code")) {
    return json({ device_code: "dc", user_code: "UC-123", verification_uri: "https://x/login/device", interval: 5 })
  }
  if (url.endsWith("/user")) return json({ login: "alice" }, { "X-OAuth-Scopes": "repo, read:org" })
  if (url.includes("/user/orgs")) return json([{ id: 1, login: "corp" }])
  return new Response("not found", { status: 404 })
}

/** Env vars the handlers read from process.env; saved and cleared per test. */
const ENV_KEYS = [
  "GH_HOST",
  "GH_CONFIG_DIR",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
]
const savedEnv: Record<string, string | undefined> = {}
let ghConfigDir = ""

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
})

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

beforeEach(async () => {
  userDataDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "runbooks-github-ipc-"))
  ghConfigDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "runbooks-gh-config-"))
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.GH_CONFIG_DIR = ghConfigDir
  fetchCalls = []
  mockFetch(githubResponder)
  vcsSessionMeta.clear()
  await Effect.runPromise(sessionManager.createSession("/tmp").pipe(Effect.provide(makeTestEnvironment({}))))
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vcsSessionMeta.clear()
  sessionManager.deleteSession()
  fs.rmSync(userDataDir, { recursive: true, force: true })
  fs.rmSync(ghConfigDir, { recursive: true, force: true })
})

const sessionEnv = async () => Object.fromEntries((await Effect.runPromise(sessionManager.getSession())).env)
const vcsAuthStore = () => {
  try {
    return JSON.parse(fs.readFileSync(nodePath.join(userDataDir, "vcs-auth.json"), "utf8"))
  } catch {
    return undefined
  }
}
const writeVcsAuthStore = (store: unknown) =>
  fs.writeFileSync(nodePath.join(userDataDir, "vcs-auth.json"), JSON.stringify(store))
const writeHostsYml = (content: string) => fs.writeFileSync(nodePath.join(ghConfigDir, "hosts.yml"), content)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveRequestedGitHubHost", () => {
  it("absent/blank → github.com", () => {
    expect(resolveRequestedGitHubHost(undefined)).toBe("github.com")
    expect(resolveRequestedGitHubHost(null)).toBe("github.com")
    expect(resolveRequestedGitHubHost("")).toBe("github.com")
    expect(resolveRequestedGitHubHost("   ")).toBe("github.com")
  })

  it("present → strict normalization", () => {
    expect(resolveRequestedGitHubHost("GHES.example.com")).toBe(GHES)
    expect(resolveRequestedGitHubHost(`https://${GHES}/o/r`)).toBe(GHES)
    expect(resolveRequestedGitHubHost("api.acme.ghe.com")).toBe(GHEC)
  })

  it("present but unparseable → undefined (refuse, never github.com)", () => {
    expect(resolveRequestedGitHubHost("ftp://ghes.example.com")).toBeUndefined()
    expect(resolveRequestedGitHubHost("https://u:p@ghes.example.com")).toBeUndefined()
    expect(resolveRequestedGitHubHost("not a host")).toBeUndefined()
  })
})

describe("github:oauth-start", () => {
  it("rejects for an enterprise host without a clientId and never calls the client", async () => {
    for (const host of [GHES, GHEC]) {
      await expect(invoke("github:oauth-start", { host })).rejects.toThrow(host)
    }
    expect(fetchCalls).toHaveLength(0)
  })

  it("rejects for an invalid host without any request", async () => {
    await expect(invoke("github:oauth-start", { host: "ftp://ghes.example.com", clientId: "x" })).rejects.toThrow(
      /Invalid GitHub host/,
    )
    expect(fetchCalls).toHaveLength(0)
  })

  it("with a clientId, starts the device flow on that host", async () => {
    const result = await invoke("github:oauth-start", { host: GHES, clientId: "Iv1.ghes" })
    expect(result.userCode).toBe("UC-123")
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toBe(`https://${GHES}/login/device/code`)
    expect(JSON.parse(fetchCalls[0].body!)).toEqual({ client_id: "Iv1.ghes", scope: "repo read:org" })
  })

  it("github.com (default host) uses the Gruntwork default client ID", async () => {
    await invoke("github:oauth-start", {})
    expect(fetchCalls[0].url).toBe("https://github.com/login/device/code")
    expect(JSON.parse(fetchCalls[0].body!).client_id).toBe(DEFAULT_GITHUB_OAUTH_CLIENT_ID)
  })
})

describe("github:oauth-poll", () => {
  it("fails for an enterprise host without a clientId and never calls the client", async () => {
    const result = await invoke("github:oauth-poll", { host: GHES, deviceCode: "dc" })
    expect(result.status).toBe("failed")
    expect(result.error).toContain(GHES)
    expect(fetchCalls).toHaveLength(0)
  })

  it("completes on the enterprise host and writes the host-bound session env", async () => {
    mockFetch((url) =>
      url.endsWith("/login/oauth/access_token") ? json({ access_token: "gho_ghes_oauth" }) : githubResponder(url),
    )
    const result = await invoke("github:oauth-poll", { host: GHES, clientId: "Iv1.ghes", deviceCode: "dc" })
    expect(result.status).toBe("complete")
    expect(JSON.stringify(result)).not.toContain("gho_ghes_oauth") // metadata only
    expect(fetchCalls.map((c) => c.url)).toEqual([
      `https://${GHES}/login/oauth/access_token`,
      `https://${GHES}/api/v3/user`,
    ])
    const env = await sessionEnv()
    expect(env.GITHUB_HOST).toBe(GHES)
    expect(env.GH_ENTERPRISE_TOKEN).toBe("gho_ghes_oauth")
  })
})

describe("github:validate", () => {
  it("GHES: validates on that host and writes GITHUB_TOKEN/GITHUB_HOST/GH_HOST/GH_ENTERPRISE_TOKEN", async () => {
    const result = await invoke("github:validate", { token: "ghp_pat", host: GHES, registerSession: true })
    expect(result.valid).toBe(true)
    expect(result.user.login).toBe("alice")
    expect(fetchCalls).toEqual([
      { url: `https://${GHES}/api/v3/user`, method: "GET", body: undefined, authorization: "Bearer ghp_pat" },
    ])
    const env = await sessionEnv()
    expect(env.GITHUB_TOKEN).toBe("ghp_pat")
    expect(env.GITHUB_USER).toBe("alice")
    expect(env.GITHUB_HOST).toBe(GHES)
    expect(env.GH_HOST).toBe(GHES)
    expect(env.GH_ENTERPRISE_TOKEN).toBe("ghp_pat")
    // main-only host binding recorded; host remembered for picker + CSP
    expect(vcsSessionMeta.get("github")?.host).toBe(GHES)
    expect(vcsAuthStore()).toMatchObject({ recentGitHubHosts: [GHES], lastSelectedGitHubHost: GHES })
  })

  it("ghe.com: API on api.<sub>.ghe.com; no GH_ENTERPRISE_TOKEN", async () => {
    await invoke("github:validate", { token: "ghp_pat", host: `https://${GHEC}/o/r`, registerSession: true })
    expect(fetchCalls[0].url).toBe(`https://api.${GHEC}/user`)
    const env = await sessionEnv()
    expect(env.GITHUB_HOST).toBe(GHEC)
    expect(env.GH_HOST).toBe(GHEC)
    expect(env.GH_ENTERPRISE_TOKEN).toBeUndefined()
  })

  it("github.com (no host): unchanged, not added to the enterprise recents", async () => {
    await invoke("github:validate", { token: "ghp_pat", registerSession: true })
    expect(fetchCalls[0].url).toBe("https://api.github.com/user")
    const env = await sessionEnv()
    expect(env.GITHUB_HOST).toBe("github.com")
    expect(env.GH_ENTERPRISE_TOKEN).toBeUndefined()
    expect(vcsAuthStore()).toMatchObject({ recentGitHubHosts: [], lastSelectedGitHubHost: "github.com" })
  })

  it("refuses an invalid host without any request or session write", async () => {
    const result = await invoke("github:validate", {
      token: "ghp_pat",
      host: "https://u:p@ghes.example.com",
      registerSession: true,
    })
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/Invalid GitHub host/)
    expect(fetchCalls).toHaveLength(0)
    expect((await sessionEnv()).GITHUB_TOKEN).toBeUndefined()
  })

  it("a failed validation carries the host", async () => {
    mockFetch(() => new Response("Bad credentials", { status: 401 }))
    const result = await invoke("github:validate", { token: "ghp_bad", host: GHES })
    expect(result.valid).toBe(false)
    expect(result.host).toBe(GHES)
  })

  // KNOWN GAP (reported): the design says detection/validation results carry
  // `host`, and the channel type has `host?`, but the SUCCESS branch of
  // github:validate omits it (only the failure branch, via
  // toValidationIpcResult, includes it). Drop `.failing` with the fix.
  it("a successful validation returns the host", async () => {
    const result = await invoke("github:validate", { token: "ghp_pat", host: GHES })
    expect(result.valid).toBe(true)
    expect(result.host).toBe(GHES)
  })

  it("useSessionToken validates the session credential FOR THAT HOST only", async () => {
    await invoke("github:validate", { token: "ghp_ghes", host: GHES, registerSession: true })
    fetchCalls = []
    const other = await invoke("github:validate", { host: "github.com", useSessionToken: true })
    expect(other.valid).toBe(false)
    expect(fetchCalls).toHaveLength(0) // the GHES token never goes to github.com
    const same = await invoke("github:validate", { host: GHES, useSessionToken: true })
    expect(same.valid).toBe(true)
    expect(fetchCalls.map((c) => [c.url, c.authorization])).toEqual([
      [`https://${GHES}/api/v3/user`, "Bearer ghp_ghes"],
    ])
  })
})

describe("github:env-credentials / github:cli-credentials", () => {
  it("env-credentials for GHES reads GH_ENTERPRISE_TOKEN bound by GH_HOST and returns host", async () => {
    process.env.GH_HOST = GHES
    process.env.GH_ENTERPRISE_TOKEN = "ghp_env_ent"
    process.env.GITHUB_TOKEN = "ghp_env_dotcom"
    const result = await invoke("github:env-credentials", { host: GHES })
    expect(result.found).toBe(true)
    expect(result.valid).toBe(true)
    expect(result.host).toBe(GHES)
    expect(result.envVar).toBe("GH_ENTERPRISE_TOKEN")
    expect(fetchCalls.map((c) => [c.url, c.authorization])).toEqual([
      [`https://${GHES}/api/v3/user`, "Bearer ghp_env_ent"],
    ])
    expect((await sessionEnv()).GH_ENTERPRISE_TOKEN).toBe("ghp_env_ent")
  })

  it("env-credentials for GHES without GH_HOST: absent, GITHUB_TOKEN never sent there", async () => {
    process.env.GITHUB_TOKEN = "ghp_env_dotcom"
    const result = await invoke("github:env-credentials", { host: GHES })
    expect(result.found).toBe(false)
    expect(fetchCalls).toHaveLength(0)
  })

  it("invalid host is refused on both detection channels", async () => {
    const env = await invoke("github:env-credentials", { host: "ftp://x" })
    const cli = await invoke("github:cli-credentials", { host: "ftp://x" })
    expect(env.error).toMatch(/Invalid GitHub host/)
    expect(cli.error).toMatch(/Invalid GitHub host/)
    expect(fetchCalls).toHaveLength(0)
  })
})

describe("github:orgs (session credential per host)", () => {
  it("uses the session credential for the requested host and calls that host's API", async () => {
    await invoke("github:validate", { token: "ghp_ghes", host: GHES, registerSession: true })
    fetchCalls = []
    const orgs = await invoke("github:orgs", { host: GHES })
    expect(orgs).toEqual([{ id: 1, login: "corp", name: undefined }])
    expect(fetchCalls[0].url).toBe(`https://${GHES}/api/v3/user/orgs?per_page=100&page=1`)
    expect(fetchCalls[0].authorization).toBe("Bearer ghp_ghes")
  })

  it("host omitted → the session's GitHub host", async () => {
    await invoke("github:validate", { token: "ghp_ghes", host: GHES, registerSession: true })
    fetchCalls = []
    await invoke("github:orgs")
    expect(fetchCalls[0].url.startsWith(`https://${GHES}/api/v3/`)).toBe(true)
  })

  it("a different host gets no token and no request", async () => {
    await invoke("github:validate", { token: "ghp_ghes", host: GHES, registerSession: true })
    fetchCalls = []
    await expect(invoke("github:orgs", { host: "github.com" })).rejects.toThrow(/No GitHub token for github.com/)
    expect(fetchCalls).toHaveLength(0)
  })
})

describe("github:host-picked", () => {
  it("persists the normalized host; ignores an invalid one", async () => {
    expect(await invoke("github:host-picked", { host: "https://GHES.example.com/" })).toEqual({ ok: true })
    expect(vcsAuthStore().lastSelectedGitHubHost).toBe(GHES)
    await invoke("github:host-picked", { host: "ftp://evil" })
    expect(vcsAuthStore().lastSelectedGitHubHost).toBe(GHES)
  })
})

describe("github:enumerate-hosts", () => {
  type HostEntry = { host: string; sources: string[]; hasCredential: boolean }
  const byHost = (result: { hosts: HostEntry[] }): Record<string, HostEntry> =>
    Object.fromEntries(result.hosts.map((h) => [h.host, h]))

  it("github.com is always present, even with nothing configured", async () => {
    const result = await invoke("github:enumerate-hosts", {})
    expect(result).toEqual({
      hosts: [{ host: "github.com", sources: [], hasCredential: false }],
      defaultHost: "github.com",
    })
  })

  it("merges hosts.yml, GH_HOST, the session host and recents — deduped with provenance", async () => {
    writeHostsYml(`github.com:\n    user: octocat\n    oauth_token: gho_x\nGHES.example.com:\n    user: alice\n`)
    process.env.GH_HOST = GHEC
    process.env.GITHUB_TOKEN = "ghp_tenant"
    vcsSessionMeta.set("github", { host: GHES })
    writeVcsAuthStore({ recentGitLabHosts: [], recentGitHubHosts: ["recent-ghes.example.com", GHES, "ftp://junk"] })

    const result = await invoke("github:enumerate-hosts", {})
    const hosts = byHost(result)
    expect(Object.keys(hosts).sort()).toEqual(["acme.ghe.com", "ghes.example.com", "github.com", "recent-ghes.example.com"])
    expect(hosts["github.com"].sources).toEqual(["gh"])
    expect(hosts[GHES].sources.sort()).toEqual(["gh", "recent", "session"])
    expect(hosts[GHEC].sources).toEqual(["env"])
    expect(hosts["recent-ghes.example.com"].sources).toEqual(["recent"])
    // offline credential check
    expect(hosts["github.com"].hasCredential).toBe(true) // hosts.yml token
    expect(hosts[GHES].hasCredential).toBe(true) // hosts.yml entry (keyring)
    expect(hosts[GHEC].hasCredential).toBe(true) // GITHUB_TOKEN bound by GH_HOST
    expect(hosts["recent-ghes.example.com"].hasCredential).toBe(false)
    // no persisted pick → GH_HOST
    expect(result.defaultHost).toBe(GHEC)
  })

  it("defaultHost: a persisted pick wins only while it still has a credential", async () => {
    writeHostsYml(`${GHES}:\n    user: alice\n`)
    process.env.GH_HOST = GHEC
    writeVcsAuthStore({ recentGitLabHosts: [], recentGitHubHosts: [], lastSelectedGitHubHost: GHES })
    expect((await invoke("github:enumerate-hosts", {})).defaultHost).toBe(GHES)

    // stale pick (no credential for it any more) → GH_HOST
    writeVcsAuthStore({ recentGitLabHosts: [], recentGitHubHosts: [], lastSelectedGitHubHost: "gone.example.com" })
    expect((await invoke("github:enumerate-hosts", {})).defaultHost).toBe(GHEC)

    // stale pick and no GH_HOST → github.com
    delete process.env.GH_HOST
    expect((await invoke("github:enumerate-hosts", {})).defaultHost).toBe("github.com")
  })

  it("GITHUB_TOKEN counts as a github.com credential only when not rebound by GH_HOST", async () => {
    process.env.GITHUB_TOKEN = "ghp_x"
    expect(byHost(await invoke("github:enumerate-hosts", {}))["github.com"].hasCredential).toBe(true)
    process.env.GH_HOST = GHEC
    expect(byHost(await invoke("github:enumerate-hosts", {}))["github.com"].hasCredential).toBe(false)
  })

  it("GH_ENTERPRISE_TOKEN marks only the GHES host GH_HOST names", async () => {
    process.env.GH_HOST = GHES
    process.env.GH_ENTERPRISE_TOKEN = "ghp_e"
    writeVcsAuthStore({ recentGitLabHosts: [], recentGitHubHosts: ["other-ghes.example.com"] })
    const hosts = byHost(await invoke("github:enumerate-hosts", {}))
    expect(hosts[GHES].hasCredential).toBe(true)
    expect(hosts["other-ghes.example.com"].hasCredential).toBe(false)
    expect(hosts["github.com"].hasCredential).toBe(false)
  })
})

describe("preload allowlist", () => {
  it("allows github:enumerate-hosts and github:host-picked", async () => {
    await import("../../preload/index.ts")
    expect(exposedApi).toBeDefined()
    await exposedApi!.invoke("github:enumerate-hosts", {})
    await exposedApi!.invoke("github:host-picked", { host: GHES })
    expect(rendererInvokes).toEqual(["github:enumerate-hosts", "github:host-picked"])
    await expect(exposedApi!.invoke("github:not-a-channel")).rejects.toThrow(/Blocked IPC invoke/)
  })
})
