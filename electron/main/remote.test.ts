import { describe, it, expect, afterEach } from "bun:test"
import * as nodeFs from "node:fs"
import * as nodePath from "node:path"
import * as os from "node:os"
import { Effect, Layer } from "effect"
import {
  isRemoteURL,
  isAuthError,
  authHintForHost,
  classifyCloneError,
  cleanupTempClones,
  registerTempCloneDir,
  failWithCloneHint,
  selectCloneToken,
} from "./remote.ts"
import { sessionManager } from "./ipc/runtime.ts"
import { resolveRef } from "../../src/remote-source.ts"
import { VcsCredentials } from "../../src/services/VcsCredentials.ts"
import type { VcsCredentialsShape } from "../../src/services/VcsCredentials.ts"
import { makeTestSpawner } from "../../src/test-utils/TestSpawner.ts"
import { makeTestEnvironment } from "../../src/test-utils/TestEnvironment.ts"

describe("isRemoteURL", () => {
  it("detects HTTPS GitHub URLs", () => {
    expect(isRemoteURL("https://github.com/owner/repo/tree/main/path")).toBe(true)
  })

  it("detects HTTPS GitLab URLs", () => {
    expect(isRemoteURL("https://gitlab.com/owner/repo/-/tree/main/path")).toBe(true)
  })

  it("detects HTTP URLs", () => {
    expect(isRemoteURL("http://github.com/owner/repo")).toBe(true)
  })

  it("detects git:: prefix URLs", () => {
    expect(isRemoteURL("git::https://github.com/owner/repo.git//path?ref=v1.0")).toBe(true)
  })

  it("detects GitHub shorthand", () => {
    expect(isRemoteURL("github.com/owner/repo//path")).toBe(true)
  })

  it("detects GitLab shorthand", () => {
    expect(isRemoteURL("gitlab.com/owner/repo//path")).toBe(true)
  })

  it("rejects local paths", () => {
    expect(isRemoteURL("./path/to/runbook.mdx")).toBe(false)
    expect(isRemoteURL("/absolute/path/to/runbook.mdx")).toBe(false)
    expect(isRemoteURL("relative/path")).toBe(false)
  })

  it("rejects bare filenames", () => {
    expect(isRemoteURL("runbook.mdx")).toBe(false)
  })

  it("handles whitespace", () => {
    expect(isRemoteURL("  https://github.com/owner/repo  ")).toBe(true)
  })
})

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
// failWithCloneHint — a failed ref-resolving ls-remote gets the same hint as
// a failed clone, not a guessed ref or raw git output.
// ---------------------------------------------------------------------------

describe("failWithCloneHint", () => {
  it.each([
    [
      "auth",
      "remote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found",
      "authentication required for github.com/o/r: set GITHUB_TOKEN, or run 'gh auth login'",
    ],
    [
      "network",
      "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com",
      "Could not reach github.com. Check your internet connection.",
    ],
  ])("maps a failed ls-remote to the %s hint", async (_kind, stderr, hint) => {
    const spawner = makeTestSpawner([
      {
        command: "git",
        args: ["ls-remote", "--refs", "https://github.com/o/r.git"],
        outputLines: stderr.split("\n"),
        source: "stderr",
        exitCode: 128,
      },
    ])

    const result = await Effect.runPromise(
      resolveRef("https://github.com/o/r.git", "main/runbooks/x").pipe(
        Effect.catchAll(
          failWithCloneHint({
            url: "https://github.com/o/r/tree/main/runbooks/x",
            host: "github.com",
            owner: "o",
            repo: "r",
            hadToken: false,
          }),
        ),
        Effect.provide(spawner),
        Effect.either,
      ),
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("RemoteSourceError")
      expect(result.left.message).toBe(hint)
    }
  })
})

// ---------------------------------------------------------------------------
// selectCloneToken — the clone token for an (untrusted) remote URL host.
// ---------------------------------------------------------------------------

describe("selectCloneToken", () => {
  afterEach(() => {
    sessionManager.deleteSession()
  })

  const seedSession = (vars: Record<string, string>) =>
    Effect.runPromise(sessionManager.createSession("/tmp").pipe(Effect.provide(makeTestEnvironment(vars))))

  /** VcsCredentials stub: only tokenForHost is reached; records its hosts. */
  const select = (host: string, tokens: Record<string, string> = {}) => {
    const asked: string[] = []
    const vcs = Layer.succeed(VcsCredentials, {
      tokenForHost: (h: string) =>
        Effect.sync(() => {
          asked.push(h)
          return tokens[h]
        }),
    } as unknown as VcsCredentialsShape)
    return Effect.runPromise(selectCloneToken(host).pipe(Effect.provide(vcs))).then((token) => ({
      token,
      asked,
    }))
  }

  it("never gives a gitlab.com-bound session token to a lookalike GitLab host", async () => {
    await seedSession({ GITLAB_TOKEN: "session-gitlab-token" })
    const { token, asked } = await select("gitlab.evil.example")
    expect(token).toBeUndefined()
    expect(asked).toEqual(["gitlab.evil.example"])
  })

  it("uses the session GitHub token for github.com", async () => {
    await seedSession({ GITHUB_TOKEN: "session-github-token" })
    const { token, asked } = await select("github.com", { "github.com": "ambient-token" })
    expect(token).toBe("session-github-token")
    expect(asked).toEqual([])
  })

  it("uses the session GitLab token for the self-hosted host it is bound to", async () => {
    await seedSession({ GITLAB_TOKEN: "session-gitlab-token", GITLAB_HOST: "gitlab.corp.example" })
    const { token } = await select("gitlab.corp.example")
    expect(token).toBe("session-gitlab-token")
  })

  it("sends an unknown host straight to VcsCredentials.tokenForHost", async () => {
    await seedSession({ GITHUB_TOKEN: "session-github-token", GITLAB_TOKEN: "session-gitlab-token" })
    const { token, asked } = await select("bitbucket.org", { "bitbucket.org": "bb-token" })
    expect(token).toBe("bb-token")
    expect(asked).toEqual(["bitbucket.org"])
  })

  it("falls back to VcsCredentials.tokenForHost when there is no session", async () => {
    const { token } = await select("github.com", { "github.com": "ambient-token" })
    expect(token).toBe("ambient-token")
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
