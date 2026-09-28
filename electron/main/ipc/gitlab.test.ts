/**
 * IPC contract tests for the gitlab:* handlers: where an auto-detected
 * credential may be sent.
 *
 * The handlers run against the REAL main-process stack — runtime.ts (AppLive),
 * vcs-tristate.ts, VcsCredentialsLive, GitLabHttpClient, recent-hosts.ts —
 * with the true boundaries replaced: `electron` (ipcMain capture +
 * app.getPath → a temp userData dir), global `fetch`, process.env, and the two
 * main-process modules the handlers pull in only for TLS recovery / window
 * broadcasts (index.ts, window.ts). Mirrors github.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, mock } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"
import { Effect } from "effect"
import { mockElectron } from "../test-utils/mock-electron.ts"

// ---------------------------------------------------------------------------
// Boundary mocks (must be registered before the handler module is imported)
// ---------------------------------------------------------------------------

type Handler = (event: unknown, params?: unknown) => unknown
const handlers = new Map<string, Handler>()
let userDataDir = ""

mockElectron({
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
})
// Same export names as github.test.ts's mock of this module (bun fixes a
// mocked module's export names on the first mock.module call).
mock.module("../index.ts", () => ({
  refreshSystemTrust: async () => ({ coldReadOk: true }),
  registerExtraCaPems: () => {},
}))
mock.module("../window.ts", () => ({
  getMainWindow: () => null,
}))

const { registerGitLabHandlers } = await import("./gitlab.ts")
const { sessionManager, vcsSessionMeta } = await import("./runtime.ts")
const { makeTestEnvironment } = await import("../../../src/test-utils/TestEnvironment.ts")

registerGitLabHandlers()

const invoke = (channel: string, params?: unknown) => {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return Promise.resolve(handler({}, params)) as Promise<any>
}

// ---------------------------------------------------------------------------
// fetch + env + session fixtures
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch
let fetchCalls: Array<{ url: string; authorization?: string }> = []

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })

/** Answers GitLab's /user and PAT introspection on any host. */
const mockGitLab = () => {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const headers = (init?.headers ?? {}) as Record<string, string>
    fetchCalls.push({ url, authorization: headers.Authorization ?? headers["PRIVATE-TOKEN"] })
    if (url.endsWith("/api/v4/user")) return Promise.resolve(json({ username: "tanuki" }))
    if (url.endsWith("/personal_access_tokens/self")) return Promise.resolve(json({ scopes: ["api"] }))
    return Promise.resolve(new Response("not found", { status: 404 }))
  }) as typeof fetch
}

/** Env vars the handlers read from process.env; saved and cleared per test. */
const ENV_KEYS = [
  "GITLAB_TOKEN",
  "GITLAB_ACCESS_TOKEN",
  "OAUTH_TOKEN",
  "GITLAB_HOST",
  "GITLAB_URI",
  "GL_HOST",
  "CI_GITLAB_TOKEN",
  "CI_GITLAB_ACCESS_TOKEN",
  "CI_GITLAB_HOST",
  "CI_GITLAB_URI",
  "CI_GL_HOST",
  "GLAB_CONFIG_DIR",
]
const savedEnv: Record<string, string | undefined> = {}
let glabConfigDir = ""

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
  userDataDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "runbooks-gitlab-ipc-"))
  glabConfigDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "runbooks-glab-config-"))
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.GLAB_CONFIG_DIR = glabConfigDir
  fetchCalls = []
  mockGitLab()
  vcsSessionMeta.clear()
  await Effect.runPromise(sessionManager.createSession("/tmp").pipe(Effect.provide(makeTestEnvironment({}))))
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vcsSessionMeta.clear()
  sessionManager.deleteSession()
  fs.rmSync(userDataDir, { recursive: true, force: true })
  fs.rmSync(glabConfigDir, { recursive: true, force: true })
})

const sessionEnv = async () => Object.fromEntries((await Effect.runPromise(sessionManager.getSession())).env)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("gitlab:env-credentials — never over plain http", () => {
  it("an http:// instance for the bound host is absent: no request, no session write (prefixed or not)", async () => {
    process.env.GITLAB_TOKEN = "glpat-env"
    process.env.CI_GITLAB_TOKEN = "glpat-ci"
    const plain = await invoke("gitlab:env-credentials", { instanceUrl: "http://gitlab.com" })
    const prefixed = await invoke("gitlab:env-credentials", { instanceUrl: "http://gitlab.com", prefix: "CI_" })
    expect(plain.found).toBe(false)
    expect(prefixed.found).toBe(false)
    expect(fetchCalls).toHaveLength(0)
    expect((await sessionEnv()).GITLAB_TOKEN).toBeUndefined()
  })

  it("https (explicit or a bare host) is unchanged", async () => {
    process.env.GITLAB_TOKEN = "glpat-env"
    process.env.CI_GITLAB_TOKEN = "glpat-ci"
    const plain = await invoke("gitlab:env-credentials", { instanceUrl: "https://gitlab.com" })
    const prefixed = await invoke("gitlab:env-credentials", { host: "gitlab.com", prefix: "CI_" })
    expect([plain.valid, prefixed.valid]).toEqual([true, true])
    expect(fetchCalls.filter((c) => c.url.endsWith("/user")).map((c) => [c.url, c.authorization])).toEqual([
      ["https://gitlab.com/api/v4/user", "Bearer glpat-env"],
      ["https://gitlab.com/api/v4/user", "Bearer glpat-ci"],
    ])
  })
})

describe("gitlab:validate", () => {
  it("a manually entered token still validates against an http:// instance", async () => {
    const result = await invoke("gitlab:validate", { token: "glpat-manual", instanceUrl: "http://git.corp.example" })
    expect(result.valid).toBe(true)
    expect(fetchCalls.filter((c) => c.url.endsWith("/user")).map((c) => c.url)).toEqual([
      "http://git.corp.example/api/v4/user",
    ])
  })

  it("useSessionToken sends the session credential only to its own host, over https", async () => {
    // Block A: the env token authenticates gitlab.com and lands in the session.
    process.env.GITLAB_TOKEN = "glpat-env"
    expect((await invoke("gitlab:env-credentials", { host: "gitlab.com" })).valid).toBe(true)
    expect((await sessionEnv()).GITLAB_HOST).toBe("gitlab.com")
    fetchCalls = []

    // Block B chains to A but targets plain http, or another host: refused
    // without any request.
    const http = await invoke("gitlab:validate", { useSessionToken: true, instanceUrl: "http://gitlab.com" })
    const other = await invoke("gitlab:validate", { useSessionToken: true, instanceUrl: "https://evil.example" })
    expect([http.valid, other.valid]).toEqual([false, false])
    expect(fetchCalls).toHaveLength(0)

    const same = await invoke("gitlab:validate", { useSessionToken: true, host: "gitlab.com" })
    expect(same.valid).toBe(true)
    expect(fetchCalls.filter((c) => c.url.endsWith("/user")).map((c) => [c.url, c.authorization])).toEqual([
      ["https://gitlab.com/api/v4/user", "Bearer glpat-env"],
    ])
  })
})
