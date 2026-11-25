/**
 * Tests for keeping a glab OAuth session credential fresh: when glab's token is
 * swapped in, when glab is asked to refresh first, and what is left alone.
 * The boundaries (session, glab, GitLab) are fakes passed to the refresh.
 */
import { describe, it, expect, mock } from "bun:test"
import { mockElectron } from "../test-utils/mock-electron.ts"

mockElectron({ ipcMain: { handle: () => {} }, app: { getPath: () => "/tmp" } })
await mock.module("../window.ts", () => ({ getMainWindow: () => null }))

const { refreshGlabCredential, isGitLabAuthFailure, GLAB_REFRESH_WINDOW_MS } =
  await import("./gitlab-cli-refresh.ts")
const { GitError, GitLabApiError } = await import("../../../src/errors/index.ts")
type Deps = import("./gitlab-cli-refresh.ts").GlabRefreshDeps
type Detection = import("./vcs-tristate.ts").OrchestratedDetection

const NOW = Date.parse("2026-11-25T20:00:00Z")
const HOST = "gitlab.com"

interface Fake {
  deps: Deps
  steps: string[]
  writes: Record<string, string>[]
  notified: unknown[]
}

/**
 * A session holding glab's `sessionToken` for gitlab.com, and a glab whose
 * stored token expires at `glabExpiry` and which answers detection with `detect`.
 */
function fake(opts: {
  binding?: { host: string; source?: string } | undefined
  sessionToken?: string
  sessionUser?: string
  isOAuth2?: boolean
  glabExpiry?: number
  detect?: Detection
  written?: boolean
}): Fake {
  const steps: string[] = []
  const writes: Record<string, string>[] = []
  const notified: unknown[] = []
  const deps: Deps = {
    sessionBinding: () => ("binding" in opts ? opts.binding : { host: HOST, source: "cli" }),
    sessionEnv: async () => ({
      token: opts.sessionToken ?? "old-oauth-token",
      user: opts.sessionUser ?? "tanuki",
    }),
    hostMeta: async () => ({
      isOAuth2: opts.isOAuth2 ?? true,
      oauth2ExpiryDate: new Date(opts.glabExpiry ?? NOW + 60 * 60_000),
      useKeyring: false,
    }),
    nudgeGlab: async (host) => {
      steps.push(`nudge ${host}`)
    },
    detect: async (host) => {
      steps.push(`detect ${host}`)
      return (
        opts.detect ?? {
          outcome: "valid",
          token: "new-oauth-token",
          source: "cli",
          user: { login: "tanuki" },
          scopes: ["api"],
          expiresAt: new Date(NOW + 2 * 60 * 60_000).toISOString(),
          warnings: [],
        }
      )
    },
    writeSession: async (_host, env) => {
      writes.push(env)
      return opts.written ?? true
    },
    notify: (event) => {
      notified.push(event)
    },
    now: () => NOW,
  }
  return { deps, steps, writes, notified }
}

describe("refreshGlabCredential", () => {
  it("swaps glab's fresher token into the session and reports its expiry", async () => {
    const f = fake({})
    const result = await refreshGlabCredential(f.deps)

    expect(result).toEqual({
      outcome: "refreshed",
      host: HOST,
      user: { login: "tanuki" },
      scopes: ["api"],
      expiresAt: new Date(NOW + 2 * 60 * 60_000).toISOString(),
    })
    expect(f.writes).toEqual([
      { GITLAB_TOKEN: "new-oauth-token", GITLAB_HOST: HOST, GITLAB_USER: "tanuki" },
    ])
    expect(f.notified).toHaveLength(1)
    expect(JSON.stringify(f.notified)).not.toContain("new-oauth-token")
    // glab's own token is hours from expiry: nothing to make glab refresh.
    expect(f.steps).toEqual([`detect ${HOST}`])
  })

  it("makes glab refresh first when glab's stored token has expired", async () => {
    const f = fake({ glabExpiry: NOW - 60_000 })
    expect((await refreshGlabCredential(f.deps)).outcome).toBe("refreshed")
    expect(f.steps).toEqual([`nudge ${HOST}`, `detect ${HOST}`])
  })

  it("makes glab refresh first when glab's token is inside the warning window", async () => {
    const f = fake({ glabExpiry: NOW + GLAB_REFRESH_WINDOW_MS - 1_000 })
    await refreshGlabCredential(f.deps)
    expect(f.steps[0]).toBe(`nudge ${HOST}`)
  })

  it("reports the same token unchanged, with nothing written", async () => {
    const f = fake({ sessionToken: "new-oauth-token" })
    const result = await refreshGlabCredential(f.deps)
    expect(result.outcome).toBe("unchanged")
    expect(f.writes).toEqual([])
    expect(f.notified).toEqual([])
  })

  it("fails with glab's remedy when glab has no working token", async () => {
    const f = fake({
      glabExpiry: NOW - 60_000,
      detect: { outcome: "invalid", source: "cli", status: 401, warnings: [] },
    })
    const result = await refreshGlabCredential(f.deps)
    expect(result).toEqual({
      outcome: "failed",
      host: HOST,
      error:
        "glab could not renew your sign-in for gitlab.com. Run 'glab auth login --hostname gitlab.com', then select Re-authenticate.",
    })
    expect(f.writes).toEqual([])
  })

  it("does not swap in a token glab holds for another user", async () => {
    const f = fake({ sessionUser: "someone-else" })
    const result = await refreshGlabCredential(f.deps)
    expect(result.outcome).toBe("failed")
    expect(f.writes).toEqual([])
  })

  it("passes an unreachable host through, without judging the credential", async () => {
    const f = fake({
      detect: { outcome: "unreachable", errorKind: "network", error: "offline", warnings: [] },
    })
    expect(await refreshGlabCredential(f.deps)).toEqual({
      outcome: "unreachable",
      host: HOST,
      errorKind: "network",
      error: "offline",
    })
  })

  it("fails when a different session has opened meanwhile", async () => {
    const f = fake({ written: false })
    expect((await refreshGlabCredential(f.deps)).outcome).toBe("failed")
    expect(f.notified).toEqual([])
  })

  it.each([
    ["an env token", { binding: { host: HOST, source: "env" } }],
    ["a pasted token", { binding: { host: HOST, source: "manual" } }],
    ["no GitLab sign-in", { binding: undefined }],
    ["a PAT glab holds", { isOAuth2: false }],
    ["a PAT in the session", { sessionToken: "glpat-abc" }],
  ])("leaves %s alone, without running glab", async (_name, opts) => {
    const f = fake(opts)
    expect(await refreshGlabCredential(f.deps)).toEqual({ outcome: "not-glab" })
    expect(f.steps).toEqual([])
    expect(f.writes).toEqual([])
  })

  it("leaves a sign-in for another host alone", async () => {
    const f = fake({})
    expect(await refreshGlabCredential(f.deps, "gitlab.example.com")).toEqual({
      outcome: "not-glab",
    })
    expect(f.steps).toEqual([])
  })
})

describe("isGitLabAuthFailure", () => {
  it("is GitLab refusing the credential", () => {
    expect(
      isGitLabAuthFailure(new GitLabApiError({ status: 401, message: "401 Unauthorized" })),
    ).toBe(true)
    expect(
      isGitLabAuthFailure(
        new GitError({
          command: "git push",
          stderr:
            "remote: HTTP Basic: Access denied\nfatal: Authentication failed for 'https://gitlab.com/a/b.git/'",
          exitCode: 128,
        }),
      ),
    ).toBe(true)
  })

  it("is not any other failure", () => {
    expect(isGitLabAuthFailure(new GitLabApiError({ status: 403, message: "forbidden" }))).toBe(
      false,
    )
    expect(isGitLabAuthFailure(new GitLabApiError({ status: 0, message: "offline" }))).toBe(false)
    expect(
      isGitLabAuthFailure(
        new GitError({ command: "git push", stderr: "rejected: non-fast-forward", exitCode: 1 }),
      ),
    ).toBe(false)
    expect(isGitLabAuthFailure(new Error("401"))).toBe(false)
  })
})
