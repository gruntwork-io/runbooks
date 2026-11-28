/**
 * IPC contract tests for the gitlab:* handlers: where an auto-detected
 * credential, or an auth block's exported token, may be sent.
 *
 * The handlers run against the REAL main-process stack — runtime.ts (AppLive),
 * vcs-tristate.ts, VcsCredentialsLive, GitLabHttpClient, recent-hosts.ts —
 * with the true boundaries replaced: `electron` (ipcMain capture +
 * app.getPath → a temp userData dir), global `fetch`, process.env, and the two
 * main-process modules the handlers pull in only for TLS recovery / window
 * broadcasts (system-trust.ts, window.ts). Mirrors github.test.ts.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  mock,
  spyOn,
} from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"
import { Effect } from "effect"
import { fetchUrl } from "../test-utils/fetch-url.ts"
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
await mock.module("../window.ts", () => ({
  getMainWindow: () => null,
}))

const { registerGitLabHandlers } = await import("./gitlab.ts")
const { sessionManager } = await import("./runtime.ts")
const { authEnvExport } = await import("../../../src/domain/exec/authEnv.ts")
const systemTrust = await import("../system-trust.ts")
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
let fetchCalls: Array<{ url: string; authorization?: string | undefined }> = []

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })

/** Answers GitLab's /user, PAT introspection and project labels on any host. */
const mockGitLab = () => {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = fetchUrl(input)
    const headers = (init?.headers ?? {}) as Record<string, string>
    fetchCalls.push({ url, authorization: headers.Authorization ?? headers["PRIVATE-TOKEN"] })
    if (url.endsWith("/api/v4/user")) return Promise.resolve(json({ username: "tanuki" }))
    if (url.endsWith("/personal_access_tokens/self"))
      return Promise.resolve(json({ scopes: ["api"] }))
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

// TLS recovery and the glab ca_cert harvest are stubbed with spies scoped to
// this file, not a module mock: Bun module mocks outlive the test file, and
// system-trust.test.ts needs the real module.
let trustSpies: Array<{ mockRestore: () => void }> = []

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  trustSpies = [
    spyOn(systemTrust, "refreshSystemTrust").mockResolvedValue({ coldReadOk: true }),
    spyOn(systemTrust, "registerExtraCaPems").mockImplementation(() => {}),
  ]
})

afterAll(() => {
  for (const spy of trustSpies) spy.mockRestore()
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
  await Effect.runPromise(
    sessionManager.createSession("/tmp").pipe(Effect.provide(makeTestEnvironment({}))),
  )
})

afterEach(() => {
  globalThis.fetch = originalFetch
  sessionManager.deleteSession()
  fs.rmSync(userDataDir, { recursive: true, force: true })
  fs.rmSync(glabConfigDir, { recursive: true, force: true })
})

const sessionEnv = async () =>
  Object.fromEntries((await Effect.runPromise(sessionManager.getSession())).env)

/** The auth block the requests below are made for. */
const AUTH = "gitlab_auth"

/** What block `blockId` exports, or undefined when it hasn't signed in. */
const exported = (blockId = AUTH) => sessionManager.getEnvExport(blockId)?.env

/** Sign auth block `blockId` in with `env`, as gitlab:validate does. */
const signIn = (env: Record<string, string>, blockId = AUTH) => {
  const envExport = authEnvExport("gitlab", env)
  if (!envExport.ok) throw new Error(envExport.error)
  return Effect.runPromise(
    sessionManager.setEnvExport(blockId, envExport.export, sessionManager.getGeneration()),
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("gitlab:env-credentials — never over plain http", () => {
  it("an http:// instance for the bound host is absent: no request, no export (prefixed or not)", async () => {
    process.env.GITLAB_TOKEN = "glpat-env"
    process.env.CI_GITLAB_TOKEN = "glpat-ci"
    const plain = await invoke("gitlab:env-credentials", {
      instanceUrl: "http://gitlab.com",
      componentId: AUTH,
    })
    const prefixed = await invoke("gitlab:env-credentials", {
      instanceUrl: "http://gitlab.com",
      prefix: "CI_",
      componentId: AUTH,
    })
    expect(plain.found).toBe(false)
    expect(prefixed.found).toBe(false)
    expect(fetchCalls).toHaveLength(0)
    expect(exported()).toBeUndefined()
  })

  it("a valid credential is the block's export, and stays out of the session's env", async () => {
    process.env.GITLAB_TOKEN = "glpat-env"
    await invoke("gitlab:env-credentials", { host: "gitlab.com", componentId: AUTH })

    expect(exported()).toEqual({
      GITLAB_TOKEN: "glpat-env",
      GITLAB_HOST: "gitlab.com",
      GITLAB_USER: "tanuki",
    })
    expect((await sessionEnv()).GITLAB_HOST).toBeUndefined()
  })

  it("https (explicit or a bare host) is unchanged", async () => {
    process.env.GITLAB_TOKEN = "glpat-env"
    process.env.CI_GITLAB_TOKEN = "glpat-ci"
    const plain = await invoke("gitlab:env-credentials", { instanceUrl: "https://gitlab.com" })
    const prefixed = await invoke("gitlab:env-credentials", { host: "gitlab.com", prefix: "CI_" })
    expect([plain.valid, prefixed.valid]).toEqual([true, true])
    expect(
      fetchCalls.filter((c) => c.url.endsWith("/user")).map((c) => [c.url, c.authorization]),
    ).toEqual([
      ["https://gitlab.com/api/v4/user", "Bearer glpat-env"],
      ["https://gitlab.com/api/v4/user", "Bearer glpat-ci"],
    ])
  })
})

describe("gitlab:validate", () => {
  it("fails a sign-in whose export can't be saved, naming why without the token", async () => {
    sessionManager.deleteSession()

    const result = invoke("gitlab:validate", {
      token: "glpat-unsaved",
      registerSession: true,
      componentId: AUTH,
    })

    await expect(result).rejects.toThrow("Runbooks couldn't save the sign-in: no active session")
    await expect(result).rejects.not.toThrow("glpat-unsaved")
  })

  it("a manually entered token still validates against an http:// instance", async () => {
    const result = await invoke("gitlab:validate", {
      token: "glpat-manual",
      instanceUrl: "http://git.corp.example",
    })
    expect(result.valid).toBe(true)
    expect(fetchCalls.filter((c) => c.url.endsWith("/user")).map((c) => c.url)).toEqual([
      "http://git.corp.example/api/v4/user",
    ])
  })

  it("fromBlock sends that block's credential only to its own host, over https", async () => {
    // Block A: the env token authenticates gitlab.com and becomes A's export.
    process.env.GITLAB_TOKEN = "glpat-env"
    expect(
      (await invoke("gitlab:env-credentials", { host: "gitlab.com", componentId: "a" })).valid,
    ).toBe(true)
    fetchCalls = []

    // Block B chains to A but targets plain http, or another host: refused
    // without any request.
    const http = await invoke("gitlab:validate", {
      fromBlock: "a",
      instanceUrl: "http://gitlab.com",
    })
    const other = await invoke("gitlab:validate", {
      fromBlock: "a",
      instanceUrl: "https://evil.example",
    })
    expect([http.valid, other.valid]).toEqual([false, false])
    expect(fetchCalls).toHaveLength(0)

    const same = await invoke("gitlab:validate", {
      fromBlock: "a",
      host: "gitlab.com",
      componentId: "b",
      registerSession: true,
    })
    expect(same.valid).toBe(true)
    expect(
      fetchCalls.filter((c) => c.url.endsWith("/user")).map((c) => [c.url, c.authorization]),
    ).toEqual([["https://gitlab.com/api/v4/user", "Bearer glpat-env"]])
    // B exports the credential it chained to, for the blocks that name B
    expect(exported("b")?.GITLAB_TOKEN).toBe("glpat-env")
  })
})

describe("gitlab:labels — which instance a block's token is sent to", () => {
  const SECRET = "glpat-SECRETTOKEN"
  const labels = (params: { owner: string; repo: string; host?: string }) =>
    invoke("gitlab:labels", { ...params, envFrom: [AUTH] }) as Promise<{ labels: string[] }>

  beforeEach(async () => {
    // The block signed in to the custom-port instance the repo lives on.
    await signIn({ GITLAB_TOKEN: SECRET, GITLAB_HOST: "gitlab.corp:8443" })
  })

  it("reads labels from the repo's own instance", async () => {
    const result = await labels({ owner: "acme", repo: "infra", host: "gitlab.corp:8443" })

    expect(result.labels).toEqual(["bug"])
    expect(fetchCalls.map((c) => c.url)).toEqual([
      "https://gitlab.corp:8443/api/v4/projects/acme%2Finfra/labels?include_ancestor_groups=true&per_page=100&page=1",
    ])
    expect(fetchCalls[0]?.authorization).toBe(`Bearer ${SECRET}`)
  })

  it("falls back to the instance the block signed in to when the renderer names none", async () => {
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

  // Even a token for gitlab.com must not go there for a repo whose host
  // didn't parse: that repo was never shown to live on gitlab.com.
  it.each(["ho%st", "ftp://gitlab.com"])(
    "does not read the unparseable host %s as gitlab.com, where the block signed in",
    async (host) => {
      await signIn({ GITLAB_TOKEN: SECRET, GITLAB_HOST: "gitlab.com" })

      const result = await labels({ owner: "acme", repo: "infra", host })

      expect(result.labels).toEqual([])
      expect(fetchCalls).toEqual([])
    },
  )
})

describe("gitlab:cli-credentials — glab's token only to its own host, https unless glab uses http", () => {
  const writeGlabConfig = (yaml: string) =>
    fs.writeFileSync(nodePath.join(glabConfigDir, "config.yml"), yaml)

  // These read glab's config.yml, which the handler falls back to only when
  // the glab binary is missing. An empty PATH makes it missing on every
  // machine, not just on CI runners that never installed it.
  let savedPath: string | undefined
  let emptyBinDir = ""
  beforeEach(() => {
    savedPath = process.env.PATH
    emptyBinDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "no-glab-"))
    process.env.PATH = emptyBinDir
  })
  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH
    else process.env.PATH = savedPath
    fs.rmSync(emptyBinDir, { recursive: true, force: true })
  })

  it("an http:// instance is absent: no request, no export", async () => {
    writeGlabConfig("hosts:\n    gitlab.com:\n        token: glpat-glab\n")
    const result = await invoke("gitlab:cli-credentials", {
      instanceUrl: "http://gitlab.com",
      componentId: AUTH,
    })
    expect(result.found).toBe(false)
    expect(fetchCalls).toHaveLength(0)
    expect(exported()).toBeUndefined()

    // The same token over https is unchanged.
    expect(
      (await invoke("gitlab:cli-credentials", { instanceUrl: "https://gitlab.com" })).valid,
    ).toBe(true)
    expect(
      fetchCalls.filter((c) => c.url.endsWith("/user")).map((c) => [c.url, c.authorization]),
    ).toEqual([["https://gitlab.com/api/v4/user", "Bearer glpat-glab"]])
  })

  it("an instance glab itself reaches over http (api_protocol: http) keeps working", async () => {
    writeGlabConfig(
      "hosts:\n    git.corp.example:\n        token: glpat-corp\n        api_protocol: http\n",
    )
    const result = await invoke("gitlab:cli-credentials", {
      instanceUrl: "http://git.corp.example",
    })
    expect(result.valid).toBe(true)
    expect(
      fetchCalls.filter((c) => c.url.endsWith("/user")).map((c) => [c.url, c.authorization]),
    ).toEqual([["http://git.corp.example/api/v4/user", "Bearer glpat-corp"]])
  })
})

describe("gitlab:labels — a block's token only to its own host, over https", () => {
  it("another host or plain http gets no request; the block's host is unchanged", async () => {
    await signIn({ GITLAB_TOKEN: "glpat-block", GITLAB_HOST: "gitlab.com" })
    const repo = { owner: "acme", repo: "infra", envFrom: [AUTH] }

    const other = await invoke("gitlab:labels", { ...repo, host: "evil.example" })
    const http = await invoke("gitlab:labels", { ...repo, host: "http://gitlab.com" })
    expect([other.labels, http.labels]).toEqual([[], []])
    expect(fetchCalls).toHaveLength(0)

    expect((await invoke("gitlab:labels", { ...repo, host: "gitlab.com" })).labels).toEqual(["bug"])
    expect((await invoke("gitlab:labels", repo)).labels).toEqual(["bug"])
    expect(fetchCalls.map((c) => [new URL(c.url).origin, c.authorization])).toEqual([
      ["https://gitlab.com", "Bearer glpat-block"],
      ["https://gitlab.com", "Bearer glpat-block"],
    ])
  })

  it("a token in the session's env goes nowhere: only a block envFrom names gives one", async () => {
    await Effect.runPromise(
      sessionManager.applyScriptEnv({
        env: { GITLAB_TOKEN: "glpat-inherited", GITLAB_HOST: "gitlab.com" },
        generation: sessionManager.getGeneration(),
      }),
    )
    const repo = { owner: "acme", repo: "infra" }

    expect((await invoke("gitlab:labels", { ...repo, host: "gitlab.com" })).labels).toEqual([])
    expect((await invoke("gitlab:labels", repo)).labels).toEqual([])
    expect(fetchCalls).toHaveLength(0)
  })
})

describe("a sign-in that finishes after another runbook opened", () => {
  /**
   * Hold every /user validation until the returned release() is called: the
   * window in which the user opens a different runbook.
   */
  const holdValidation = () => {
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = fetchUrl(input)
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
      sessionManager
        .createSession("/tmp/runbook-b", "/tmp/runbook-b/runbook.mdx")
        .pipe(Effect.provide(makeTestEnvironment({}))),
    )
  }

  it.each([
    [
      "gitlab:validate",
      { token: "glpat-from-a", host: "gitlab.com", registerSession: true, componentId: AUTH },
    ],
    ["gitlab:env-credentials", { host: "gitlab.com", componentId: AUTH }],
  ] as const)("%s exports nothing in the new runbook's session", async (channel, params) => {
    process.env.GITLAB_TOKEN = "glpat-env-from-a"
    const release = holdValidation()

    const pending = invoke(channel, params)
    await openAnotherRunbook()
    release()
    const result = await pending

    // Runbook A's (now unmounted) block still gets its answer...
    expect(result.valid).toBe(true)
    // ...but runbook B's session has no export for it.
    expect(exported()).toBeUndefined()
  })
})
