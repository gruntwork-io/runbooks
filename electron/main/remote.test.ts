import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { execFileSync } from "node:child_process"
import * as nodeFs from "node:fs"
import * as nodePath from "node:path"
import * as os from "node:os"
import { Cause, Effect, Exit, Layer } from "effect"
import {
  isAuthError,
  authHintForHost,
  classifyCloneError,
  cleanupTempClones,
  registerTempCloneDir,
  openRemoteRunbook,
  resolveRemoteRunbook,
  valueOrUserError,
} from "./remote.ts"
import { RemoteSourceError, SessionNotFoundError } from "../../src/errors/index.ts"
import { ChildProcessSpawnerLive } from "../../src/layers/ChildProcessSpawner.ts"
import { GitCliClientLive } from "../../src/layers/GitCliClient.ts"
import { NodeFileSystemLive } from "../../src/layers/NodeFileSystem.ts"
import { ProcessSpawner } from "../../src/services/ProcessSpawner.ts"
import type { SpawnOptions } from "../../src/services/ProcessSpawner.ts"
import { VcsCredentials } from "../../src/services/VcsCredentials.ts"
import type { VcsCredentialsShape } from "../../src/services/VcsCredentials.ts"

// ---------------------------------------------------------------------------
// isAuthError — the golang parity table (beta-v0.9.0 cmd/remote_open_test.go
// TestIsAuthError) plus this side's extra git patterns.
// ---------------------------------------------------------------------------

describe("isAuthError (golang parity)", () => {
  it.each([
    // golang table rows
    "fatal: Authentication failed for 'https://...'",
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    "fatal: repository 'https://github.com/...' not found (HTTP 404)",
    "remote: Repository not found.",
    "fatal: could not read from remote repository",
    "The requested URL returned error: 403",
    "AUTHENTICATION FAILED", // case insensitive
    // extra patterns this side recognizes
    "fatal: unable to access 'https://...': The requested URL returned error: 401",
    "remote: Invalid credentials",
    "fatal: Permission denied (publickey)",
    "error: RPC failed; HTTP 403 curl 22 The requested URL returned error: 403",
    "git@github.com: Permission denied (publickey,password).",
  ])("classifies %s as auth", (stderr) => {
    expect(isAuthError(stderr)).toBe(true)
  })

  it.each([
    "", // empty string
    "fatal: not a git repository", // normal git error
    "fatal: unable to access: connection timed out", // timeout error
    "fatal: unable to find a suitable file for index pack",
    // 401/403 outside an HTTP status: --progress counters, temp path, repo name
    "Cloning into '/tmp/runbooks-remote-ab403c/repo'...\nReceiving objects:  89% (403/452)\nfatal: early EOF",
    "fatal: unable to access 'https://github.com/acme/svc-4013.git/': Could not resolve host: github.com",
    // a filesystem permission error, not SSH's "Permission denied (<methods>)"
    "fatal: could not create work tree dir '/tmp/x/repo': Permission denied",
  ])("returns false for non-auth stderr: %s", (stderr) => {
    expect(isAuthError(stderr)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// authHintForHost — golang parity (TestAuthHintForHost)
// ---------------------------------------------------------------------------

describe("authHintForHost (golang parity)", () => {
  it.each([
    ["github.com", "GITHUB_TOKEN", "gh auth login"],
    ["gitlab.com", "GITLAB_TOKEN", "glab auth login"],
    ["GitHub.com", "GITHUB_TOKEN", "gh auth login"], // case-insensitive
    ["GitLab.com", "GITLAB_TOKEN", "glab auth login"],
  ])("%s → %s / %s", (host, envRemedy, cliCmd) => {
    expect(authHintForHost(host)).toEqual({ envRemedy, cliCmd })
  })

  it("returns undefined (empty hints) for unknown hosts", () => {
    expect(authHintForHost("bitbucket.org")).toBeUndefined()
  })

  it("includes --hostname and the GITLAB_HOST binding for self-hosted GitLab instances", () => {
    // GITLAB_TOKEN alone is only released to GITLAB_HOST's instance, so
    // the env remedy for a non-default host must name both halves.
    expect(authHintForHost("gitlab.corp.example")).toEqual({
      envRemedy: "GITLAB_TOKEN and GITLAB_HOST=gitlab.corp.example",
      cliCmd: "glab auth login --hostname gitlab.corp.example",
    })
  })
})

// ---------------------------------------------------------------------------
// classifyCloneError — golang parity (TestClassifyCloneError); the
// remote-open strings are contracts.
// ---------------------------------------------------------------------------

describe("classifyCloneError (golang parity)", () => {
  it("auth error without token gives the exact auth-required hint", () => {
    const result = classifyCloneError({
      host: "github.com",
      owner: "org",
      repo: "repo",
      stderr: "fatal: Authentication failed for 'https://github.com/org/repo.git'",
      hadToken: false,
    })
    expect(result.kind).toBe("auth")
    expect(result.hint).toBe(
      "authentication required for github.com/org/repo: set GITHUB_TOKEN, or run 'gh auth login'",
    )
  })

  it("auth error with token suggests the token may be expired", () => {
    const result = classifyCloneError({
      host: "github.com",
      owner: "org",
      repo: "repo",
      stderr: "fatal: Authentication failed",
      hadToken: true,
    })
    expect(result.hint).toBe(
      "authentication failed for github.com/org/repo (token may be invalid or expired): verify GITHUB_TOKEN, or re-run 'gh auth login'",
    )
  })

  it("uses the GitLab vocabulary for gitlab.com", () => {
    const result = classifyCloneError({
      host: "gitlab.com",
      owner: "group",
      repo: "proj",
      stderr: "fatal: Authentication failed",
      hadToken: false,
    })
    expect(result.hint).toBe(
      "authentication required for gitlab.com/group/proj: set GITLAB_TOKEN, or run 'glab auth login'",
    )
  })

  it("names the GITLAB_HOST binding for self-hosted GitLab hosts", () => {
    const result = classifyCloneError({
      host: "gitlab.corp.example",
      owner: "group",
      repo: "proj",
      stderr: "fatal: Authentication failed",
      hadToken: false,
    })
    expect(result.hint).toBe(
      "authentication required for gitlab.corp.example/group/proj: set GITLAB_TOKEN and GITLAB_HOST=gitlab.corp.example, or run 'glab auth login --hostname gitlab.corp.example'",
    )
  })

  it("falls back to the generic token hint for unknown hosts", () => {
    const result = classifyCloneError({
      host: "bitbucket.org",
      owner: "o",
      repo: "r",
      stderr: "fatal: Authentication failed",
      hadToken: false,
    })
    expect(result.hint).toBe(
      "authentication required for bitbucket.org/o/r: provide an access token for bitbucket.org",
    )
  })

  it("a 404 / repository-not-found is an AUTH signal (private repos present as 404)", () => {
    const result = classifyCloneError({
      host: "github.com",
      owner: "o",
      repo: "r",
      stderr: "remote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found",
      hadToken: false,
    })
    expect(result.kind).toBe("auth")
    expect(result.hint).toContain("authentication required for github.com/o/r")
  })

  it("classifies DNS / network errors", () => {
    const result = classifyCloneError({
      host: "github.com",
      owner: "o",
      repo: "r",
      stderr: "fatal: unable to access 'https://github.com/o/r': Could not resolve host: github.com",
      hadToken: false,
    })
    expect(result.kind).toBe("network")
  })

  it("classifies a DNS error as network even when the repo name contains 401/403", () => {
    const result = classifyCloneError({
      host: "github.com",
      owner: "acme",
      repo: "svc-4013",
      stderr: "fatal: unable to access 'https://github.com/acme/svc-4013.git/': Could not resolve host: github.com",
      hadToken: false,
    })
    expect(result.kind).toBe("network")
  })

  it("classifies connection refused as network", () => {
    const result = classifyCloneError({
      host: "github.com",
      owner: "o",
      repo: "r",
      stderr: "fatal: unable to access 'https://github.com/o/r': Failed to connect to host: Connection refused",
      hadToken: false,
    })
    expect(result.kind).toBe("network")
  })

  it("falls back to the golang failed-to-download wrapper for unrecognised stderr", () => {
    const result = classifyCloneError({
      host: "github.com",
      owner: "o",
      repo: "r",
      stderr: "fatal: index-pack failed",
      hadToken: false,
    })
    expect(result.kind).toBe("unknown")
    expect(result.hint).toBe("failed to download runbook: fatal: index-pack failed")
  })
})

// ---------------------------------------------------------------------------
// cleanupTempClones
// ---------------------------------------------------------------------------

describe("cleanupTempClones", () => {
  it("removes every registered temp dir", () => {
    const a = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "rb-temp-a-"))
    const b = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "rb-temp-b-"))
    nodeFs.writeFileSync(nodePath.join(a, "child.txt"), "x")
    registerTempCloneDir(a)
    registerTempCloneDir(b)

    cleanupTempClones()

    expect(nodeFs.existsSync(a)).toBe(false)
    expect(nodeFs.existsSync(b)).toBe(false)
  })

  it("tolerates a registered directory that was already deleted", () => {
    const a = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "rb-temp-c-"))
    registerTempCloneDir(a)
    // Pre-emptively remove the dir to simulate a prior cleanup.
    nodeFs.rmSync(a, { recursive: true, force: true })

    expect(() => cleanupTempClones()).not.toThrow()
    expect(nodeFs.existsSync(a)).toBe(false)
  })

  it("clears the internal registry so a second call is a no-op", () => {
    const a = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "rb-temp-d-"))
    registerTempCloneDir(a)
    cleanupTempClones()
    // After first cleanup the registry is empty — re-create the dir and call
    // cleanup again. The second call should NOT remove the recreated dir
    // (because it was never re-registered).
    nodeFs.mkdirSync(a, { recursive: true })
    cleanupTempClones()
    expect(nodeFs.existsSync(a)).toBe(true)
    nodeFs.rmSync(a, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// GitHub Enterprise hosts (GHES / ghe.com)
// ---------------------------------------------------------------------------

describe("authHintForHost — GitHub enterprise hosts", () => {
  it("GHES (provider github): GH_ENTERPRISE_TOKEN + GH_HOST binding and gh --hostname", () => {
    expect(authHintForHost("ghes.example.com", "github")).toEqual({
      envRemedy: "GH_ENTERPRISE_TOKEN and GH_HOST=ghes.example.com",
      cliCmd: "gh auth login --hostname ghes.example.com",
    })
    // lowercased, port kept
    expect(authHintForHost("GHES.example.com:8443", "github")).toEqual({
      envRemedy: "GH_ENTERPRISE_TOKEN and GH_HOST=ghes.example.com:8443",
      cliCmd: "gh auth login --hostname ghes.example.com:8443",
    })
  })

  it("GHES without provider detection gets no hint (an arbitrary name can't be placed)", () => {
    expect(authHintForHost("ghes.example.com")).toBeUndefined()
  })

  it("ghe.com tenant (by name, or provider github): GITHUB_TOKEN + GH_HOST binding", () => {
    const expected = {
      envRemedy: "GITHUB_TOKEN and GH_HOST=acme.ghe.com",
      cliCmd: "gh auth login --hostname acme.ghe.com",
    }
    expect(authHintForHost("acme.ghe.com")).toEqual(expected)
    expect(authHintForHost("acme.ghe.com", "github")).toEqual(expected)
  })

  it("github.com keeps its plain hint regardless of provider", () => {
    expect(authHintForHost("github.com", "github")).toEqual({ envRemedy: "GITHUB_TOKEN", cliCmd: "gh auth login" })
  })

  it("provider gitlab places an arbitrary host as GitLab", () => {
    expect(authHintForHost("git.corp.net", "gitlab")).toEqual({
      envRemedy: "GITLAB_TOKEN and GITLAB_HOST=git.corp.net",
      cliCmd: "glab auth login --hostname git.corp.net",
    })
  })
})

describe("classifyCloneError — threads provider", () => {
  const authFail = "fatal: Authentication failed"

  it("GHES with provider github, no token → GitHub enterprise hint", () => {
    const result = classifyCloneError({
      host: "ghes.example.com",
      owner: "o",
      repo: "r",
      stderr: authFail,
      hadToken: false,
      provider: "github",
    })
    expect(result).toEqual({
      kind: "auth",
      hint: "authentication required for ghes.example.com/o/r: set GH_ENTERPRISE_TOKEN and GH_HOST=ghes.example.com, or run 'gh auth login --hostname ghes.example.com'",
    })
  })

  it("GHES with provider github, with token → verify hint", () => {
    const result = classifyCloneError({
      host: "ghes.example.com",
      owner: "o",
      repo: "r",
      stderr: authFail,
      hadToken: true,
      provider: "github",
    })
    expect(result.hint).toBe(
      "authentication failed for ghes.example.com/o/r (token may be invalid or expired): verify GH_ENTERPRISE_TOKEN and GH_HOST=ghes.example.com, or re-run 'gh auth login --hostname ghes.example.com'",
    )
  })

  it("GHES without provider → generic hint", () => {
    const result = classifyCloneError({
      host: "ghes.example.com",
      owner: "o",
      repo: "r",
      stderr: authFail,
      hadToken: false,
    })
    expect(result.hint).toBe("authentication required for ghes.example.com/o/r: provide an access token for ghes.example.com")
  })

  it("ghe.com tenant", () => {
    const result = classifyCloneError({
      host: "acme.ghe.com",
      owner: "o",
      repo: "r",
      stderr: authFail,
      hadToken: false,
      provider: "github",
    })
    expect(result.hint).toBe(
      "authentication required for acme.ghe.com/o/r: set GITHUB_TOKEN and GH_HOST=acme.ghe.com, or run 'gh auth login --hostname acme.ghe.com'",
    )
  })
})

describe("classifyCloneError — SSH and owner-less sources", () => {
  it("an SSH auth failure points at the user's keys, not a token", () => {
    const result = classifyCloneError({
      host: "github.com",
      owner: "o",
      repo: "r",
      stderr: "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
      hadToken: false,
      provider: "github",
      transport: "ssh",
    })
    expect(result).toEqual({
      kind: "auth",
      hint: "SSH authentication failed for github.com/o/r: check that your SSH key is loaded (ssh-add) and has access to the repository, or use an https:// URL",
    })
  })

  it("an unknown SSH host key gets its own hint", () => {
    const result = classifyCloneError({
      host: "git.corp.net",
      owner: "o",
      repo: "r",
      stderr: "Host key verification failed.\nfatal: Could not read from remote repository.",
      hadToken: false,
      transport: "ssh",
    })
    expect(result.kind).toBe("auth")
    expect(result.hint).toContain("SSH host key for git.corp.net is not trusted yet")
  })

  it("scrubs tokens from git's stderr before showing it", () => {
    // Assembled at runtime so no credential-shaped literal sits in the source.
    const token = "ghp_" + "a".repeat(36)
    const result = classifyCloneError({
      host: "github.com",
      owner: "o",
      repo: "r",
      stderr: `fatal: unable to update url base from redirection: https://${["x-access-token", token].join(":")}@github.com/o/r.git`,
      hadToken: true,
    })
    expect(result.kind).toBe("unknown")
    expect(result.hint).not.toContain(token)
    expect(result.hint).toContain("[REDACTED]")
  })

  it("an http:// source, which never gets a token, is not told to set one", () => {
    const result = classifyCloneError({
      host: "github.com",
      owner: "o",
      repo: "r",
      stderr: "fatal: Authentication failed for 'http://github.com/o/r.git/'",
      hadToken: false,
      provider: "github",
      transport: "http",
    })
    expect(result).toEqual({
      kind: "auth",
      hint: "authentication required for github.com/o/r: access tokens are sent only over https, so use an https:// URL",
    })
  })

  it("a repo with no owner reads host/repo", () => {
    const result = classifyCloneError({
      host: "git.corp.net",
      owner: "",
      repo: "infra",
      stderr: "fatal: Authentication failed",
      hadToken: false,
    })
    expect(result.hint).toBe("authentication required for git.corp.net/infra: provide an access token for git.corp.net")
  })
})

// ---------------------------------------------------------------------------
// openRemoteRunbook — the whole remote open against real git. The true
// boundaries are replaced: the remote host (git's own url.<base>.insteadOf
// points it at a local fixture repo), ssh (a stub first on PATH), and the
// user's credential store (a VcsCredentials that hands out TOKEN for any host).
// ---------------------------------------------------------------------------

describe("openRemoteRunbook (real git)", () => {
  const TOKEN = "ghp_REMOTE_OPEN_TEST_TOKEN"
  const AUTH_HEADER = `Authorization: Basic ${btoa(`x-access-token:${TOKEN}`)}`
  const GIT = ["-c", "user.email=test@example.com", "-c", "user.name=Test", "-c", "commit.gpgsign=false"]
  const git = (cwd: string, ...args: string[]) => execFileSync("git", [...GIT, ...args], { cwd, stdio: "pipe" })

  let root = ""
  const savedEnv: Record<string, string | undefined> = {}
  const spawns: Array<{ args: string[]; env?: Record<string, string | undefined> }> = []
  const tokenLookups: string[] = []

  const spawnerLayer = Layer.effect(
    ProcessSpawner,
    Effect.map(ProcessSpawner, (live) => ({
      spawn: (command: string, args: string[], options?: SpawnOptions) => {
        if (command === "git") spawns.push({ args, env: options?.env })
        return live.spawn(command, args, options)
      },
    })),
  ).pipe(Layer.provide(ChildProcessSpawnerLive))
  const credentials = {
    enumerateGitHubHosts: () => Effect.succeed({ configHosts: [], defaultHost: "github.com" }),
    // Every host counts as GitHub, so only the transport decides whether a
    // token is looked up.
    detectProvider: () => Effect.succeed("github" as const),
    tokenForHost: (host: string) =>
      Effect.sync(() => {
        tokenLookups.push(host)
        return TOKEN
      }),
  } as unknown as VcsCredentialsShape
  const testLayer = Layer.mergeAll(
    GitCliClientLive.pipe(Layer.provide(spawnerLayer)),
    spawnerLayer,
    NodeFileSystemLive,
    Layer.succeed(VcsCredentials, credentials),
  )

  const open = async (source: string) =>
    valueOrUserError(await Effect.runPromiseExit(openRemoteRunbook(source).pipe(Effect.provide(testLayer))))
  const openError = async (source: string): Promise<Error> => {
    try {
      await open(source)
    } catch (err) {
      return err as Error
    }
    throw new Error(`expected ${source} to fail`)
  }
  /** Whether a `git <subcommand>` ran with TOKEN's auth header in its environment. */
  const sentToken = (subcommand: string) =>
    spawns.some(
      (s) => s.args[0] === subcommand && Object.values(s.env ?? {}).some((value) => value === AUTH_HEADER),
    )
  const tokenInAnyArg = () => spawns.some((s) => s.args.some((arg) => arg.includes(TOKEN)))

  const setEnv = (key: string, value: string) => {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key]
    process.env[key] = value
  }

  beforeAll(() => {
    root = nodeFs.realpathSync(nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "runbooks-remote-open-")))

    // Outside the clone: what a symlink in the repo points at.
    nodeFs.mkdirSync(nodePath.join(root, "outside"))
    nodeFs.writeFileSync(nodePath.join(root, "outside", "runbook.mdx"), "# outside\n")

    // The remote: git.example.com/org/repo.git.
    const repo = nodePath.join(root, "remotes", "org", "repo.git")
    nodeFs.mkdirSync(nodePath.join(repo, "runbooks", "vpc"), { recursive: true })
    nodeFs.mkdirSync(nodePath.join(repo, "docs"))
    nodeFs.writeFileSync(nodePath.join(repo, "README.md"), "readme\n")
    nodeFs.writeFileSync(nodePath.join(repo, "runbooks", "vpc", "runbook.mdx"), "# VPC\n")
    nodeFs.writeFileSync(nodePath.join(repo, "docs", "guide.md"), "# guide\n")
    nodeFs.symlinkSync(nodePath.join(root, "outside"), nodePath.join(repo, "runbooks", "escape"))
    git(repo, "init", "-b", "main")
    git(repo, "config", "uploadpack.allowFilter", "true")
    git(repo, "add", ".")
    git(repo, "commit", "-m", "initial")

    // ssh stub: fails the way a real ssh would, with whatever FAKE_SSH_STDERR says.
    const bin = nodePath.join(root, "bin")
    nodeFs.mkdirSync(bin)
    nodeFs.writeFileSync(nodePath.join(bin, "ssh"), '#!/bin/sh\necho "$FAKE_SSH_STDERR" >&2\nexit 255\n', { mode: 0o755 })
    setEnv("PATH", `${bin}${nodePath.delimiter}${process.env.PATH ?? ""}`)

    // Point https:// and http:// git.example.com at the fixture, appended to
    // any git config the environment already exports.
    const count = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? "", 10)
    const offset = Number.isInteger(count) && count > 0 ? count : 0
    const insteadOf = `url.file://${nodePath.join(root, "remotes")}/.insteadOf`
    setEnv(`GIT_CONFIG_KEY_${offset}`, insteadOf)
    setEnv(`GIT_CONFIG_VALUE_${offset}`, "https://git.example.com/")
    setEnv(`GIT_CONFIG_KEY_${offset + 1}`, insteadOf)
    setEnv(`GIT_CONFIG_VALUE_${offset + 1}`, "http://git.example.com/")
    setEnv("GIT_CONFIG_COUNT", String(offset + 2))
  })

  afterAll(() => {
    cleanupTempClones()
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    nodeFs.rmSync(root, { recursive: true, force: true })
  })

  beforeEach(() => {
    spawns.length = 0
    tokenLookups.length = 0
  })

  it("https: the ref lookup and the clone send the token, in the environment only", async () => {
    const source = "https://git.example.com/org/repo/tree/main/runbooks/vpc"
    const result = await open(source)

    expect(result.remoteSource).toBe(source)
    expect(result.localPath.endsWith(nodePath.join("runbooks", "vpc", "runbook.mdx"))).toBe(true)
    expect(nodeFs.readFileSync(result.localPath, "utf8")).toBe("# VPC\n")
    expect(tokenLookups).toEqual(["git.example.com"])
    expect(sentToken("ls-remote")).toBe(true)
    expect(sentToken("clone")).toBe(true)
    expect(tokenInAnyArg()).toBe(false)
  }, 30_000)

  it("the ref lookup and the clone both run the user's core.sshCommand, in batch mode", async () => {
    // A url.<ssh>.insteadOf rewrite sends even an https browser URL over ssh,
    // so the ls-remote must wrap the same ssh client as the clone.
    const count = Number(process.env.GIT_CONFIG_COUNT)
    const inheritedSshCommand = process.env.GIT_SSH_COMMAND
    delete process.env.GIT_SSH_COMMAND
    setEnv(`GIT_CONFIG_KEY_${count}`, "core.sshCommand")
    setEnv(`GIT_CONFIG_VALUE_${count}`, "ssh -i /keys/id_work")
    setEnv("GIT_CONFIG_COUNT", String(count + 1))
    try {
      await open("https://git.example.com/org/repo/tree/main/runbooks/vpc")
    } finally {
      setEnv("GIT_CONFIG_COUNT", String(count))
      if (inheritedSshCommand !== undefined) process.env.GIT_SSH_COMMAND = inheritedSshCommand
    }

    const sshCommandOf = (subcommand: string) =>
      spawns.find((s) => s.args[0] === subcommand)?.env?.GIT_SSH_COMMAND
    expect(sshCommandOf("ls-remote")).toBe("ssh -i /keys/id_work -o BatchMode=yes -o StrictHostKeyChecking=yes")
    expect(sshCommandOf("clone")).toBe("ssh -i /keys/id_work -o BatchMode=yes -o StrictHostKeyChecking=yes")
  }, 30_000)

  it("http:// never looks up or sends a token", async () => {
    const result = await open("git::http://git.example.com/org/repo.git//runbooks/vpc")

    expect(nodeFs.readFileSync(result.localPath, "utf8")).toBe("# VPC\n")
    expect(tokenLookups).toEqual([])
    expect(sentToken("clone")).toBe(false)
  }, 30_000)

  it("an http:// auth failure says tokens need https, not which token to set", async () => {
    // The fixture has no such repo; git's "Could not read from remote
    // repository" reads as an auth failure.
    const err = await openError("git::http://git.example.com/org/missing.git//runbooks/vpc")
    expect(err.message).toBe(
      "authentication required for git.example.com/org/missing: access tokens are sent only over https, so use an https:// URL",
    )
  }, 30_000)

  it.each([
    [
      "ssh://git@git.example.com/org/repo.git//runbooks/vpc",
      "Host key verification failed.",
      "the SSH host key for git.example.com is not trusted yet",
    ],
    [
      "git@git.example.com:org/repo.git//runbooks/vpc",
      "git@git.example.com: Permission denied (publickey).",
      "SSH authentication failed for git.example.com/org/repo: check that your SSH key is loaded",
    ],
  ])("%s goes over ssh with no token, and its failure gets the SSH hint", async (source, sshStderr, hint) => {
    setEnv("FAKE_SSH_STDERR", sshStderr)
    const err = await openError(source)

    expect(err.message).toContain(hint)
    expect(tokenLookups).toEqual([])
    expect(sentToken("clone")).toBe(false)
  }, 30_000)

  it("a failed ref lookup gets the classified hint and never clones on a guessed ref", async () => {
    // The fixture has no such repo, so the ls-remote that splits the browser
    // URL's ref and path fails ("Could not read from remote repository").
    const err = await openError("https://git.example.com/org/missing/tree/main/runbooks/vpc")

    expect(err.message).toBe(
      "authentication failed for git.example.com/org/missing (token may be invalid or expired): " +
        "verify GH_ENTERPRISE_TOKEN and GH_HOST=git.example.com, or re-run 'gh auth login --hostname git.example.com'",
    )
    expect(spawns.some((s) => s.args[0] === "ls-remote")).toBe(true)
    expect(spawns.some((s) => s.args[0] === "clone")).toBe(false)
  }, 30_000)

  it("a path that isn't in the repo is reported as not found at its ref", async () => {
    const err = await openError("git::https://git.example.com/org/repo.git//runbooks/missing?ref=main")
    expect(err.message).toBe('"runbooks/missing" was not found in git.example.com/org/repo at main')
  }, 30_000)

  it("a directory without a runbook.mdx is reported, including the repo root", async () => {
    expect((await openError("git::https://git.example.com/org/repo.git//docs")).message).toBe(
      'no runbook.mdx in "docs" of git.example.com/org/repo',
    )
    expect((await openError("git::https://git.example.com/org/repo.git")).message).toBe(
      "no runbook.mdx in the root of git.example.com/org/repo",
    )
  }, 30_000)

  it("a symlink in the repo can't open a runbook outside the clone", async () => {
    const err = await openError("git::https://git.example.com/org/repo.git//runbooks/escape")
    expect(err.message).toBe('"runbooks/escape" in git.example.com/org/repo points outside the repository')
  }, 30_000)
})

describe("valueOrUserError / resolveRemoteRunbook", () => {
  it("returns a success value", () => {
    expect(valueOrUserError(Exit.succeed(42))).toBe(42)
  })

  it("rejects a typed failure with its bare message, not a FiberFailure", () => {
    const exit = Exit.fail(new RemoteSourceError({ url: "x", message: '"a" was not found in h/o/r' }))
    expect(() => valueOrUserError(exit)).toThrow(new Error('"a" was not found in h/o/r'))
  })

  /** The message valueOrUserError rejects a failed Exit with. */
  const userErrorOf = (exit: Exit.Exit<unknown, unknown>): string => {
    try {
      valueOrUserError(exit)
    } catch (err) {
      return (err as Error).message
    }
    throw new Error("expected valueOrUserError to throw")
  }

  it("describes a defect by its message, with no stack frames", () => {
    const message = userErrorOf(Exit.failCause(Cause.die(new Error("boom"))))
    expect(message).toBe("boom")
    expect(message).not.toContain("    at ")
  })

  it("names a typed failure that has no message", () => {
    expect(userErrorOf(Exit.fail(new SessionNotFoundError()))).toBe("SessionNotFoundError")
  })

  it("resolveRemoteRunbook rejects on the app runtime with the parser's message", async () => {
    const err = await resolveRemoteRunbook("https://bitbucket.org/o/r").then(
      () => undefined,
      (e: unknown) => e as Error,
    )
    expect(err).toBeInstanceOf(Error)
    expect(err?.message.startsWith("unsupported URL format")).toBe(true)
  })
})
