/**
 * getSessionTokenForHost — the host binding that keeps a session token from
 * reaching a host taken from untrusted input (a remote runbook URL). The
 * provider name-heuristic (isGitLabHost) matches lookalike hosts, so this
 * comparison is the only thing standing between them and the token.
 */
import { describe, it, expect, afterEach } from "bun:test"
import { Effect } from "effect"
import { sessionManager, getSessionTokenForHost } from "./runtime.ts"
import type { GitProvider } from "./runtime.ts"
import { makeTestEnvironment } from "../../../src/test-utils/TestEnvironment.ts"

const MISSING = "missing"

const tokenFor = (provider: GitProvider, host: string) =>
  Effect.runPromise(
    getSessionTokenForHost(provider, host, () => MISSING).pipe(
      Effect.orElseSucceed(() => MISSING),
    ),
  )

const seedSession = (vars: Record<string, string>) =>
  Effect.runPromise(sessionManager.createSession("/tmp").pipe(Effect.provide(makeTestEnvironment(vars))))

describe("getSessionTokenForHost", () => {
  afterEach(() => {
    sessionManager.deleteSession()
  })

  it("binds GITLAB_TOKEN to gitlab.com when GITLAB_HOST is unset", async () => {
    await seedSession({ GITLAB_TOKEN: "gl-token" })
    expect(await tokenFor("gitlab", "gitlab.evil.example")).toBe(MISSING)
    expect(await tokenFor("gitlab", "GitLab.com")).toBe("gl-token") // case-insensitive
  })

  it("binds GITLAB_TOKEN to GITLAB_HOST", async () => {
    await seedSession({ GITLAB_TOKEN: "gl-token", GITLAB_HOST: "git.corp.net" })
    expect(await tokenFor("gitlab", "git.corp.net")).toBe("gl-token")
    expect(await tokenFor("gitlab", "gitlab.com")).toBe(MISSING)
  })

  it("binds the GitHub token to github.com", async () => {
    await seedSession({ GH_TOKEN: "gh-token" })
    expect(await tokenFor("github", "github.com")).toBe("gh-token")
    expect(await tokenFor("github", "github.evil.example")).toBe(MISSING)
  })

  it("returns onMissing when there is no session", async () => {
    expect(await tokenFor("github", "github.com")).toBe(MISSING)
  })
})
