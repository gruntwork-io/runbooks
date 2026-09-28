/**
 * IPC contract tests for how git:clone and git:push handle a remote URL.
 *
 * The handlers run against the REAL main-process stack and real git, with
 * two true boundaries replaced: `electron` (ipcMain capture) and `ssh`. A
 * stand-in `ssh` on PATH either serves repositories from a local directory
 * (running the git-upload-pack / git-receive-pack command git asks the remote
 * for) or fails the way an untrusted host key does, so SSH remotes work
 * without a network. HTTP remotes point at a local server that records the
 * Authorization header of every request it gets.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as http from "node:http"
import type { AddressInfo } from "node:net"
import * as os from "node:os"
import * as nodePath from "node:path"
import { Effect } from "effect"
import { mockElectron } from "../test-utils/mock-electron.ts"

type Handler = (event: unknown, params?: unknown) => unknown
const handlers = new Map<string, Handler>()

mockElectron({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn)
    },
  },
})

const { registerGitHandlers } = await import("./git.ts")
const { sessionManager, vcsSessionMeta } = await import("./runtime.ts")
const { githubSessionEnv } = await import("../../../src/domain/github/auth.ts")
const { makeTestEnvironment } = await import("../../../src/test-utils/TestEnvironment.ts")

registerGitHandlers()

const event = { sender: { send: () => {} } }

interface CloneResult {
  relativePath?: string
  outputs?: Record<string, string>
  error?: string
}

const clone = (url: string) => {
  const handler = handlers.get("git:clone")
  if (!handler) throw new Error("no handler for git:clone")
  return Promise.resolve(handler(event, { url })) as Promise<CloneResult>
}

interface PushResult {
  ok?: true
  error?: string
}

const push = (worktreePath: string, branchName: string) => {
  const handler = handlers.get("git:push")
  if (!handler) throw new Error("no handler for git:push")
  return Promise.resolve(handler(event, { worktreePath, branchName })) as Promise<PushResult>
}

const FAKE_SSH = `#!/bin/sh
# Stand-in for ssh. git runs: ssh [options] [-p port] <user@host> <command>
echo "$@" >> "$FAKE_SSH_LOG"
if [ "$FAKE_SSH_MODE" = hostkey ]; then
  echo "Host key verification failed." >&2
  exit 255
fi
for arg; do command=$arg; done
cd "$FAKE_SSH_ROOT" && exec sh -c "$command"
`

const ENV_KEYS = ["PATH", "FAKE_SSH_LOG", "FAKE_SSH_MODE", "FAKE_SSH_ROOT"]
const savedEnv: Record<string, string | undefined> = {}
let tmp = ""
let workDir = ""
let serveRoot = ""
let sshLog = ""

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    stdio: "pipe",
  })

beforeEach(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  tmp = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "runbooks-git-ipc-")))

  // "Server": acme/infra.git under the directory the fake ssh serves from.
  const seed = nodePath.join(tmp, "seed")
  fs.mkdirSync(seed)
  git(seed, "init", "-q")
  fs.writeFileSync(nodePath.join(seed, "main.tf"), "# tf\n")
  git(seed, "add", ".")
  git(seed, "commit", "-q", "-m", "initial")
  serveRoot = nodePath.join(tmp, "serve")
  fs.mkdirSync(nodePath.join(serveRoot, "acme"), { recursive: true })
  git(tmp, "clone", "-q", "--bare", seed, nodePath.join(serveRoot, "acme", "infra.git"))

  const bin = nodePath.join(tmp, "bin")
  fs.mkdirSync(bin)
  fs.writeFileSync(nodePath.join(bin, "ssh"), FAKE_SSH, { mode: 0o755 })
  sshLog = nodePath.join(tmp, "ssh.log")
  process.env.PATH = `${bin}${nodePath.delimiter}${process.env.PATH ?? ""}`
  process.env.FAKE_SSH_LOG = sshLog
  process.env.FAKE_SSH_ROOT = serveRoot
  delete process.env.FAKE_SSH_MODE

  workDir = nodePath.join(tmp, "work")
  fs.mkdirSync(workDir)
  await Effect.runPromise(sessionManager.createSession(workDir).pipe(Effect.provide(makeTestEnvironment({}))))
})

afterEach(() => {
  vcsSessionMeta.clear()
  sessionManager.deleteSession()
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("git:clone remote URL handling", () => {
  it.each([
    ["git@[::1]:acme/infra.git", "git@::1"],
    ["git@[gitlab.corp:2222]:acme/infra.git", "-p 2222 git@gitlab.corp"],
  ])("clones %s and reports its owner and repo", async (url, sshTarget) => {
    const result = await clone(url)

    expect(result.error).toBeUndefined()
    expect(result.relativePath).toBe("infra")
    expect(result.outputs).toMatchObject({ repo_owner: "acme", repo_name: "infra" })
    expect(fs.existsSync(nodePath.join(workDir, "infra", "main.tf"))).toBe(true)
    expect(fs.readFileSync(sshLog, "utf8")).toContain(sshTarget)
  })

  it.each([
    ["git@[::1]:acme/infra.git", "ssh-keyscan ::1 >>"],
    ["git@[gitlab.corp:2222]:acme/infra.git", "ssh-keyscan -p 2222 gitlab.corp >>"],
    ["git@gitlab.example.com:acme/infra.git", "ssh-keyscan gitlab.example.com >>"],
  ])("names the host of %s in the known_hosts hint", async (url, keyscan) => {
    process.env.FAKE_SSH_MODE = "hostkey"

    const err = await clone(url).then(
      () => undefined,
      (e: Error) => e,
    )

    expect(err?.message).toContain("Host key verification failed.")
    expect(err?.message).toContain(keyscan)
  })

  it.each([
    "--upload-pack=touch /tmp/pwned:acme/infra.git",
    "-u@gitlab.example.com:acme/infra.git",
    "git@-oProxyCommand=touch%20pwned:acme/infra.git",
    "git@gitlab.example.com@evil.example:acme/infra.git",
  ])("refuses %s before running git", async (url) => {
    await expect(clone(url)).rejects.toThrow(/invalid or disallowed git URL/)
    expect(fs.existsSync(sshLog)).toBe(false)
    expect(fs.readdirSync(workDir)).toEqual([])
  })
})

describe("git:push GitHub token binding", () => {
  const SECRET = "ghp_SECRETTOKEN"
  const basicAuth = `Basic ${btoa(`x-access-token:${SECRET}`)}`

  /** Requests the local HTTP "git server" received, with their Authorization header. */
  let requests: Array<{ url: string; authorization?: string }> = []
  let server: http.Server
  let port = 0

  beforeEach(async () => {
    requests = []
    server = http.createServer((req, res) => {
      requests.push({ url: req.url ?? "", authorization: req.headers.authorization })
      res.statusCode = 404
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    port = (server.address() as AddressInfo).port
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  /** A checkout in the session's working directory with one commit on `feature`. */
  const checkoutWithOrigin = (origin: string) => {
    const repo = nodePath.join(workDir, "repo")
    fs.mkdirSync(repo)
    git(repo, "init", "-q", "-b", "feature")
    git(repo, "commit", "-q", "--allow-empty", "-m", "work")
    git(repo, "remote", "add", "origin", origin)
    return repo
  }

  const authenticate = async (env: Record<string, string>, authHost?: string) => {
    await Effect.runPromise(sessionManager.appendToEnv(env))
    if (authHost) vcsSessionMeta.set("github", { host: authHost, source: "manual" })
  }

  it("sends the token to an http origin on the host the session's credential is for", async () => {
    const host = `127.0.0.1:${port}`
    await authenticate(githubSessionEnv(host, SECRET, "user"), host)

    await push(checkoutWithOrigin(`http://${host}/o/r.git`), "feature")

    // Proves the server sees the header when it is sent, so the refusals
    // below are not passing vacuously.
    expect(requests.map((r) => r.authorization)).toContain(basicAuth)
  })

  // git and curl push to these URLs, and withGitHttpAuth attaches the token
  // to their WHATWG origin, even though parseGitRemoteUrl turns them away.
  it.each([
    ["a backslash", "/o\\r.git"],
    ["a non-breaking space", "/o/r\u00a0.git"],
  ])("refuses a github.com token for an http origin with %s in its path", async (_, path) => {
    await authenticate({ GITHUB_TOKEN: SECRET })

    const result = await push(checkoutWithOrigin(`http://127.0.0.1:${port}${path}`), "feature")

    expect(result.error).toContain(
      `The GitHub credential in this session is for github.com, but this repository's origin is 127.0.0.1:${port}.`,
    )
    expect(requests).toEqual([])
  })

  it("refuses the token for an http origin whose host is not a GitHub host name", async () => {
    await authenticate({ GITHUB_TOKEN: SECRET })

    const result = await push(checkoutWithOrigin("http://[::1]:9/o/r.git"), "feature")

    expect(result.error).toContain("this repository's origin is [::1]:9")
    expect(result.error).not.toMatch(/connect/i)
  })

  it("binds the token to the host, not the SSH port, of a git@[host:port]:path origin", async () => {
    await authenticate(githubSessionEnv("ghes.corp", SECRET, "user"), "ghes.corp")
    expect((await clone("git@[ghes.corp:2222]:acme/infra.git")).error).toBeUndefined()
    const repo = nodePath.join(workDir, "infra")
    git(repo, "checkout", "-q", "-b", "feature")
    git(repo, "commit", "-q", "--allow-empty", "-m", "work")

    const result = await push(repo, "feature")

    expect(result.error).toBeUndefined()
    expect(result.ok).toBe(true)
    expect(fs.readFileSync(sshLog, "utf8")).toContain("-p 2222 git@ghes.corp git-receive-pack")
    git(nodePath.join(serveRoot, "acme", "infra.git"), "rev-parse", "--verify", "-q", "feature")
  })
})

describe("API token routing for a checkout's origin", () => {
  const GITLAB_SECRET = "glpat-SECRETTOKEN"
  const GITHUB_SECRET = "ghp_SECRETTOKEN"

  /** Every API request the main process made: the URL it was meant for, and its credentials. */
  let apiRequests: Array<{ target: string; method: string; authorization?: string; privateToken?: string }> = []
  let apiServer: http.Server
  const originalFetch = globalThis.fetch

  beforeEach(async () => {
    apiRequests = []
    // Answers the few GitLab endpoints these flows call, as gitlab.corp would.
    apiServer = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on("data", (chunk: Buffer) => chunks.push(chunk))
      req.on("end", () => {
        const target = String(req.headers["x-test-target"])
        const privateToken = req.headers["private-token"]
        apiRequests.push({
          target,
          method: req.method ?? "",
          authorization: req.headers.authorization,
          privateToken: typeof privateToken === "string" ? privateToken : undefined,
        })
        const url = new URL(target)
        res.setHeader("Content-Type", "application/json")
        if (url.pathname === "/api/v4/user") {
          res.end(JSON.stringify({ username: "tanuki", name: "Tanuki", email: "tanuki@gitlab.corp" }))
        } else if (req.method === "POST" && url.pathname === "/api/v4/projects/acme%2Finfra/merge_requests") {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { source_branch: string }
          res.statusCode = 201
          res.end(
            JSON.stringify({
              iid: 7,
              web_url: `${url.origin}/acme/infra/-/merge_requests/7`,
              source_branch: body.source_branch,
            }),
          )
        } else {
          res.statusCode = 404
          res.end("{}")
        }
      })
    })
    await new Promise<void>((resolve) => apiServer.listen(0, "127.0.0.1", resolve))
    const apiPort = (apiServer.address() as AddressInfo).port

    // The network boundary: every request the API clients make lands on the
    // local server, which records the URL it was meant for. Nothing leaves.
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const target = input instanceof Request ? input.url : String(input)
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      headers.set("x-test-target", target)
      const { pathname, search } = new URL(target)
      return originalFetch(`http://127.0.0.1:${apiPort}${pathname}${search}`, { ...init, headers })
    }) as typeof fetch
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    await new Promise<void>((resolve) => apiServer.close(() => resolve()))
  })

  interface GitResult {
    url?: string
    number?: number
    branch?: string
    ok?: true
    status?: string
    outputs?: Record<string, string>
    error?: string
  }

  const invoke = (channel: string, params: unknown) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`no handler for ${channel}`)
    return Promise.resolve(handler(event, params)) as Promise<GitResult>
  }

  const authenticate = (env: Record<string, string>) => Effect.runPromise(sessionManager.appendToEnv(env))

  /** A clone of acme/infra with `origin` replaced (undefined: removed) and one uncommitted change. */
  const checkout = (origin: string | undefined) => {
    const repo = nodePath.join(workDir, "infra")
    git(workDir, "clone", "-q", nodePath.join(serveRoot, "acme", "infra.git"), repo)
    if (origin === undefined) git(repo, "remote", "remove", "origin")
    else git(repo, "remote", "set-url", "origin", origin)
    fs.writeFileSync(nodePath.join(repo, "change.tf"), "# change\n")
    return repo
  }

  /** What cloning the empty acme/empty.git leaves: no commits, `origin` set (undefined: none). */
  const emptyCheckout = (origin: string | undefined) => {
    const bare = nodePath.join(serveRoot, "acme", "empty.git")
    fs.mkdirSync(bare)
    git(bare, "init", "-q", "--bare")
    const repo = nodePath.join(workDir, "empty")
    fs.mkdirSync(repo)
    git(repo, "init", "-q", "-b", "main")
    if (origin !== undefined) git(repo, "remote", "add", "origin", origin)
    return repo
  }

  const mergeRequest = (worktreePath: string) =>
    invoke("git:merge-request", {
      worktreePath,
      owner: "acme",
      repo: "infra",
      title: "Change",
      baseBranch: "main",
      headBranch: "runbook/change",
      commitMessage: "Change",
    })

  const pullRequest = (worktreePath: string) =>
    invoke("git:pull-request", {
      worktreePath,
      owner: "acme",
      repo: "infra",
      title: "Change",
      baseBranch: "main",
      headBranch: "runbook/change",
      commitMessage: "Change",
    })

  const initDefaultBranch = (worktreePath: string, provider: "github" | "gitlab") =>
    invoke("git:init-default-branch", { worktreePath, branch: "main", provider })

  /**
   * Origins with no host a token could be bound to. git accepts every one of
   * them (the fake ssh even serves the SSH ones), so the flows used to run
   * and send the token to gitlab.com or github.com.
   */
  const NO_HOST: Array<[string, (repo: string) => string | undefined]> = [
    ["no origin", () => undefined],
    ["an IPv6 zone id", (repo) => `git@[fe80::1%eth0]:acme/${repo}.git`],
    ["a host no URL can carry", (repo) => `git@ho%st:acme/${repo}.git`],
    ["a local path", (repo) => nodePath.join(serveRoot, "acme", `${repo}.git`)],
  ]

  it.each(NO_HOST)("git:merge-request sends the token nowhere when origin has %s", async (_, origin) => {
    await authenticate({ GITLAB_TOKEN: GITLAB_SECRET, GITLAB_HOST: "gitlab.corp" })

    const result = await mergeRequest(checkout(origin("infra")))

    expect(result.error).toMatch(/GitLab instance.*origin.*before creating a merge request/)
    expect(result.url).toBeUndefined()
    expect(apiRequests).toEqual([])
    expect(fs.existsSync(sshLog)).toBe(false)
  })

  it.each(NO_HOST)("git:init-default-branch sends the GitLab token nowhere when origin has %s", async (_, origin) => {
    await authenticate({ GITLAB_TOKEN: GITLAB_SECRET, GITLAB_HOST: "gitlab.corp" })

    const result = await initDefaultBranch(emptyCheckout(origin("empty")), "gitlab")

    expect(result.error).toMatch(/GitLab instance.*origin.*before creating the default branch/)
    expect(apiRequests).toEqual([])
    expect(fs.existsSync(sshLog)).toBe(false)
  })

  it.each(NO_HOST)("git:pull-request sends the token nowhere when origin has %s", async (_, origin) => {
    await authenticate({ GITHUB_TOKEN: GITHUB_SECRET })

    const result = await pullRequest(checkout(origin("infra")))

    expect(result.error).toMatch(/GitHub host.*origin.*before creating a pull request/)
    expect(apiRequests).toEqual([])
    expect(fs.existsSync(sshLog)).toBe(false)
  })

  it.each(NO_HOST)("git:init-default-branch sends the GitHub token nowhere when origin has %s", async (_, origin) => {
    await authenticate({ GITHUB_TOKEN: GITHUB_SECRET })

    const result = await initDefaultBranch(emptyCheckout(origin("empty")), "github")

    expect(result.error).toMatch(/GitHub host.*origin.*before creating the default branch/)
    expect(apiRequests).toEqual([])
    expect(fs.existsSync(sshLog)).toBe(false)
  })

  it("git:merge-request opens the MR on gitlab.corp for a [git@gitlab.corp:2222]:… origin", async () => {
    await authenticate({ GITLAB_TOKEN: GITLAB_SECRET, GITLAB_HOST: "gitlab.corp" })

    const result = await mergeRequest(checkout("[git@gitlab.corp:2222]:acme/infra.git"))

    expect(result.error).toBeUndefined()
    expect(result.url).toBe("https://gitlab.corp/acme/infra/-/merge_requests/7")
    // The token went to gitlab.corp's API and nowhere else...
    expect(apiRequests.length).toBeGreaterThan(0)
    for (const request of apiRequests) {
      expect(request.target.startsWith("https://gitlab.corp/")).toBe(true)
    }
    expect(apiRequests).toContainEqual({
      target: "https://gitlab.corp/api/v4/projects/acme%2Finfra/merge_requests",
      method: "POST",
      authorization: `Bearer ${GITLAB_SECRET}`,
      privateToken: undefined,
    })
    // ...while the branch went over SSH to port 2222, as git reads the origin.
    expect(fs.readFileSync(sshLog, "utf8")).toContain("-p 2222 git@gitlab.corp git-receive-pack")
    git(nodePath.join(serveRoot, "acme", "infra.git"), "rev-parse", "--verify", "-q", "runbook/change")
  })

  it("git:init-default-branch validates the GitLab token at gitlab.corp for a [git@gitlab.corp:2222]:… origin", async () => {
    await authenticate({ GITLAB_TOKEN: GITLAB_SECRET, GITLAB_HOST: "gitlab.corp" })

    const result = await initDefaultBranch(emptyCheckout("[git@gitlab.corp:2222]:acme/empty.git"), "gitlab")

    expect(result.error).toBeUndefined()
    expect(result.branch).toBe("main")
    expect(apiRequests.length).toBeGreaterThan(0)
    for (const request of apiRequests) {
      expect(request.target.startsWith("https://gitlab.corp/")).toBe(true)
    }
    expect(apiRequests).toContainEqual({
      target: "https://gitlab.corp/api/v4/user",
      method: "GET",
      authorization: `Bearer ${GITLAB_SECRET}`,
      privateToken: undefined,
    })
    git(nodePath.join(serveRoot, "acme", "empty.git"), "rev-parse", "--verify", "-q", "main")
  })

  it("git:pull-request keeps a github.com token away from a [git@ghes.corp:2222]:… origin", async () => {
    await authenticate({ GITHUB_TOKEN: GITHUB_SECRET })

    const result = await pullRequest(checkout("[git@ghes.corp:2222]:acme/infra.git"))

    expect(result.error).toContain(
      "The GitHub credential in this session is for github.com, but this repository's origin is ghes.corp.",
    )
    expect(apiRequests).toEqual([])
  })

  it.each([
    ["an IPv6 literal", "git@[::1]:acme/infra.git"],
    ["a file URL", "file:///srv/git/acme/infra.git"],
  ])("git:local-repo looks up no GitHub IDs for an origin with %s", async (_, origin) => {
    await authenticate({ GITHUB_TOKEN: GITHUB_SECRET })

    const result = await invoke("git:local-repo", { path: checkout(origin), register: true })

    expect(result.status).toBe("success")
    expect(result.outputs).toMatchObject({ repo_name: "infra" })
    expect(result.outputs).not.toHaveProperty("repo_id")
    expect(apiRequests).toEqual([])
  })

  it("git:local-repo looks the GitHub IDs up on the origin's own host", async () => {
    await authenticate({ GITHUB_TOKEN: GITHUB_SECRET })

    await invoke("git:local-repo", { path: checkout("git@github.com:acme/infra.git"), register: true })

    // Proves the lookup is seen when it happens, so the refusals above are
    // not passing vacuously.
    expect(apiRequests).toContainEqual(
      expect.objectContaining({
        target: "https://api.github.com/repos/acme/infra",
        authorization: `Bearer ${GITHUB_SECRET}`,
      }),
    )
  })

  // A push carries a token only to an http(s) origin, so a push to an SSH
  // origin git can reach but no URL can name still goes ahead, token unused.
  it("git:push still pushes to an SSH origin with an IPv6 zone id, sending no token", async () => {
    await authenticate({ GITHUB_TOKEN: GITHUB_SECRET })
    const repo = checkout("git@[fe80::1%eth0]:acme/infra.git")
    git(repo, "checkout", "-q", "-b", "feature")
    git(repo, "commit", "-q", "--allow-empty", "-m", "work")

    const result = await invoke("git:push", { worktreePath: repo, branchName: "feature" })

    expect(result.error).toBeUndefined()
    expect(result.ok).toBe(true)
    expect(apiRequests).toEqual([])
    expect(fs.readFileSync(sshLog, "utf8")).toContain("git@fe80::1%eth0 git-receive-pack")
  })
})
