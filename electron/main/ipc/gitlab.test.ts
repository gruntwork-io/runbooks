/**
 * IPC contract tests for the gitlab:* handlers: where an auto-detected
 * credential, or the session's token, may be sent.
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

/** Answers GitLab's /user, PAT introspection and project labels on any host. */
const mockGitLab = () => {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const headers = (init?.headers ?? {}) as Record<string, string>
    fetchCalls.push({ url, authorization: headers.Authorization ?? headers["PRIVATE-TOKEN"] })
    if (url.endsWith("/api/v4/user")) return Promise.resolve(json({ username: "tanuki" }))
    if (url.endsWith("/personal_access_tokens/self")) return Promise.resolve(json({ scopes: ["api"] }))
    if (new URL(url).pathname.endsWith("/labels")) return Promise.resolve(json([{ name: "bug" }]))
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

describe("gitlab:labels — which instance the session's token is sent to", () => {
  const SECRET = "glpat-SECRETTOKEN"
  const labels = (params: { owner: string; repo: string; host?: string }) =>
    invoke("gitlab:labels", params) as Promise<{ labels: string[] }>

  beforeEach(async () => {
    // The token is bound to the custom-port instance the repo lives on.
    await Effect.runPromise(sessionManager.appendToEnv({ GITLAB_TOKEN: SECRET, GITLAB_HOST: "gitlab.corp:8443" }))
  })

  it("reads labels from the repo's own instance", async () => {
    const result = await labels({ owner: "acme", repo: "infra", host: "gitlab.corp:8443" })

    expect(result.labels).toEqual(["bug"])
    expect(fetchCalls.map((c) => c.url)).toEqual([
      "https://gitlab.corp:8443/api/v4/projects/acme%2Finfra/labels?include_ancestor_groups=true&per_page=100&page=1",
    ])
    expect(fetchCalls[0]?.authorization).toBe(`Bearer ${SECRET}`)
  })

  it("falls back to the instance the token is bound to when the renderer names none", async () => {
    await labels({ owner: "acme", repo: "infra" })

    expect(fetchCalls.length).toBeGreaterThan(0)
    expect(fetchCalls.every((c) => c.url.startsWith("https://gitlab.corp:8443/"))).toBe(true)
  })

  // The port is part of the binding: gitlab.corp:8443's token is not
  // gitlab.corp's (443) or another port's.
  it.each(["gitlab.corp", "https://gitlab.corp", "gitlab.corp:9443"])(
    "sends the token nowhere for the same host on another port (%s)",
    async (host) => {
      const result = await labels({ owner: "acme", repo: "infra", host })

      expect(result.labels).toEqual([])
      expect(fetchCalls).toEqual([])
    },
  )

  // A host that doesn't parse used to normalize to gitlab.com, which then got
  // the gitlab.corp token.
  it.each(["ho%st", "https://[fe80::1%eth0]", "ftp://gitlab.corp"])(
    "sends the token nowhere for the unparseable host %s",
    async (host) => {
      const result = await labels({ owner: "acme", repo: "infra", host })

      expect(result.labels).toEqual([])
      expect(fetchCalls).toEqual([])
    },
  )

  // Even a token bound to gitlab.com must not go there for a repo whose host
  // didn't parse: that repo was never shown to live on gitlab.com.
  it.each(["ho%st", "ftp://gitlab.com"])(
    "does not read the unparseable host %s as gitlab.com, where the token is bound",
    async (host) => {
      await Effect.runPromise(sessionManager.appendToEnv({ GITLAB_HOST: "gitlab.com" }))

      const result = await labels({ owner: "acme", repo: "infra", host })

      expect(result.labels).toEqual([])
      expect(fetchCalls).toEqual([])
    },
  )
})

describe("gitlab:cli-credentials — glab's token only to its own host, https unless glab uses http", () => {
  const writeGlabConfig = (yaml: string) => fs.writeFileSync(nodePath.join(glabConfigDir, "config.yml"), yaml)

  it("an http:// instance is absent: no request, no session write", async () => {
    writeGlabConfig("hosts:\n    gitlab.com:\n        token: glpat-glab\n")
    const result = await invoke("gitlab:cli-credentials", { instanceUrl: "http://gitlab.com" })
    expect(result.found).toBe(false)
    expect(fetchCalls).toHaveLength(0)
    expect((await sessionEnv()).GITLAB_TOKEN).toBeUndefined()

    // The same token over https is unchanged.
    expect((await invoke("gitlab:cli-credentials", { instanceUrl: "https://gitlab.com" })).valid).toBe(true)
    expect(fetchCalls.filter((c) => c.url.endsWith("/user")).map((c) => [c.url, c.authorization])).toEqual([
      ["https://gitlab.com/api/v4/user", "Bearer glpat-glab"],
    ])
  })

  it("an instance glab itself reaches over http (api_protocol: http) keeps working", async () => {
    writeGlabConfig(
      "hosts:\n    git.corp.example:\n        token: glpat-corp\n        api_protocol: http\n",
    )
    const result = await invoke("gitlab:cli-credentials", { instanceUrl: "http://git.corp.example" })
    expect(result.valid).toBe(true)
    expect(fetchCalls.filter((c) => c.url.endsWith("/user")).map((c) => [c.url, c.authorization])).toEqual([
      ["http://git.corp.example/api/v4/user", "Bearer glpat-corp"],
    ])
  })
})

describe("gitlab:labels — the session token only to its own host, over https", () => {
  it("another host or plain http gets no request; the bound host is unchanged", async () => {
    await Effect.runPromise(sessionManager.appendToEnv({ GITLAB_TOKEN: "glpat-session", GITLAB_HOST: "gitlab.com" }))
    const repo = { owner: "acme", repo: "infra" }

    const other = await invoke("gitlab:labels", { ...repo, host: "evil.example" })
    const http = await invoke("gitlab:labels", { ...repo, host: "http://gitlab.com" })
    expect([other.labels, http.labels]).toEqual([[], []])
    expect(fetchCalls).toHaveLength(0)

    expect((await invoke("gitlab:labels", { ...repo, host: "gitlab.com" })).labels).toEqual(["bug"])
    expect((await invoke("gitlab:labels", repo)).labels).toEqual(["bug"])
    expect(fetchCalls.map((c) => [new URL(c.url).origin, c.authorization])).toEqual([
      ["https://gitlab.com", "Bearer glpat-session"],
      ["https://gitlab.com", "Bearer glpat-session"],
    ])
  })

  it("a script that moves GITLAB_HOST after the auth block ran cannot move the token", async () => {
    process.env.GITLAB_TOKEN = "glpat-env"
    expect((await invoke("gitlab:env-credentials", { host: "gitlab.com" })).valid).toBe(true)
    fetchCalls = []
    // A Command script's `export GITLAB_HOST=evil.example`, captured into the session.
    await Effect.runPromise(sessionManager.appendToEnv({ GITLAB_HOST: "evil.example" }))

    const repo = { owner: "acme", repo: "infra" }
    const moved = await invoke("gitlab:labels", { ...repo, host: "evil.example" })
    const fallback = await invoke("gitlab:labels", repo)
    const original = await invoke("gitlab:labels", { ...repo, host: "gitlab.com" })
    expect([moved.labels, fallback.labels, original.labels]).toEqual([[], [], []])
    expect(fetchCalls).toHaveLength(0)
  })

  it("without an auth block, an inherited token is bound by glab's host vars (GL_HOST)", async () => {
    await Effect.runPromise(
      sessionManager.appendToEnv({ GITLAB_TOKEN: "glpat-inherited", GL_HOST: "git.corp.example" }),
    )
    const repo = { owner: "acme", repo: "infra" }
    expect((await invoke("gitlab:labels", { ...repo, host: "gitlab.com" })).labels).toEqual([])
    expect(fetchCalls).toHaveLength(0)

    // With no host from the renderer, the lookup targets the bound host.
    expect((await invoke("gitlab:labels", repo)).labels).toEqual(["bug"])
    expect(fetchCalls.map((c) => [new URL(c.url).origin, c.authorization])).toEqual([
      ["https://git.corp.example", "Bearer glpat-inherited"],
    ])
  })
})

describe("a sign-in that finishes after another runbook opened", () => {
  /**
   * Hold every /user validation until the returned release() is called: the
   * window in which the user opens a different runbook.
   */
  const holdValidation = () => {
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      fetchCalls.push({ url })
      if (url.endsWith("/api/v4/user")) {
        await released
        return json({ username: "tanuki" })
      }
      if (url.endsWith("/personal_access_tokens/self")) return json({ scopes: ["api"] })
      return new Response("not found", { status: 404 })
    }) as typeof fetch
    return release
  }

  /** What runbook:get does when a different runbook is opened. */
  const openAnotherRunbook = async () => {
    await Effect.runPromise(
      sessionManager.createSession("/tmp/runbook-b", "/tmp/runbook-b/runbook.mdx").pipe(
        Effect.provide(makeTestEnvironment({})),
      ),
    )
    vcsSessionMeta.clear()
  }

  it.each([
    ["gitlab:validate", { token: "glpat-from-a", host: "gitlab.com", registerSession: true }],
    ["gitlab:env-credentials", { host: "gitlab.com" }],
  ] as const)("%s writes nothing to the new runbook's session", async (channel, params) => {
    process.env.GITLAB_TOKEN = "glpat-env-from-a"
    const release = holdValidation()

    const pending = invoke(channel, params)
    await openAnotherRunbook()
    release()
    const result = await pending

    // Runbook A's (now unmounted) block still gets its answer...
    expect(result.valid).toBe(true)
    // ...but runbook B's session has no credential and no GitLab host binding.
    const env = await sessionEnv()
    expect(env.GITLAB_TOKEN).toBeUndefined()
    expect(env.GITLAB_HOST).toBeUndefined()
    expect(vcsSessionMeta.get("gitlab")).toBeUndefined()
  })
})
