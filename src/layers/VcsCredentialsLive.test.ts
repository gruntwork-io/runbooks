import { describe, it, expect, setSystemTime, afterEach } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { VcsCredentials } from "../services/VcsCredentials.ts"
import { VcsCredentialsLive } from "./VcsCredentialsLive.ts"
import { GitHubApiError, GitLabApiError, VcsCliError } from "../errors/index.ts"
import { makeTestEnvironment } from "../test-utils/TestEnvironment.ts"
import { makeTestFileSystem } from "../test-utils/TestFileSystem.ts"
import { makeRecordingSpawner } from "../test-utils/TestSpawner.ts"
import type { SpawnResponse } from "../test-utils/TestSpawner.ts"
import { makeTestGitHubClient, makeTestGitLabClient } from "../test-utils/TestLayer.ts"
import type { GitHubClientShape } from "../services/GitHubClient.ts"
import type { GitLabClientShape } from "../services/GitLabClient.ts"

afterEach(() => {
  setSystemTime() // restore the real clock
})

const OCTOCAT = { login: "octocat", name: "Octo Cat" }
const TANUKI = { login: "tanuki" }

interface HarnessOptions {
  env?: Record<string, string>
  files?: Record<string, string>
  respond?: (command: string, args: string[]) => SpawnResponse | "ENOENT"
  github?: Partial<GitHubClientShape>
  gitlab?: Partial<GitLabClientShape>
}

/** Build a fresh VcsCredentials layer with fakes. Each call gets its own caches. */
const makeHarness = (options: HarnessOptions = {}) => {
  const spawner = makeRecordingSpawner(options.respond ?? (() => "ENOENT"))
  const deps = Layer.mergeAll(
    makeTestEnvironment(options.env ?? {}),
    makeTestFileSystem(options.files ?? {}),
    spawner.layer,
    makeTestGitHubClient(options.github),
    makeTestGitLabClient(options.gitlab),
  )
  const layer = Layer.provide(VcsCredentialsLive, deps)
  // A ManagedRuntime memoizes the layer, so the service instance — and its
  // caches — persist across `use` calls, matching production.
  const runtime = ManagedRuntime.make(layer)
  const use = <A, E>(f: (vcs: VcsCredentials["Type"]) => Effect.Effect<A, E>) =>
    runtime.runPromise(Effect.flatMap(VcsCredentials, f))
  return { use, calls: spawner.calls }
}

// Spawn responders ----------------------------------------------------------

const ghVersion: SpawnResponse = { lines: [{ line: "gh version 2.40.1 (2023-12-13)", source: "stdout" }], exitCode: 0 }
const glabVersion: SpawnResponse = { lines: [{ line: "glab 1.101.0", source: "stdout" }], exitCode: 0 }

const respondWith = (
  handlers: Record<string, (args: string[]) => SpawnResponse | "ENOENT">,
) => (command: string, args: string[]): SpawnResponse | "ENOENT" => {
  const handler = handlers[`${command} ${args[0] ?? ""}`] ?? handlers[command]
  return handler ? handler(args) : "ENOENT"
}

describe("VcsCredentialsLive — chain precedence (§2 tables)", () => {
  it("resolveGitHub: env wins over CLI (first-success-wins)", async () => {
    const harness = makeHarness({
      env: { GITHUB_TOKEN: "ghp_env" },
      github: {
        validateToken: (token) =>
          token === "ghp_env"
            ? Effect.succeed({ user: OCTOCAT, scopes: ["repo"] })
            : Effect.fail(new GitHubApiError({ status: 401, message: "401" })),
      },
    })
    const result = await harness.use((vcs) => vcs.resolveGitHub())
    expect(result.outcome).toBe("valid")
    expect(result.source).toBe("env")
    expect(result.envVar).toBe("GITHUB_TOKEN")
    expect(result.token).toBe("ghp_env")
    // The CLI source was never consulted.
    expect(harness.calls.filter((c) => c.command === "gh" && c.args[0] === "auth")).toHaveLength(0)
  })

  it("resolveGitHub: an INVALID env token warns and CONTINUES to the CLI source", async () => {
    const harness = makeHarness({
      env: { GITHUB_TOKEN: "ghp_bad" },
      respond: respondWith({
        "gh auth": (args) =>
          args[1] === "token"
            ? { lines: [{ line: "gho_cli", source: "stdout" }], exitCode: 0 }
            : { lines: [{ line: "  - Token scopes: 'repo'", source: "stdout" }], exitCode: 0 },
        "gh version": () => ghVersion,
      }),
      github: {
        validateToken: (token) =>
          token === "gho_cli"
            ? Effect.succeed({ user: OCTOCAT, scopes: ["repo"] })
            : Effect.fail(new GitHubApiError({ status: 401, message: "401 Bad credentials" })),
      },
    })
    const result = await harness.use((vcs) => vcs.resolveGitHub())
    expect(result.outcome).toBe("valid")
    expect(result.source).toBe("cli")
    // §2.0 chip copy carried along — never "expired".
    expect(result.warnings).toEqual(["GITHUB_TOKEN is not valid for github.com"])
  })

  it("resolveGitHub: an UNREACHABLE outcome stops the chain without consuming the CLI source", async () => {
    const harness = makeHarness({
      env: { GITHUB_TOKEN: "ghp_env" },
      github: {
        validateToken: () =>
          Effect.fail(new GitHubApiError({ status: 0, message: "fetch failed", kind: "tls" })),
      },
    })
    const result = await harness.use((vcs) => vcs.resolveGitHub())
    expect(result.outcome).toBe("unreachable")
    expect(result.errorKind).toBe("tls")
    expect(result.warnings).toEqual([]) // never a token warning for transport failures
    expect(harness.calls.filter((c) => c.command === "gh")).toHaveLength(0)
  })

  it("resolveGitLab: server-cert unreachable carries its kind (handlers skip refresh+probe on it)", async () => {
    const harness = makeHarness({
      env: { GITLAB_TOKEN: "glpat-x" },
      gitlab: {
        validateToken: () =>
          Effect.fail(new GitLabApiError({ status: 0, message: "cert expired", kind: "server-cert" })),
      },
    })
    const result = await harness.use((vcs) => vcs.resolveGitLab("gitlab.com"))
    expect(result.outcome).toBe("unreachable")
    expect(result.errorKind).toBe("server-cert")
  })

  it("detectGitHubEnv: an UNCLASSIFIED transport failure (status 0, no kind) is unreachable+tls, never invalid", async () => {
    // e.g. a cert-verification code classifyTlsError does not enumerate
    // (CERT_REVOKED on an old build, a future X509_V_ERR_*): the API error
    // carries status 0 and no `kind`. The status-0 backstop must still route it
    // away from the "Invalid credentials detected" misdiagnosis.
    const harness = makeHarness({
      env: { GITHUB_TOKEN: "ghp_env" },
      github: {
        validateToken: () => Effect.fail(new GitHubApiError({ status: 0, message: "fetch failed" })),
      },
    })
    const result = await harness.use((vcs) => vcs.detectGitHubEnv())
    expect(result.outcome).toBe("unreachable")
    expect(result.errorKind).toBe("tls")
    expect(result.warnings).toEqual([]) // never a token warning for a transport failure
  })

  it("detectGitHubEnv: a real 401 (HTTP status, no kind) is still invalid — status 0 is the discriminant", async () => {
    const harness = makeHarness({
      env: { GITHUB_TOKEN: "ghp_env" },
      github: {
        validateToken: () => Effect.fail(new GitHubApiError({ status: 401, message: "Bad credentials" })),
      },
    })
    const result = await harness.use((vcs) => vcs.detectGitHubEnv())
    expect(result.outcome).toBe("invalid")
    expect(result.errorKind).toBeUndefined()
  })

  it("resolveGitHub: nothing found is absent — NOT an error (the repo may be public)", async () => {
    const harness = makeHarness({
      respond: respondWith({
        "gh auth": () => ({ lines: [], exitCode: 1 }),
        "gh version": () => ghVersion,
      }),
    })
    const result = await harness.use((vcs) => vcs.resolveGitHub())
    expect(result.outcome).toBe("absent")
    expect(result.warnings).toEqual([])
  })
})

describe("VcsCredentialsLive — §2.2 env binding in the GitLab leg", () => {
  it("never transmits the env token to a host other than envHost", async () => {
    let validatedAgainst: string | undefined
    const harness = makeHarness({
      env: { GITLAB_TOKEN: "glpat-bound", GITLAB_HOST: "git.corp.example" },
      gitlab: {
        validateToken: (_token, baseUrl) => {
          validatedAgainst = baseUrl
          return Effect.succeed({ user: TANUKI })
        },
      },
    })
    // Requested host ≠ envHost → absent, no validation call at all.
    const other = await harness.use((vcs) => vcs.detectGitLabEnv("gitlab.com"))
    expect(other.outcome).toBe("absent")
    expect(validatedAgainst).toBeUndefined()

    // Requested host === envHost → validated against exactly that host.
    const bound = await harness.use((vcs) => vcs.detectGitLabEnv("git.corp.example"))
    expect(bound.outcome).toBe("valid")
    expect(validatedAgainst).toBe("https://git.corp.example")
  })
})

describe("VcsCredentialsLive — §2.4 probe gating", () => {
  const OAUTH_TOKEN = "a".repeat(64)

  it("probes a glpat-shaped GitLab token via `glab api user` with token in CHILD ENV, never argv", async () => {
    const harness = makeHarness({
      respond: respondWith({
        "glab version": () => glabVersion,
        "glab api": () => ({
          lines: [{ line: JSON.stringify({ username: "tanuki" }), source: "stdout" }],
          exitCode: 0,
        }),
      }),
    })
    const result = await harness.use((vcs) =>
      Effect.either(vcs.validateViaCli("gitlab", "git.corp.example", "glpat-secret", "cli")),
    )
    expect(result._tag).toBe("Right")
    if (result._tag === "Right") expect(result.right.user.login).toBe("tanuki")

    const apiCall = harness.calls.find((c) => c.command === "glab" && c.args[0] === "api")
    expect(apiCall).toBeDefined()
    expect(apiCall!.args).toEqual(["api", "user", "--hostname", "git.corp.example"])
    // Token via child env only — never argv (argv is visible in ps).
    expect(apiCall!.args.join(" ")).not.toContain("glpat-secret")
    expect(apiCall!.env!.GITLAB_TOKEN).toBe("glpat-secret")
    // Other ambient token vars stay stripped.
    expect(apiCall!.env!.OAUTH_TOKEN).toBeUndefined()
    // NO_PROMPT is stripped (deprecated in glab; setting it makes glab warn
    // on STDOUT ahead of the parsed payload).
    expect(apiCall!.env!.NO_PROMPT).toBeUndefined()
  })

  it("NEVER probes an env-sourced OAuth-shaped GitLab token via token injection", async () => {
    const harness = makeHarness({
      respond: respondWith({ "glab version": () => glabVersion }),
    })
    const result = await harness.use((vcs) =>
      Effect.either(vcs.validateViaCli("gitlab", "gitlab.com", OAUTH_TOKEN, "env")),
    )
    expect(result._tag).toBe("Left")
    // No glab api/auth spawn happened — only (at most) the version probe.
    expect(harness.calls.filter((c) => c.command === "glab" && c.args[0] !== "version")).toHaveLength(0)
  })

  it("probes a glab-SOURCED OAuth-shaped token via `glab auth status` (no token injection)", async () => {
    const harness = makeHarness({
      respond: respondWith({
        "glab version": () => glabVersion,
        "glab auth": () => ({
          lines: [{ line: "✓ Logged in to gitlab.com", source: "stderr" }],
          exitCode: 0,
        }),
      }),
    })
    const result = await harness.use((vcs) =>
      Effect.either(vcs.validateViaCli("gitlab", "gitlab.com", OAUTH_TOKEN, "cli")),
    )
    expect(result._tag).toBe("Right")
    const statusCall = harness.calls.find((c) => c.command === "glab" && c.args[0] === "auth")
    expect(statusCall).toBeDefined()
    expect(statusCall!.args).toEqual(["auth", "status", "--hostname", "gitlab.com"])
    // NO token env injection for OAuth-shaped probes.
    expect(statusCall!.env!.GITLAB_TOKEN).toBeUndefined()
  })

  it("gh probe pins the candidate via GH_TOKEN and parses headers + body from `gh api user -i`", async () => {
    const harness = makeHarness({
      env: { GITHUB_TOKEN: "ghp_ambient" },
      respond: respondWith({
        "gh version": () => ghVersion,
        "gh api": () => ({
          lines: [
            { line: "HTTP/2.0 200 OK", source: "stdout" },
            { line: "X-Oauth-Scopes: repo, read:org", source: "stdout" },
            { line: "", source: "stdout" },
            { line: JSON.stringify({ login: "octocat", name: "Octo Cat" }), source: "stdout" },
          ],
          exitCode: 0,
        }),
      }),
    })
    const result = await harness.use((vcs) =>
      Effect.either(vcs.validateViaCli("github", "github.com", "ghp_candidate", "manual")),
    )
    expect(result._tag).toBe("Right")
    if (result._tag === "Right") {
      expect(result.right.user.login).toBe("octocat")
      expect(result.right.scopes).toEqual(["repo", "read:org"])
    }
    const apiCall = harness.calls.find((c) => c.command === "gh" && c.args[0] === "api")
    // --hostname pins the probe to github.com so GH_HOST can never retarget
    // the candidate token at a GHES origin (§8).
    expect(apiCall!.args).toEqual(["api", "user", "-i", "--hostname", "github.com"])
    // gh validates exactly the candidate: GH_TOKEN set, GITHUB_TOKEN stripped.
    expect(apiCall!.env!.GH_TOKEN).toBe("ghp_candidate")
    expect(apiCall!.env!.GITHUB_TOKEN).toBeUndefined()
    expect(apiCall!.env!.GH_HOST).toBeUndefined()
  })

  it("every probe failure class is a typed VcsCliError (degrades to the card, never blocks)", async () => {
    // Not installed.
    const noGh = makeHarness({ respond: () => "ENOENT" })
    const notInstalled = await noGh.use((vcs) =>
      Effect.either(vcs.validateViaCli("github", "github.com", "ghp_x", "manual")),
    )
    expect(notInstalled._tag).toBe("Left")
    if (notInstalled._tag === "Left") {
      expect(notInstalled.left).toBeInstanceOf(VcsCliError)
      expect(notInstalled.left.kind).toBe("not-installed")
    }

    // Below the version floor (§2.4: gh ≥ 2.26.0).
    const oldGh = makeHarness({
      respond: respondWith({
        "gh version": () => ({ lines: [{ line: "gh version 2.20.0 (2022-01-01)", source: "stdout" }], exitCode: 0 }),
      }),
    })
    const belowFloor = await oldGh.use((vcs) =>
      Effect.either(vcs.validateViaCli("github", "github.com", "ghp_x", "manual")),
    )
    expect(belowFloor._tag).toBe("Left")

    // API failure (e.g. stderr `API call failed` after a CLI upgrade).
    const apiFail = makeHarness({
      respond: respondWith({
        "gh version": () => ghVersion,
        "gh api": () => ({ lines: [{ line: "gh: Bad credentials (HTTP 401)", source: "stderr" }], exitCode: 1 }),
      }),
    })
    const api = await apiFail.use((vcs) =>
      Effect.either(vcs.validateViaCli("github", "github.com", "ghp_x", "manual")),
    )
    expect(api._tag).toBe("Left")
    if (api._tag === "Left") expect(api.left.kind).toBe("api")
  })
})

describe("VcsCredentialsLive — CLI read cache (§2.3)", () => {
  it("caches a successful gh read for 5 minutes and re-reads after TTL", async () => {
    setSystemTime(new Date("2030-01-01T00:00:00Z"))
    const harness = makeHarness({
      respond: respondWith({
        "gh auth": () => ({ lines: [{ line: "gho_cli", source: "stdout" }], exitCode: 0 }),
        "gh version": () => ghVersion,
      }),
    })
    await harness.use((vcs) => vcs.tokenForHost("github.com"))
    await harness.use((vcs) => vcs.tokenForHost("github.com"))
    const reads = () => harness.calls.filter((c) => c.command === "gh" && c.args[1] === "token")
    expect(reads()).toHaveLength(1)

    // Past the TTL the read happens again.
    setSystemTime(new Date("2030-01-01T00:05:01Z"))
    await harness.use((vcs) => vcs.tokenForHost("github.com"))
    expect(reads()).toHaveLength(2)
  })

  it("invalidateCache() flushes immediately (Reload / Check again / host pick)", async () => {
    setSystemTime(new Date("2030-01-01T00:00:00Z"))
    const harness = makeHarness({
      respond: respondWith({
        "gh auth": () => ({ lines: [{ line: "gho_cli", source: "stdout" }], exitCode: 0 }),
        "gh version": () => ghVersion,
      }),
    })
    await harness.use((vcs) => vcs.tokenForHost("github.com"))
    await harness.use((vcs) => vcs.invalidateCache())
    await harness.use((vcs) => vcs.tokenForHost("github.com"))
    expect(harness.calls.filter((c) => c.command === "gh" && c.args[1] === "token")).toHaveLength(2)
  })

  it("an auth failure flushes the relevant entry (terminal re-login is picked up on the next attempt)", async () => {
    setSystemTime(new Date("2030-01-01T00:00:00Z"))
    let valid = false
    const harness = makeHarness({
      respond: respondWith({
        "gh auth": (args) =>
          args[1] === "token"
            ? { lines: [{ line: "gho_cli", source: "stdout" }], exitCode: 0 }
            : { lines: [], exitCode: 1 },
        "gh version": () => ghVersion,
      }),
      github: {
        validateToken: () =>
          valid
            ? Effect.succeed({ user: OCTOCAT })
            : Effect.fail(new GitHubApiError({ status: 401, message: "401" })),
      },
    })
    const first = await harness.use((vcs) => vcs.detectGitHubCli())
    expect(first.outcome).toBe("invalid")
    valid = true
    const second = await harness.use((vcs) => vcs.detectGitHubCli())
    expect(second.outcome).toBe("valid")
    // The invalid validation flushed the cache → two real reads.
    expect(harness.calls.filter((c) => c.command === "gh" && c.args[1] === "token")).toHaveLength(2)
  })
})

describe("VcsCredentialsLive — tokenForHost classification (§2.3, golang parity)", () => {
  const harnessFor = (env: Record<string, string>, files: Record<string, string> = {}) =>
    makeHarness({
      env,
      files,
      respond: respondWith({
        "gh auth": () => ({ lines: [], exitCode: 1 }),
        "gh version": () => ghVersion,
        "glab config": () => ({ lines: [], exitCode: 0 }),
        "glab version": () => glabVersion,
      }),
    })

  it("GITHUB_TOKEN takes precedence over GH_TOKEN", async () => {
    const harness = harnessFor({ GITHUB_TOKEN: "gh-token-1", GH_TOKEN: "gh-token-2" })
    expect(await harness.use((vcs) => vcs.tokenForHost("github.com"))).toBe("gh-token-1")
  })

  it("falls back to GH_TOKEN when GITHUB_TOKEN is not set", async () => {
    const harness = harnessFor({ GH_TOKEN: "gh-token-2" })
    expect(await harness.use((vcs) => vcs.tokenForHost("github.com"))).toBe("gh-token-2")
  })

  it("GITLAB_TOKEN serves gitlab.com", async () => {
    const harness = harnessFor({ GITLAB_TOKEN: "gl-token-1" })
    expect(await harness.use((vcs) => vcs.tokenForHost("gitlab.com"))).toBe("gl-token-1")
  })

  it("host matching is case-insensitive", async () => {
    const harness = harnessFor({ GITHUB_TOKEN: "gh-token", GITLAB_TOKEN: "gl-token" })
    expect(await harness.use((vcs) => vcs.tokenForHost("GitHub.com"))).toBe("gh-token")
    expect(await harness.use((vcs) => vcs.tokenForHost("GITHUB.COM"))).toBe("gh-token")
    expect(await harness.use((vcs) => vcs.tokenForHost("GitLab.com"))).toBe("gl-token")
  })

  it("unknown hosts resolve to undefined — not an error (public repos must work)", async () => {
    const harness = harnessFor({ GITHUB_TOKEN: "x", GITLAB_TOKEN: "y" })
    expect(await harness.use((vcs) => vcs.tokenForHost("bitbucket.org"))).toBeUndefined()
  })

  it("a glab-config host is in the union even when its name has no 'gitlab' (the git.corp.net blind spot)", async () => {
    const harness = makeHarness({
      env: { HOME: "/home/u" },
      files: {
        "/home/u/.config/glab-cli/config.yml": "hosts:\n    git.corp.net:\n        token: glpat-corp\n",
      },
      respond: respondWith({
        "glab config": () => ({ lines: [{ line: "glpat-corp", source: "stdout" }], exitCode: 0 }),
        "glab version": () => glabVersion,
      }),
    })
    expect(await harness.use((vcs) => vcs.tokenForHost("git.corp.net"))).toBe("glpat-corp")
  })

  it("the env token is NOT served for a non-envHost GitLab host (binding rule)", async () => {
    const harness = makeHarness({
      env: { GITLAB_TOKEN: "gl-bound", GITLAB_HOST: "git.corp.example", HOME: "/home/u" },
      files: {
        "/home/u/.config/glab-cli/config.yml": "hosts:\n    gitlab.com:\n        token: glpat-cli\n",
      },
      respond: respondWith({
        "glab config": () => ({ lines: [{ line: "glpat-cli", source: "stdout" }], exitCode: 0 }),
        "glab version": () => glabVersion,
      }),
    })
    // gitlab.com is NOT the bound host → CLI token, never the env token.
    expect(await harness.use((vcs) => vcs.tokenForHost("gitlab.com"))).toBe("glpat-cli")
    // The bound host gets the env token.
    expect(await harness.use((vcs) => vcs.tokenForHost("git.corp.example"))).toBe("gl-bound")
  })
})

describe("VcsCredentialsLive — transport-degraded host set (§2.4)", () => {
  it("marks, reports, and clears degraded hosts", async () => {
    const harness = makeHarness()
    await harness.use((vcs) => vcs.markTransportDegraded("git.corp.example", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"))
    expect(await harness.use((vcs) => vcs.isTransportDegraded("git.corp.example"))).toBe(true)
    expect(await harness.use((vcs) => vcs.isTransportDegraded("gitlab.com"))).toBe(false)
    await harness.use((vcs) => vcs.clearTransportDegraded())
    expect(await harness.use((vcs) => vcs.isTransportDegraded("git.corp.example"))).toBe(false)
  })
})
