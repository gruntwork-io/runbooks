import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import * as nodeFs from "node:fs"
import * as nodeNet from "node:net"
import * as os from "node:os"
import * as nodePath from "node:path"
import { Effect, Layer } from "effect"
import { ProcessSpawner, type SpawnOptions } from "@runbooks/core/services/ProcessSpawner"
import { VcsCredentials, type VcsCredentialsShape } from "@runbooks/core/services/VcsCredentials"
import { ChildProcessSpawnerLive } from "@runbooks/platform-node/layers/ChildProcessSpawner"
import { GitCliClientLive } from "@runbooks/platform-node/layers/GitCliClient"
import { NodeFileSystemLive } from "@runbooks/platform-node/layers/NodeFileSystem"
import { ProcessEnvironmentLive } from "@runbooks/platform-node/layers/ProcessEnvironment"
import {
  authHintForHost,
  classifyCloneError,
  clonesFolder,
  isAuthError,
  removeClones,
  resolveRemoteRunbook,
} from "./remoteRunbook.ts"

// ---------------------------------------------------------------------------
// isAuthError: the golang parity table (beta-v0.9.0 cmd/remote_open_test.go
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
// authHintForHost: golang parity (TestAuthHintForHost)
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
// classifyCloneError: golang parity (TestClassifyCloneError); the
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
      stderr:
        "remote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found",
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
      stderr:
        "fatal: unable to access 'https://github.com/o/r': Could not resolve host: github.com",
      hadToken: false,
    })
    expect(result.kind).toBe("network")
  })

  it("names the host and the seconds when an http transfer stalls", () => {
    const result = classifyCloneError({
      host: "github.com",
      owner: "o",
      repo: "r",
      stderr:
        "fatal: unable to access 'https://github.com/o/r/': Operation too slow. Less than 1 bytes/sec transferred the last 30 seconds",
      hadToken: true,
    })
    expect(result).toEqual({
      kind: "network",
      hint: "github.com sent nothing for 30 seconds, so Runbooks gave up. Check your internet connection or proxy.",
    })
  })

  it("names the host when an ssh connection stops answering", () => {
    const result = classifyCloneError({
      host: "github.com",
      owner: "o",
      repo: "r",
      stderr:
        "Timeout, server github.com not responding.\nfatal: Could not read from remote repository.",
      hadToken: false,
      transport: "ssh",
    })
    expect(result).toEqual({
      kind: "network",
      hint: "github.com stopped answering, so Runbooks gave up. Check your internet connection or proxy.",
    })
  })

  it("classifies curl's failure to connect as network", () => {
    const result = classifyCloneError({
      host: "github.com",
      owner: "o",
      repo: "r",
      stderr:
        "fatal: unable to access 'https://github.com/o/r/': Failed to connect to github.com port 443 after 75001 ms: Couldn't connect to server",
      hadToken: false,
    })
    expect(result.kind).toBe("network")
  })

  it("classifies a DNS error as network even when the repo name contains 401/403", () => {
    const result = classifyCloneError({
      host: "github.com",
      owner: "acme",
      repo: "svc-4013",
      stderr:
        "fatal: unable to access 'https://github.com/acme/svc-4013.git/': Could not resolve host: github.com",
      hadToken: false,
    })
    expect(result.kind).toBe("network")
  })

  it("classifies connection refused as network", () => {
    const result = classifyCloneError({
      host: "github.com",
      owner: "o",
      repo: "r",
      stderr:
        "fatal: unable to access 'https://github.com/o/r': Failed to connect to host: Connection refused",
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
// GitHub Enterprise hosts (GHES / ghe.com)
// ---------------------------------------------------------------------------

describe("authHintForHost: GitHub enterprise hosts", () => {
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
    expect(authHintForHost("github.com", "github")).toEqual({
      envRemedy: "GITHUB_TOKEN",
      cliCmd: "gh auth login",
    })
  })

  it("provider gitlab places an arbitrary host as GitLab", () => {
    expect(authHintForHost("git.corp.net", "gitlab")).toEqual({
      envRemedy: "GITLAB_TOKEN and GITLAB_HOST=git.corp.net",
      cliCmd: "glab auth login --hostname git.corp.net",
    })
  })
})

describe("classifyCloneError: threads provider", () => {
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
    expect(result.hint).toBe(
      "authentication required for ghes.example.com/o/r: provide an access token for ghes.example.com",
    )
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

describe("classifyCloneError: SSH and owner-less sources", () => {
  it("an SSH auth failure points at the user's keys, not a token", () => {
    const result = classifyCloneError({
      host: "github.com",
      owner: "o",
      repo: "r",
      stderr:
        "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
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

  it.each([
    "ssh: Could not resolve hostname git.corp.net: nodename nor servname provided, or not known",
    "ssh: connect to host git.corp.net port 22: Connection refused",
  ])("an SSH network failure is a network error, not a key problem: %s", (sshStderr) => {
    // After any ssh failure git adds "Could not read from remote repository",
    // which on its own reads as an auth failure.
    const result = classifyCloneError({
      host: "git.corp.net",
      owner: "o",
      repo: "r",
      stderr:
        `${sshStderr}\nfatal: Could not read from remote repository.\n\n` +
        "Please make sure you have the correct access rights\nand the repository exists.",
      hadToken: false,
      transport: "ssh",
    })
    expect(result).toEqual({
      kind: "network",
      hint: "Could not reach git.corp.net. Check your internet connection.",
    })
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
    expect(result.hint).toBe(
      "authentication required for git.corp.net/infra: provide an access token for git.corp.net",
    )
  })
})

// ---------------------------------------------------------------------------
// The clones folder
// ---------------------------------------------------------------------------

describe("clonesFolder", () => {
  it("is v0/clones in the user data folder", () => {
    expect(clonesFolder("/data/runbooks")).toBe(nodePath.join("/data/runbooks", "v0", "clones"))
  })
})

describe("removeClones", () => {
  let folder = ""
  beforeEach(() => {
    folder = nodeFs.realpathSync(nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "runbooks-clones-")))
  })
  afterEach(() => nodeFs.rmSync(folder, { recursive: true, force: true }))

  const remove = (clones: string) =>
    Effect.runPromise(removeClones(clones).pipe(Effect.provide(NodeFileSystemLive)))

  it("removes every clone, and does nothing when there are none", async () => {
    const clones = nodePath.join(folder, "clones")
    nodeFs.mkdirSync(nodePath.join(clones, "one", "repo"), { recursive: true })
    nodeFs.writeFileSync(nodePath.join(clones, "one", "repo", "runbook.mdx"), "# One\n")
    nodeFs.mkdirSync(nodePath.join(clones, "two"))

    await remove(clones)
    expect(nodeFs.readdirSync(folder)).toEqual([])
    await remove(clones)
    expect(nodeFs.readdirSync(folder)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// resolveRemoteRunbook: the whole remote open against real git. The true
// boundaries are replaced: the remote host (git's own url.<base>.insteadOf,
// in a global config of the test's own, points it at a local fixture repo),
// ssh (a stub first on PATH), and the user's credential store (a
// VcsCredentials that hands out TOKEN for any host).
// ---------------------------------------------------------------------------

describe("resolveRemoteRunbook (real git)", () => {
  const TOKEN = "ghp_REMOTE_OPEN_TEST_TOKEN"
  const AUTH_HEADER = `Authorization: Basic ${btoa(`x-access-token:${TOKEN}`)}`
  const GIT = [
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test",
    "-c",
    "commit.gpgsign=false",
  ]
  // The sandboxed environment, passed explicitly: under Bun a child
  // otherwise gets the environment the process started with.
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", [...GIT, ...args], { cwd, stdio: "pipe", env: process.env })

  let root = ""
  let clones = ""
  const savedEnv: Record<string, string | undefined> = {}
  const spawns: Array<{ args: string[]; env?: Record<string, string | undefined> | undefined }> = []
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
  const credentials: VcsCredentialsShape = {
    enumerateGitHubHosts: () => Effect.succeed({ configHosts: [], defaultHost: "github.com" }),
    // Every host counts as GitHub, so only the transport decides whether a
    // token is looked up.
    detectProvider: () => Effect.succeed("github" as const),
    tokenForHost: (host: string) =>
      Effect.sync(() => {
        tokenLookups.push(host)
        return TOKEN
      }),
    // The rest aren't reached by a clone.
    detectGitHubEnv: () => Effect.die("detectGitHubEnv not used"),
    detectGitHubCli: () => Effect.die("detectGitHubCli not used"),
    detectGitLabEnv: () => Effect.die("detectGitLabEnv not used"),
    detectGitLabCli: () => Effect.die("detectGitLabCli not used"),
    validateDirect: () => Effect.die("validateDirect not used"),
    enumerateGitLabHosts: () => Effect.die("enumerateGitLabHosts not used"),
    validateViaCli: () => Effect.die("validateViaCli not used"),
    cliStatus: () => Effect.die("cliStatus not used"),
    invalidateCache: () => Effect.die("invalidateCache not used"),
    markTransportDegraded: () => Effect.die("markTransportDegraded not used"),
  }
  const testLayer = Layer.mergeAll(
    GitCliClientLive.pipe(Layer.provide(spawnerLayer)),
    spawnerLayer,
    NodeFileSystemLive,
    ProcessEnvironmentLive,
    Layer.succeed(VcsCredentials, credentials),
  )

  const openIn = (folder: string, source: string) =>
    Effect.runPromise(resolveRemoteRunbook(source, folder).pipe(Effect.provide(testLayer)))
  const open = (source: string) => openIn(clones, source)
  const openErrorIn = (folder: string, source: string) =>
    Effect.runPromise(
      Effect.flip(resolveRemoteRunbook(source, folder)).pipe(Effect.provide(testLayer)),
    )
  const openError = (source: string) => openErrorIn(clones, source)
  /** Whether a `git <subcommand>` ran with TOKEN's auth header in its environment. */
  const sentToken = (subcommand: string) =>
    spawns.some(
      (s) =>
        s.args[0] === subcommand &&
        Object.values(s.env ?? {}).some((value) => value === AUTH_HEADER),
    )
  const tokenInAnyArg = () => spawns.some((s) => s.args.some((arg) => arg.includes(TOKEN)))

  /** Sets (or, with undefined, unsets) a variable until the describe ends. */
  const setEnv = (key: string, value: string | undefined) => {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  beforeAll(() => {
    root = nodeFs.realpathSync(
      nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "runbooks-remote-open-")),
    )
    clones = nodePath.join(root, "user data", "v0", "clones")

    // git runs sandboxed: a HOME of its own, the test's global config and no
    // system config, and only the file and ssh transports, so no test can
    // reach a real host over http(s). Nothing inherited picks the ssh client.
    const home = nodePath.join(root, "home")
    nodeFs.mkdirSync(home)
    const remotes = nodePath.join(root, "remotes")
    const gitconfig = nodePath.join(root, "gitconfig")
    nodeFs.writeFileSync(
      gitconfig,
      `[url "file://${remotes}/"]\n` +
        "\tinsteadOf = https://git.example.com/\n" +
        "\tinsteadOf = http://git.example.com/\n",
    )
    setEnv("HOME", home)
    setEnv("GIT_CONFIG_GLOBAL", gitconfig)
    setEnv("GIT_CONFIG_NOSYSTEM", "1")
    setEnv("GIT_ALLOW_PROTOCOL", "file:ssh")
    for (const name of [
      "GIT_SSH_COMMAND",
      "GIT_SSH",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_PARAMETERS",
      "GIT_CEILING_DIRECTORIES",
      "GIT_DIR",
      "GIT_WORK_TREE",
    ])
      setEnv(name, undefined)

    // ssh stub: fails the way a real ssh would, with whatever FAKE_SSH_STDERR says.
    const bin = nodePath.join(root, "bin")
    nodeFs.mkdirSync(bin)
    nodeFs.writeFileSync(
      nodePath.join(bin, "ssh"),
      '#!/bin/sh\necho "$FAKE_SSH_STDERR" >&2\nexit 255\n',
      { mode: 0o755 },
    )
    setEnv("PATH", `${bin}${nodePath.delimiter}${process.env.PATH ?? ""}`)

    // Outside the clone: what a symlink in the repo points at.
    nodeFs.mkdirSync(nodePath.join(root, "outside"))
    nodeFs.writeFileSync(nodePath.join(root, "outside", "runbook.mdx"), "# outside\n")

    // The remote: git.example.com/org/repo.git.
    const repo = nodePath.join(remotes, "org", "repo.git")
    nodeFs.mkdirSync(nodePath.join(repo, "runbooks", "vpc"), { recursive: true })
    nodeFs.mkdirSync(nodePath.join(repo, "docs"))
    nodeFs.writeFileSync(nodePath.join(repo, "README.md"), "readme\n")
    nodeFs.writeFileSync(nodePath.join(repo, "runbooks", "vpc", "runbook.mdx"), "# VPC\n")
    nodeFs.writeFileSync(nodePath.join(repo, "docs", "guide.md"), "# guide\n")
    nodeFs.symlinkSync(nodePath.join(root, "outside"), nodePath.join(repo, "runbooks", "escape"))
    git(repo, "init", "-b", "main")
    git(repo, "add", ".")
    git(repo, "commit", "-m", "initial")

    // Remotes with their runbook at the root: git.example.com/org/setup-vpc.git,
    // and org/aux.git, whose name Windows reserves for a device.
    for (const [name, heading] of [
      ["setup-vpc", "Setup VPC"],
      ["aux", "Aux"],
    ]) {
      const rootRunbookRepo = nodePath.join(remotes, "org", `${name}.git`)
      nodeFs.mkdirSync(rootRunbookRepo)
      nodeFs.writeFileSync(nodePath.join(rootRunbookRepo, "runbook.mdx"), `# ${heading}\n`)
      git(rootRunbookRepo, "init", "-b", "main")
      git(rootRunbookRepo, "add", ".")
      git(rootRunbookRepo, "commit", "-m", "initial")
    }
  })

  afterAll(() => {
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
    const runbook = await open("https://git.example.com/org/repo/tree/main/runbooks/vpc")

    expect(runbook.endsWith(nodePath.join("runbooks", "vpc", "runbook.mdx"))).toBe(true)
    expect(nodeFs.readFileSync(runbook, "utf8")).toBe("# VPC\n")
    expect(tokenLookups).toEqual(["git.example.com"])
    expect(sentToken("ls-remote")).toBe(true)
    expect(sentToken("clone")).toBe(true)
    expect(tokenInAnyArg()).toBe(false)
  }, 30_000)

  it.each([
    ["go-getter subdirectory", "git::https://git.example.com/org/repo.git//runbooks/vpc?ref=main"],
    ["browser directory URL", "https://git.example.com/org/repo/tree/main/runbooks/vpc"],
  ])(
    "a %s checks out the whole repo, so the runbook can use files outside its directory",
    async (_kind, source) => {
      const runbook = await open(source)

      const repoRoot = nodePath.resolve(nodePath.dirname(runbook), "..", "..")
      expect(nodeFs.readFileSync(nodePath.join(repoRoot, "docs", "guide.md"), "utf8")).toBe(
        "# guide\n",
      )
      expect(nodeFs.readFileSync(nodePath.join(repoRoot, "README.md"), "utf8")).toBe("readme\n")
    },
    30_000,
  )

  it("clones into a folder named after the repo, so a runbook at its root is named after it", async () => {
    const runbook = await open("git::https://git.example.com/org/setup-vpc.git")

    expect(nodePath.basename(nodePath.dirname(runbook))).toBe("setup-vpc")
    expect(nodeFs.readFileSync(runbook, "utf8")).toBe("# Setup VPC\n")
  }, 30_000)

  it("clones a repo named for a Windows device into a folder named repo, which Windows allows", async () => {
    const runbook = await open("git::https://git.example.com/org/aux.git")

    expect(nodePath.basename(nodePath.dirname(runbook))).toBe("repo")
    expect(nodeFs.readFileSync(runbook, "utf8")).toBe("# Aux\n")
  }, 30_000)

  it("clones into a folder of its own in the clones folder, readable by its owner only", async () => {
    const source = "git::https://git.example.com/org/setup-vpc.git"
    const first = await open(source)
    const second = await open(source)

    expect(second).not.toBe(first)
    for (const runbook of [first, second]) {
      const own = nodePath.dirname(nodePath.dirname(runbook))
      expect(nodePath.dirname(own)).toBe(clones)
      expect(nodeFs.statSync(own).mode & 0o777).toBe(0o700)
    }
  }, 30_000)

  it("a failed open leaves nothing in the clones folder", async () => {
    const folder = nodePath.join(root, "failing clones")
    await openErrorIn(folder, "git::https://git.example.com/org/missing.git")
    await openErrorIn(folder, "git::https://git.example.com/org/repo.git//docs")

    expect(nodeFs.readdirSync(folder)).toEqual([])
  }, 30_000)

  it("reports the source without a password typed into it, even one holding an @", async () => {
    // Built at runtime so secret scanners don't flag the fixture.
    const password = ["p@hunter", "22"].join("")
    const runbook = await open(
      `https://user:${password}@git.example.com/org/repo/tree/main/runbooks/vpc`,
    )
    const failed = await openError(
      `https://user:${password}@git.example.com/org/missing/tree/main/runbooks/vpc`,
    )

    expect(nodeFs.readFileSync(runbook, "utf8")).toBe("# VPC\n")
    expect(failed.url).toBe("https://git.example.com/org/missing/tree/main/runbooks/vpc")
    expect(`${failed.url} ${failed.message}`).not.toContain("hunter")
  }, 30_000)

  it("reports the source without go-getter's sshkey (a private key)", async () => {
    const sshKey = ["c3NoLWtl", "eQ+/ZmFrZQ=="].join("")
    const runbook = await open(
      `git::https://git.example.com/org/repo.git//runbooks/vpc?ref=main&sshkey=${sshKey}`,
    )
    const failed = await openError(
      `git::https://git.example.com/org/missing.git//runbooks/vpc?ref=main&sshkey=${sshKey}`,
    )

    expect(nodeFs.readFileSync(runbook, "utf8")).toBe("# VPC\n")
    expect(failed.url).toBe(
      "git::https://git.example.com/org/missing.git//runbooks/vpc?ref=main&sshkey=[REDACTED]",
    )
    expect(`${failed.url} ${failed.message}`).not.toContain(sshKey)
  }, 30_000)

  it("fails with the parser's message for a source it can't parse, before running git", async () => {
    const err = await openError("https://bitbucket.org/o/r")

    expect(err.url).toBe("https://bitbucket.org/o/r")
    expect(err.message.startsWith("unsupported URL format")).toBe(true)
    expect(spawns).toEqual([])
  })

  it("the ref lookup and the clone both run the user's core.sshCommand, in batch mode", async () => {
    // A url.<ssh>.insteadOf rewrite sends even an https browser URL over ssh,
    // so the ls-remote must wrap the same ssh client as the clone.
    setEnv("GIT_CONFIG_COUNT", "1")
    setEnv("GIT_CONFIG_KEY_0", "core.sshCommand")
    setEnv("GIT_CONFIG_VALUE_0", "ssh -i /keys/id_work")
    try {
      await open("https://git.example.com/org/repo/tree/main/runbooks/vpc")
    } finally {
      for (const name of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"])
        setEnv(name, undefined)
    }

    const sshCommandOf = (subcommand: string) =>
      spawns.find((s) => s.args[0] === subcommand)?.env?.GIT_SSH_COMMAND
    expect(sshCommandOf("ls-remote")).toBe(
      "ssh -i /keys/id_work -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=30 -o ServerAliveInterval=15 -o ServerAliveCountMax=2",
    )
    expect(sshCommandOf("clone")).toBe(
      "ssh -i /keys/id_work -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=30 -o ServerAliveInterval=15 -o ServerAliveCountMax=2",
    )
  }, 30_000)

  it("runs no command that the config of a repository-looking folder around its clones names", async () => {
    // A folder git would take for a bare repository, whose config names an
    // ssh command. The clone's git starts in the clones folder below it.
    const looksBare = nodePath.join(root, "looks-bare")
    const marker = nodePath.join(root, "ran-the-folder-ssh-command")
    const command = nodePath.join(root, "bin", "folder-ssh")
    nodeFs.writeFileSync(command, `#!/bin/sh\ntouch '${marker}'\nexit 255\n`, { mode: 0o755 })
    nodeFs.mkdirSync(nodePath.join(looksBare, "objects"), { recursive: true })
    nodeFs.mkdirSync(nodePath.join(looksBare, "refs"))
    nodeFs.writeFileSync(nodePath.join(looksBare, "HEAD"), "ref: refs/heads/main\n")
    nodeFs.writeFileSync(
      nodePath.join(looksBare, "config"),
      `[core]\n\trepositoryformatversion = 0\n\tbare = true\n\tsshCommand = ${command}\n`,
    )
    setEnv("FAKE_SSH_STDERR", "git@git.example.com: Permission denied (publickey).")

    const err = await openErrorIn(
      nodePath.join(looksBare, "clones"),
      "git@git.example.com:org/repo.git//runbooks/vpc?ref=main",
    )

    expect(err.message).toContain("SSH authentication failed for git.example.com/org/repo")
    expect(nodeFs.existsSync(marker)).toBe(false)
  }, 30_000)

  it("http:// never looks up or sends a token", async () => {
    const runbook = await open("git::http://git.example.com/org/repo.git//runbooks/vpc")

    expect(nodeFs.readFileSync(runbook, "utf8")).toBe("# VPC\n")
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
  ])(
    "%s goes over ssh with no token, and its failure gets the SSH hint",
    async (source, sshStderr, hint) => {
      setEnv("FAKE_SSH_STDERR", sshStderr)
      const err = await openError(source)

      expect(err.message).toContain(hint)
      expect(tokenLookups).toEqual([])
      expect(sentToken("clone")).toBe(false)
    },
    30_000,
  )

  it.each([
    [
      "git@git.example.com:org/repo.git//runbooks/vpc",
      "ssh: Could not resolve hostname git.example.com: nodename nor servname provided, or not known",
    ],
    [
      "ssh://git@git.example.com/org/repo.git//runbooks/vpc",
      "ssh: connect to host git.example.com port 22: Connection refused",
    ],
  ])(
    "%s: an ssh network failure says the host is unreachable, not to check the SSH key",
    async (source, sshStderr) => {
      setEnv("FAKE_SSH_STDERR", sshStderr)
      const err = await openError(source)

      expect(err.message).toBe("Could not reach git.example.com. Check your internet connection.")
    },
    30_000,
  )

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

  describe("a server that takes the connection and never answers", () => {
    // stall.example.com goes to it. git gives up after 2 seconds without a
    // byte, as the app's environment says; gitSpawnEnv sets the rest.
    const held = new Set<nodeNet.Socket>()
    const server = nodeNet.createServer((socket) => void held.add(socket))
    const STALL = { GIT_ALLOW_PROTOCOL: "file:ssh:http", GIT_HTTP_LOW_SPEED_TIME: "2" }
    const outer: Record<string, string | undefined> = {}

    beforeAll(async () => {
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve)
      })
      const address = server.address()
      if (address === null || typeof address === "string") throw new Error("no port")
      nodeFs.appendFileSync(
        nodePath.join(root, "gitconfig"),
        `[url "http://127.0.0.1:${address.port}/"]\n\tinsteadOf = https://stall.example.com/\n`,
      )
      for (const [key, value] of Object.entries(STALL)) {
        outer[key] = process.env[key]
        process.env[key] = value
      }
    })

    afterAll(() => {
      for (const [key, value] of Object.entries(outer)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      for (const socket of held) socket.destroy()
      server.close()
    })

    const STALLED =
      "stall.example.com sent nothing for 2 seconds, so Runbooks gave up. Check your internet connection or proxy."

    it("gives up on the ref lookup, naming the host and the seconds", async () => {
      const started = Date.now()
      const err = await openError("https://stall.example.com/org/repo/tree/main/runbooks/vpc")
      expect(err.message).toBe(STALLED)
      expect(Date.now() - started).toBeLessThan(10_000)
      expect(spawns.some((s) => s.args[0] === "clone")).toBe(false)
    }, 20_000)

    it("gives up on the clone, and leaves nothing in the clones folder", async () => {
      const folder = nodePath.join(root, "stalled clones")
      const started = Date.now()
      const err = await openErrorIn(folder, "git::https://stall.example.com/org/repo.git")
      expect(err.message).toBe(STALLED)
      expect(Date.now() - started).toBeLessThan(10_000)
      expect(spawns.some((s) => s.args[0] === "clone")).toBe(true)
      expect(nodeFs.readdirSync(folder)).toEqual([])
    }, 20_000)
  })

  it("a path that isn't in the repo is reported as not found at its ref", async () => {
    const err = await openError(
      "git::https://git.example.com/org/repo.git//runbooks/missing?ref=main",
    )
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
    expect(err.message).toBe(
      '"runbooks/escape" in git.example.com/org/repo points outside the repository',
    )
  }, 30_000)
})
