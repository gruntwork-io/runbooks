/**
 * IPC contract tests for the git:* handlers: how they read a remote URL, and
 * where a session token may be sent.
 *
 * The handlers run against the REAL main-process stack — runtime.ts (AppLive:
 * GitCliClient over real git, GitHubHttpClient, GitLabHttpClient) — with the
 * true boundaries replaced: `electron` (ipcMain capture), global `fetch` (the
 * provider APIs), `ssh`, and the git remotes.
 *
 *  - "remote URL handling": a stand-in `ssh` on PATH either serves
 *    repositories from a local directory (running the git-upload-pack /
 *    git-receive-pack command git asks the remote for) or fails the way an
 *    untrusted host key does, so SSH remotes work without a network. HTTP(S)
 *    remotes point at local servers that record the Authorization header of
 *    every request they get.
 *  - "session token binding": the git remotes are local servers that record
 *    every Authorization header they receive and answer 404: one over plain
 *    http, one over https.
 *
 * Both https servers use the committed test/fixtures/tls localhost
 * certificate, trusted through GIT_SSL_CAINFO.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, spyOn } from "bun:test"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as http from "node:http"
import * as https from "node:https"
import * as os from "node:os"
import * as nodePath from "node:path"
import type { AddressInfo } from "node:net"
import { Effect } from "effect"
import { fetchUrl } from "../test-utils/fetch-url.ts"
import { mockElectron } from "../test-utils/mock-electron.ts"
import { errorMessage } from "../../../src/errors/message.ts"

// ---------------------------------------------------------------------------
// Boundary mocks (must be registered before the handler module is imported)
// ---------------------------------------------------------------------------

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
const { makeTestEnvironment } = await import("../../../src/test-utils/TestEnvironment.ts")
const { githubSessionEnv } = await import("../../../src/domain/github/auth.ts")

registerGitHandlers()

const event = { sender: { send: () => {} } }

const TLS_FIXTURES = nodePath.resolve(import.meta.dirname, "../../../test/fixtures/tls")

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

describe("remote URL handling (real git, stand-in ssh)", () => {
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

  const ENV_KEYS = [
    "PATH",
    "FAKE_SSH_LOG",
    "FAKE_SSH_MODE",
    "FAKE_SSH_ROOT",
    "GIT_SSL_CAINFO",
    "no_proxy",
    "NO_PROXY",
  ]
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
    await Effect.runPromise(
      sessionManager.createSession(workDir).pipe(Effect.provide(makeTestEnvironment({}))),
    )
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

    it("clones an SSH remote whose user isn't git, through the user's core.sshCommand in batch mode", async () => {
      // A self-managed GitLab whose sshd runs as `gitlab`, reached with a
      // per-account key: the clone must run the user's ssh command, wrapped
      // in the no-prompt options, not a bare `ssh`.
      const saved = [
        "GIT_SSH_COMMAND",
        "GIT_SSH",
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_KEY_0",
        "GIT_CONFIG_VALUE_0",
      ].map((key) => [key, process.env[key]] as const)
      delete process.env.GIT_SSH_COMMAND
      delete process.env.GIT_SSH
      process.env.GIT_CONFIG_COUNT = "1"
      process.env.GIT_CONFIG_KEY_0 = "core.sshCommand"
      process.env.GIT_CONFIG_VALUE_0 = "ssh -i /keys/id_work"
      try {
        const result = await clone("gitlab@gitlab.corp.net:acme/infra.git")

        expect(result.error).toBeUndefined()
        expect(result.outputs).toMatchObject({ repo_owner: "acme", repo_name: "infra" })
        expect(fs.existsSync(nodePath.join(workDir, "infra", "main.tf"))).toBe(true)
        const sshArgs = fs.readFileSync(sshLog, "utf8")
        expect(sshArgs).toContain("-i /keys/id_work -o BatchMode=yes -o StrictHostKeyChecking=yes")
        expect(sshArgs).toContain("gitlab@gitlab.corp.net")
      } finally {
        for (const [key, value] of saved) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }
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

    /** Requests the local "git servers" received, with their Authorization header. */
    let requests: Array<{ url: string; authorization?: string | undefined }> = []
    const record = (req: http.IncomingMessage, res: http.ServerResponse) => {
      requests.push({ url: req.url ?? "", authorization: req.headers.authorization })
      res.statusCode = 404
      res.end()
    }
    let servers: Array<http.Server | https.Server> = []
    /** Bare hosts (`127.0.0.1:<port>`) of a git server over plain http and one over https. */
    let httpHost = ""
    let httpsHost = ""

    const listen = async (server: http.Server | https.Server) => {
      servers.push(server)
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve)
      })
      return `127.0.0.1:${(server.address() as AddressInfo).port}`
    }

    beforeEach(async () => {
      requests = []
      servers = []
      process.env.GIT_SSL_CAINFO = nodePath.join(TLS_FIXTURES, "ca.pem")
      process.env.no_proxy = process.env.NO_PROXY = "127.0.0.1,localhost"
      httpHost = await listen(http.createServer(record))
      httpsHost = await listen(
        https.createServer(
          {
            key: fs.readFileSync(nodePath.join(TLS_FIXTURES, "localhost-key.pem")),
            cert: fs.readFileSync(nodePath.join(TLS_FIXTURES, "localhost-cert.pem")),
          },
          record,
        ),
      )
    })

    afterEach(async () => {
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => {
              server.close(() => resolve())
            }),
        ),
      )
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

    it("sends the token to an https origin on the host the session's credential is for", async () => {
      await authenticate(githubSessionEnv(httpsHost, SECRET, "user"), httpsHost)

      await push(checkoutWithOrigin(`https://${httpsHost}/o/r.git`), "feature")

      // Proves the server sees the header when it is sent, so the refusals
      // below are not passing vacuously.
      expect(requests.map((r) => r.authorization)).toContain(basicAuth)
    })

    it("never sends the token to an http origin, even on the host the session's credential is for", async () => {
      await authenticate(githubSessionEnv(httpHost, SECRET, "user"), httpHost)

      const result = await push(checkoutWithOrigin(`http://${httpHost}/o/r.git`), "feature")

      expect(result.error).toContain(`This repository's origin on ${httpHost} uses plain http`)
      expect(requests).toEqual([])
    })

    // git and curl push to these URLs, and withGitHttpAuth attaches the token
    // to their WHATWG origin, even though parseGitRemoteUrl turns them away.
    it.each([
      ["a backslash", "/o\\r.git"],
      ["a non-breaking space", "/o/r\u00a0.git"],
    ])("refuses a github.com token for an https origin with %s in its path", async (_, path) => {
      await authenticate({ GITHUB_TOKEN: SECRET })

      const result = await push(checkoutWithOrigin(`https://${httpsHost}${path}`), "feature")

      expect(result.error).toContain(
        `The GitHub credential in this session is for github.com, but this repository's origin is ${httpsHost}.`,
      )
      expect(requests).toEqual([])
    })

    it("refuses the token for an https origin whose host is not a GitHub host name", async () => {
      await authenticate({ GITHUB_TOKEN: SECRET })

      const result = await push(checkoutWithOrigin("https://[::1]:9/o/r.git"), "feature")

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
    let apiRequests: Array<{
      target: string
      method: string
      authorization?: string | undefined
      privateToken?: string | undefined
    }> = []
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
            res.end(
              JSON.stringify({ username: "tanuki", name: "Tanuki", email: "tanuki@gitlab.corp" }),
            )
          } else if (
            req.method === "POST" &&
            url.pathname === "/api/v4/projects/acme%2Finfra/merge_requests"
          ) {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
              source_branch: string
            }
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
      await new Promise<void>((resolve) => {
        apiServer.listen(0, "127.0.0.1", resolve)
      })
      const apiPort = (apiServer.address() as AddressInfo).port

      // The network boundary: every request the API clients make lands on the
      // local server, which records the URL it was meant for. Nothing leaves.
      globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
        const target = fetchUrl(input)
        const headers = new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : undefined),
        )
        headers.set("x-test-target", target)
        const { pathname, search } = new URL(target)
        return originalFetch(`http://127.0.0.1:${apiPort}${pathname}${search}`, {
          ...init,
          headers,
        })
      }) as typeof fetch
    })

    afterEach(async () => {
      globalThis.fetch = originalFetch
      await new Promise<void>((resolve) => {
        apiServer.close(() => resolve())
      })
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

    const authenticate = (env: Record<string, string>) =>
      Effect.runPromise(sessionManager.appendToEnv(env))

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

    it.each(NO_HOST)(
      "git:merge-request sends the token nowhere when origin has %s",
      async (_, origin) => {
        await authenticate({ GITLAB_TOKEN: GITLAB_SECRET, GITLAB_HOST: "gitlab.corp" })

        const result = await mergeRequest(checkout(origin("infra")))

        expect(result.error).toMatch(/GitLab instance.*origin.*before creating a merge request/)
        expect(result.url).toBeUndefined()
        expect(apiRequests).toEqual([])
        expect(fs.existsSync(sshLog)).toBe(false)
      },
    )

    it.each(NO_HOST)(
      "git:init-default-branch sends the GitLab token nowhere when origin has %s",
      async (_, origin) => {
        await authenticate({ GITLAB_TOKEN: GITLAB_SECRET, GITLAB_HOST: "gitlab.corp" })

        const result = await initDefaultBranch(emptyCheckout(origin("empty")), "gitlab")

        expect(result.error).toMatch(/GitLab instance.*origin.*before creating the default branch/)
        expect(apiRequests).toEqual([])
        expect(fs.existsSync(sshLog)).toBe(false)
      },
    )

    // A push carries the token only to an http(s) origin, but the GitLab
    // token is bound to origin's host, and these name none to bind it to.
    it.each(NO_HOST)("git:push refuses the GitLab token when origin has %s", async (_, origin) => {
      await authenticate({ GITLAB_TOKEN: GITLAB_SECRET, GITLAB_HOST: "gitlab.corp" })
      const repo = checkout(origin("infra"))
      git(repo, "checkout", "-q", "-b", "feature")
      git(repo, "commit", "-q", "--allow-empty", "-m", "work")

      const result = await invoke("git:push", {
        worktreePath: repo,
        branchName: "feature",
        provider: "gitlab",
      })

      expect(result.error).toMatch(/GitLab instance.*origin.*before pushing/)
      expect(apiRequests).toEqual([])
      expect(fs.existsSync(sshLog)).toBe(false)
    })

    it.each(NO_HOST)(
      "git:pull-request sends the token nowhere when origin has %s",
      async (_, origin) => {
        await authenticate({ GITHUB_TOKEN: GITHUB_SECRET })

        const result = await pullRequest(checkout(origin("infra")))

        expect(result.error).toMatch(/GitHub host.*origin.*before creating a pull request/)
        expect(apiRequests).toEqual([])
        expect(fs.existsSync(sshLog)).toBe(false)
      },
    )

    it.each(NO_HOST)(
      "git:init-default-branch sends the GitHub token nowhere when origin has %s",
      async (_, origin) => {
        await authenticate({ GITHUB_TOKEN: GITHUB_SECRET })

        const result = await initDefaultBranch(emptyCheckout(origin("empty")), "github")

        expect(result.error).toMatch(/GitHub host.*origin.*before creating the default branch/)
        expect(apiRequests).toEqual([])
        expect(fs.existsSync(sshLog)).toBe(false)
      },
    )

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
      git(
        nodePath.join(serveRoot, "acme", "infra.git"),
        "rev-parse",
        "--verify",
        "-q",
        "runbook/change",
      )
    })

    it("git:init-default-branch validates the GitLab token at gitlab.corp for a [git@gitlab.corp:2222]:… origin", async () => {
      await authenticate({ GITLAB_TOKEN: GITLAB_SECRET, GITLAB_HOST: "gitlab.corp" })

      const result = await initDefaultBranch(
        emptyCheckout("[git@gitlab.corp:2222]:acme/empty.git"),
        "gitlab",
      )

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

      await invoke("git:local-repo", {
        path: checkout("git@github.com:acme/infra.git"),
        register: true,
      })

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
})

describe("session token binding (local http and https remotes)", () => {
  const invoke = (channel: string, params?: unknown) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`no handler for ${channel}`)
    // git:clone throws on failure; the others return { error }.
    return Promise.resolve(handler(event, params)).catch((err: unknown) => ({
      error: errorMessage(err),
    })) as Promise<any>
  }

  // -------------------------------------------------------------------------
  // Remotes, fetch, git env
  // -------------------------------------------------------------------------

  /** A git remote that records every Authorization header and answers 404. */
  function recordingRemote(tls?: https.ServerOptions) {
    const seen: Array<string | undefined> = []
    const onRequest = (req: http.IncomingMessage, res: http.ServerResponse) => {
      seen.push(req.headers.authorization)
      res.writeHead(404).end()
    }
    const server = tls ? https.createServer(tls, onRequest) : http.createServer(onRequest)
    return {
      seen,
      /** Resolves to the remote's bare host (`127.0.0.1:<port>`). */
      listen: () =>
        new Promise<string>((resolve) => {
          server.listen(0, "127.0.0.1", () =>
            resolve(`127.0.0.1:${(server.address() as AddressInfo).port}`),
          )
        }),
      close: () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        }),
    }
  }

  const plainRemote = recordingRemote()
  const tlsRemote = recordingRemote({
    key: fs.readFileSync(nodePath.join(TLS_FIXTURES, "localhost-key.pem")),
    cert: fs.readFileSync(nodePath.join(TLS_FIXTURES, "localhost-cert.pem")),
  })
  /** Bare hosts of the two remotes. */
  let httpHost = ""
  let httpsHost = ""

  const originalFetch = globalThis.fetch
  let fetchCalls: Array<{ url: string; authorization?: string | undefined }> = []

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })

  /** Answers the GitLab user and merge-request APIs on any host. */
  const mockApis = () => {
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = fetchUrl(input)
      const headers = (init?.headers ?? {}) as Record<string, string>
      fetchCalls.push({ url, authorization: headers.Authorization ?? headers["PRIVATE-TOKEN"] })
      if (url.endsWith("/api/v4/user")) {
        return Promise.resolve(
          json({ username: "tanuki", name: "Tanuki", email: "tanuki@example.com" }),
        )
      }
      if (url.endsWith("/merge_requests")) {
        return Promise.resolve(
          json({ web_url: "https://example.test/mr/1", iid: 1, source_branch: "feature" }),
        )
      }
      return Promise.resolve(new Response("not found", { status: 404 }))
    }) as typeof fetch
  }

  const GITLAB_TOKEN = "glpat-session-secret"
  const GITHUB_TOKEN = "ghp_session_secret"

  /**
   * Every place `token` was sent: `git <origin>` for a remote, `api <origin>`
   * for a provider API call.
   */
  const sinksOf = (token: string): string[] => {
    const carries = (authorization?: string) =>
      !!authorization &&
      (authorization.includes(token) ||
        (authorization.startsWith("Basic ") && atob(authorization.slice(6)).includes(token)))
    return [
      ...(plainRemote.seen.some(carries) ? [`git http://${httpHost}`] : []),
      ...(tlsRemote.seen.some(carries) ? [`git https://${httpsHost}`] : []),
      ...new Set(
        fetchCalls
          .filter((c) => carries(c.authorization))
          .map((c) => `api ${new URL(c.url).origin}`),
      ),
    ]
  }

  /** Git config/env vars the tests set on process.env; saved and restored. */
  const ENV_KEYS = [
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_SSL_CAINFO",
    "no_proxy",
    "NO_PROXY",
  ]
  const savedEnv: Record<string, string | undefined> = {}
  let root = ""
  let workDir = ""
  let bareRemote = ""

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, env: process.env, stdio: "pipe" }).toString().trim()

  beforeAll(async () => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
    root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "runbooks-git-ipc-"))
    // A known identity and nothing else from the user's git config (no
    // credential helpers, signing or URL rewrites); trust the fixture CA; never
    // route the local remotes through a proxy.
    const globalConfig = nodePath.join(root, "gitconfig")
    fs.writeFileSync(globalConfig, "[user]\n\tname = Tester\n\temail = tester@example.com\n")
    process.env.GIT_CONFIG_GLOBAL = globalConfig
    process.env.GIT_CONFIG_SYSTEM = "/dev/null"
    process.env.GIT_SSL_CAINFO = nodePath.join(TLS_FIXTURES, "ca.pem")
    process.env.no_proxy = process.env.NO_PROXY = "127.0.0.1,localhost"

    bareRemote = nodePath.join(root, "bare.git")
    git(root, "init", "--bare", bareRemote)

    httpHost = await plainRemote.listen()
    httpsHost = await tlsRemote.listen()
  })

  afterAll(async () => {
    await plainRemote.close()
    await tlsRemote.close()
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
    fs.rmSync(root, { recursive: true, force: true })
  })

  beforeEach(async () => {
    workDir = fs.mkdtempSync(nodePath.join(root, "work-"))
    plainRemote.seen.length = 0
    tlsRemote.seen.length = 0
    fetchCalls = []
    mockApis()
    vcsSessionMeta.clear()
    await Effect.runPromise(
      sessionManager.createSession(workDir).pipe(Effect.provide(makeTestEnvironment({}))),
    )
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vcsSessionMeta.clear()
    sessionManager.deleteSession()
  })

  /** What a GitLab auth block writes to the session for `host`. */
  const authGitLab = async (host: string) => {
    await Effect.runPromise(
      sessionManager.appendToEnv({ GITLAB_TOKEN, GITLAB_USER: "tanuki", GITLAB_HOST: host }),
    )
    vcsSessionMeta.set("gitlab", { host, source: "manual" })
  }

  /** A Command script's `export GITLAB_HOST=<value>`, captured into the session. */
  const scriptExportsGitLabHost = (value: string) =>
    Effect.runPromise(sessionManager.appendToEnv({ GITLAB_HOST: value }))

  /** A session whose env is inherited from a shell (no auth block ran). */
  const inheritedSession = (env: Record<string, string>) =>
    Effect.runPromise(
      sessionManager.createSession(workDir).pipe(Effect.provide(makeTestEnvironment(env))),
    )

  /** What a GitHub auth block writes to the session for `host`. */
  const authGitHub = async (host: string) => {
    await Effect.runPromise(
      sessionManager.appendToEnv(githubSessionEnv(host, GITHUB_TOKEN, "octocat")),
    )
    vcsSessionMeta.set("github", { host, source: "manual" })
  }

  /**
   * A checkout in the session working dir whose origin is `origin`, with one
   * commit on main (or none) and optionally a separate push URL.
   */
  const checkout = (origin: string, options: { empty?: boolean; pushUrl?: string } = {}) => {
    const dir = fs.mkdtempSync(nodePath.join(workDir, "repo-"))
    git(dir, "init", "-b", "main")
    if (!options.empty) {
      fs.writeFileSync(nodePath.join(dir, "README.md"), "readme\n")
      git(dir, "add", ".")
      git(dir, "commit", "-m", "initial")
    }
    git(dir, "remote", "add", "origin", origin)
    if (options.pushUrl) git(dir, "remote", "set-url", "--push", "origin", options.pushUrl)
    // Work for a merge request to commit.
    fs.writeFileSync(nodePath.join(dir, "change.txt"), "change\n")
    return dir
  }

  let cloneSeq = 0
  const clone = (url: string, provider: "github" | "gitlab") =>
    invoke("git:clone", { url, provider, localPath: `clone-${++cloneSeq}` })

  const mergeRequest = (worktreePath: string) =>
    invoke("git:merge-request", {
      worktreePath,
      owner: "acme",
      repo: "infra",
      title: "Update",
      baseBranch: "main",
      headBranch: "feature",
      commitMessage: "Update",
    })

  // -------------------------------------------------------------------------
  // Tests
  // -------------------------------------------------------------------------

  describe("git:clone — a session token goes only to its own host, over https", () => {
    it("GitLab: the bound host over https gets the token (unchanged)", async () => {
      await authGitLab(httpsHost)
      await clone(`https://${httpsHost}/acme/infra.git`, "gitlab")
      expect(sinksOf(GITLAB_TOKEN)).toEqual([`git https://${httpsHost}`])
    })

    it("GitLab: another host never gets it", async () => {
      await authGitLab("gitlab.com")
      await clone(`https://${httpsHost}/acme/infra.git`, "gitlab")
      expect(tlsRemote.seen.length).toBeGreaterThan(0) // the clone did reach the remote
      expect(sinksOf(GITLAB_TOKEN)).toEqual([])
    })

    it("GitLab and GitHub: never over plain http, even to the bound host", async () => {
      await authGitLab(httpHost)
      await authGitHub(httpHost)
      await clone(`http://${httpHost}/acme/infra.git`, "gitlab")
      await clone(`http://${httpHost}/acme/infra.git`, "github")
      expect(plainRemote.seen.length).toBeGreaterThan(0)
      expect(sinksOf(GITLAB_TOKEN)).toEqual([])
      expect(sinksOf(GITHUB_TOKEN)).toEqual([])
    })

    it("GitHub: the bound host over https gets the token (unchanged)", async () => {
      await authGitHub(httpsHost)
      await clone(`https://${httpsHost}/acme/infra.git`, "github")
      expect(sinksOf(GITHUB_TOKEN)).toEqual([`git https://${httpsHost}`])
    })
  })

  describe("git:push / git:init-default-branch / git:merge-request — GitLab token bound to origin", () => {
    it("push: origin on the bound host over https gets the token (unchanged)", async () => {
      await authGitLab(httpsHost)
      const repo = checkout(`https://${httpsHost}/acme/infra.git`)
      await invoke("git:push", { worktreePath: repo, branchName: "main", provider: "gitlab" })
      expect(sinksOf(GITLAB_TOKEN)).toEqual([`git https://${httpsHost}`])
    })

    it("an origin on another host is refused: the token reaches neither its API nor the remote", async () => {
      await authGitLab("gitlab.com")
      const origin = `https://${httpsHost}/acme/infra.git`

      const push = await invoke("git:push", {
        worktreePath: checkout(origin),
        branchName: "main",
        provider: "gitlab",
      })
      const seed = await invoke("git:init-default-branch", {
        worktreePath: checkout(origin, { empty: true }),
        branch: "main",
        provider: "gitlab",
      })
      const mr = await mergeRequest(checkout(origin))

      expect(sinksOf(GITLAB_TOKEN)).toEqual([])
      expect(fetchCalls).toEqual([])
      for (const result of [push, seed, mr]) {
        expect(result.error).toContain("gitlab.com")
        expect(result.error).toContain(httpsHost)
      }
    })

    it("an origin over plain http is refused, even on the bound host", async () => {
      await authGitLab(httpHost)
      const origin = `http://${httpHost}/acme/infra.git`

      const push = await invoke("git:push", {
        worktreePath: checkout(origin),
        branchName: "main",
        provider: "gitlab",
      })
      const seed = await invoke("git:init-default-branch", {
        worktreePath: checkout(origin, { empty: true }),
        branch: "main",
        provider: "gitlab",
      })
      const mr = await mergeRequest(checkout(origin))

      expect(sinksOf(GITLAB_TOKEN)).toEqual([])
      expect(fetchCalls).toEqual([])
      for (const result of [push, seed, mr]) expect(result.error).toContain("plain http")
    })

    it("a plain-http origin's error names its host, never the URL, which may carry credentials", async () => {
      await authGitLab(httpHost)
      await authGitHub(httpHost)
      // Userinfo someone embedded in the origin URL, built at runtime.
      const userinfo = ["deploy", "origin-secret"].join(":")
      const origin = `http://${userinfo}@${httpHost}/acme/infra.git`

      for (const provider of ["gitlab", "github"] as const) {
        const push = await invoke("git:push", {
          worktreePath: checkout(origin),
          branchName: "main",
          provider,
        })
        expect(push.error).toContain(`origin on ${httpHost} uses plain http`)
        expect(push.error).not.toContain("origin-secret")
        expect(push.error).not.toContain("/acme/infra.git")
      }
      expect(plainRemote.seen).toEqual([])
    })

    it("an SSH origin on a non-default port matches the bound host: the SSH port is not the API port", async () => {
      // GitLab's own clone URL when gitlab_shell_ssh_port is not 22.
      await authGitLab("gitlab.corp")
      const origin = "ssh://git@gitlab.corp:2222/team/infra.git"
      // Fetch URL over SSH; pushes go to a bare repo of this test's own.
      const pushUrl = nodePath.join(workDir, "ssh-port.git")
      git(workDir, "init", "--bare", pushUrl)

      const push = await invoke("git:push", {
        worktreePath: checkout(origin, { pushUrl }),
        branchName: "main",
        provider: "gitlab",
      })
      const seed = await invoke("git:init-default-branch", {
        worktreePath: checkout(origin, { empty: true, pushUrl }),
        branch: "seed",
        provider: "gitlab",
      })
      const mr = await mergeRequest(checkout(origin, { pushUrl }))

      expect(push.error).toBeUndefined()
      expect(seed.error).toBeUndefined()
      expect(mr).toEqual({ url: "https://example.test/mr/1", number: 1 })
      // The API calls (commit author, the MR) go to the instance's https
      // origin, not to https://gitlab.corp:2222.
      expect(sinksOf(GITLAB_TOKEN)).toEqual(["api https://gitlab.corp"])
    })

    it("merge request: origin on the bound host still opens it via that host's API (unchanged)", async () => {
      await authGitLab(httpsHost)
      // Fetch URL on the bound host; pushes go to a local bare repo.
      const repo = checkout(`https://${httpsHost}/acme/infra.git`, { pushUrl: bareRemote })
      const mr = await mergeRequest(repo)
      expect(mr).toEqual({ url: "https://example.test/mr/1", number: 1 })
      expect(sinksOf(GITLAB_TOKEN)).toEqual([`api https://${httpsHost}`])
    })
  })

  describe("GitLab host binding — a script cannot move it; an inherited env follows glab's host vars", () => {
    it("a script that points GITLAB_HOST at another host does not carry the auth block's token there", async () => {
      await authGitLab("gitlab.com")
      await scriptExportsGitLabHost(httpsHost)

      await clone(`https://${httpsHost}/acme/infra.git`, "gitlab")
      const origin = `https://${httpsHost}/acme/infra.git`
      const push = await invoke("git:push", {
        worktreePath: checkout(origin),
        branchName: "main",
        provider: "gitlab",
      })
      const mr = await mergeRequest(checkout(origin))

      expect(tlsRemote.seen.length).toBeGreaterThan(0) // the clone did reach the remote
      expect(sinksOf(GITLAB_TOKEN)).toEqual([])
      expect(fetchCalls).toEqual([])
      for (const result of [push, mr]) expect(result.error).toContain("not bound to a host")
    })

    it("a script that names the auth block's host in URL form keeps the binding", async () => {
      await authGitLab(httpsHost)
      await scriptExportsGitLabHost(`https://${httpsHost}/`)
      const repo = checkout(`https://${httpsHost}/acme/infra.git`)
      await invoke("git:push", { worktreePath: repo, branchName: "main", provider: "gitlab" })
      expect(sinksOf(GITLAB_TOKEN)).toEqual([`git https://${httpsHost}`])
    })

    it("an inherited GITLAB_HOST in URL form, or GL_HOST, binds the inherited token to that host", async () => {
      const hostVarSets: Array<Record<string, string>> = [
        { GITLAB_HOST: `https://${httpsHost}` },
        { GL_HOST: httpsHost },
      ]
      for (const hostVars of hostVarSets) {
        tlsRemote.seen.length = 0
        await inheritedSession({ GITLAB_TOKEN, ...hostVars })
        const repo = checkout(`https://${httpsHost}/acme/infra.git`)
        const push = await invoke("git:push", {
          worktreePath: repo,
          branchName: "main",
          provider: "gitlab",
        })
        expect(push.error ?? "").not.toContain("credential")
        expect(sinksOf(GITLAB_TOKEN)).toEqual([`git https://${httpsHost}`])
      }
    })

    it("an inherited GL_HOST keeps the inherited token away from any other host, and names its host", async () => {
      await inheritedSession({ GITLAB_TOKEN, GL_HOST: "gitlab.corp.example" })
      const push = await invoke("git:push", {
        worktreePath: checkout(`https://${httpsHost}/acme/infra.git`),
        branchName: "main",
        provider: "gitlab",
      })
      expect(sinksOf(GITLAB_TOKEN)).toEqual([])
      expect(push.error).toContain("is for gitlab.corp.example")
    })
  })

  describe("git:push — GitHub token bound to origin", () => {
    it("an http origin on the bound host is refused", async () => {
      await authGitHub(httpHost)
      const repo = checkout(`http://${httpHost}/acme/infra.git`)
      const push = await invoke("git:push", {
        worktreePath: repo,
        branchName: "main",
        provider: "github",
      })
      expect(sinksOf(GITHUB_TOKEN)).toEqual([])
      expect(push.error).toContain("plain http")
    })

    it("an SSH origin on a non-default port matches the bound host", async () => {
      await authGitHub("github.corp")
      const pushUrl = nodePath.join(workDir, "ssh-port.git")
      git(workDir, "init", "--bare", pushUrl)
      const repo = checkout("ssh://git@github.corp:2222/acme/infra.git", { pushUrl })
      const push = await invoke("git:push", {
        worktreePath: repo,
        branchName: "main",
        provider: "github",
      })
      expect(push.error).toBeUndefined()
    })
  })
})

describe("git:delete-branch", () => {
  let repo = ""

  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: repo,
      stdio: "pipe",
    }).toString()

  beforeEach(async () => {
    repo = fs.realpathSync(
      fs.mkdtempSync(nodePath.join(os.tmpdir(), "runbooks-git-delete-branch-")),
    )
    git("init", "-q", "-b", "main")
    git("commit", "-q", "--allow-empty", "-m", "initial")
    git("branch", "feature")
    await Effect.runPromise(
      sessionManager.createSession(repo).pipe(Effect.provide(makeTestEnvironment({}))),
    )
  })

  afterEach(() => {
    sessionManager.deleteSession()
    fs.rmSync(repo, { recursive: true, force: true })
  })

  it("deletes the branch and returns { ok: true }, matching the channel contract", async () => {
    const result = await handlers.get("git:delete-branch")!(event, {
      worktreePath: repo,
      branch: "feature",
    })

    expect(result).toEqual({ ok: true })
    expect(git("branch", "--list", "feature").trim()).toBe("")
  })
})

// A Data.TaggedError without a `message` field (SessionNotFoundError,
// SpawnError, FileReadError, ...) has an empty Error.message. Every git
// handler must still give the renderer text that names the failure: an empty
// rejection shows as "An unknown error occurred", and an empty { error } reads
// as no error at all (useGitPullRequest checks result.error for truthiness).
describe("git handler error text", () => {
  const sent: Array<{ channel: string; payload: { message?: string } }> = []
  const recordingEvent = {
    sender: {
      send: (channel: string, payload: { message?: string }) => sent.push({ channel, payload }),
    },
  }
  const prParams = {
    worktreePath: "/tmp/repo",
    owner: "o",
    repo: "r",
    title: "t",
    baseBranch: "main",
    headBranch: "feature",
    commitMessage: "m",
  }

  beforeEach(() => {
    sent.length = 0
    // No session, so every handler fails with SessionNotFoundError.
    sessionManager.deleteSession()
  })

  const rejectionOf = async (channel: string, params: unknown): Promise<string> => {
    try {
      await handlers.get(channel)!(recordingEvent, params)
    } catch (err) {
      return (err as Error).message
    }
    throw new Error(`expected ${channel} to reject`)
  }

  it("git:delete-branch and git:clone reject with a message that names the error", async () => {
    expect(
      await rejectionOf("git:delete-branch", { worktreePath: "/tmp/repo", branch: "feature" }),
    ).toBe("SessionNotFoundError")
    expect(await rejectionOf("git:clone", { url: "https://github.com/acme/infra.git" })).toBe(
      "SessionNotFoundError",
    )
  })

  it.each([
    ["git:push", { worktreePath: "/tmp/repo", branchName: "feature" }],
    ["git:init-default-branch", { worktreePath: "/tmp/repo", branch: "main" }],
    ["git:pull-request", prParams],
    ["git:merge-request", prParams],
  ])(
    "%s never returns { error: '' }, and its git:error event says the same",
    async (channel, params) => {
      const result = await handlers.get(channel)!(recordingEvent, params)

      expect(result).toEqual({ error: "SessionNotFoundError" })
      expect(sent.find((s) => s.channel === "git:error")?.payload.message).toBe(
        "SessionNotFoundError",
      )
    },
  )

  it("git:local-repo returns a fail status whose error names the error", async () => {
    const result = await handlers.get("git:local-repo")!(recordingEvent, { path: "/tmp/repo" })

    expect(result).toEqual({ status: "fail", error: "SessionNotFoundError" })
  })

  // A defect (here a non-string path, which makes path/string code throw
  // inside the Effect) must reach the renderer as its message only: Cause.pretty
  // stack frames belong in MAIN's log, not inline in a block.
  describe("a defect", () => {
    let dir = ""

    beforeEach(async () => {
      dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "runbooks-git-defect-")))
      await Effect.runPromise(
        sessionManager.createSession(dir).pipe(Effect.provide(makeTestEnvironment({}))),
      )
    })

    afterEach(() => {
      sessionManager.deleteSession()
      fs.rmSync(dir, { recursive: true, force: true })
    })

    const expectNoFrames = (message: string | undefined) => {
      expect(message).toBeTruthy()
      expect(message).not.toContain("    at ")
      expect(message).not.toContain("FiberFailure")
    }

    it.each([
      ["git:delete-branch", { worktreePath: 42, branch: "feature" }],
      ["git:clone", { url: "https://github.com/acme/infra.git", localPath: 42 }],
    ])("%s rejects with the defect's message and no stack frames", async (channel, params) => {
      const message = await rejectionOf(channel, params)

      expectNoFrames(message)
      // Node says "argument", bun "property".
      expect(message).toMatch(/^The "path" (argument|property) must be of type string/)
    })

    it.each([
      ["git:push", { worktreePath: 42, branchName: "feature" }],
      ["git:init-default-branch", { worktreePath: 42, branch: "main" }],
      ["git:pull-request", { ...prParams, worktreePath: 42 }],
      ["git:merge-request", { ...prParams, worktreePath: 42 }],
    ])(
      "%s returns and emits the defect's message with no stack frames",
      async (channel, params) => {
        const result = (await handlers.get(channel)!(recordingEvent, params)) as { error?: string }

        expectNoFrames(result.error)
        expect(sent.find((s) => s.channel === "git:error")?.payload.message).toBe(result.error)
      },
    )

    it("git:local-repo returns the defect's message with no stack frames", async () => {
      const result = (await handlers.get("git:local-repo")!(recordingEvent, { path: 42 })) as {
        error?: string
      }

      expectNoFrames(result.error)
    })

    it("logs the defect's full Cause under the module's ipc:git logger, not a handler's", async () => {
      const consoleError = spyOn(console, "error").mockImplementation(() => {})
      try {
        await handlers.get("git:push")!(recordingEvent, { worktreePath: 42, branchName: "feature" })

        expect(consoleError).toHaveBeenCalledWith(
          "[ipc:git]",
          "git handler defect:",
          expect.stringContaining('The "path"'),
        )
      } finally {
        consoleError.mockRestore()
      }
    })
  })
})
