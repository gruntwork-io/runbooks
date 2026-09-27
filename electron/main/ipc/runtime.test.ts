/**
 * Host-bound session credential lookup (GitHub Enterprise support):
 * getGitHubSessionCredential / getSessionTokenForHost /
 * getSessionTokenForProvider read the singleton session with the auth
 * block's host binding (vcsSessionMeta).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { Effect } from "effect"
import {
  sessionManager,
  vcsSessionMeta,
  getGitHubSessionCredential,
  getSessionTokenForHost,
  getSessionTokenForProvider,
} from "./runtime.ts"
import { githubSessionEnv } from "../../../src/domain/github/auth.ts"
import { makeTestEnvironment } from "../../../src/test-utils/TestEnvironment.ts"

const GHES = "ghes.example.com"
const GHEC = "acme.ghe.com"

/** Fresh session from `initialEnv`, plus an auth block's write for `authHost`. */
const setup = async (initialEnv: Record<string, string>, auth?: { host: string; token: string }) => {
  await Effect.runPromise(
    sessionManager.createSession("/tmp").pipe(Effect.provide(makeTestEnvironment(initialEnv))),
  )
  if (auth) {
    await Effect.runPromise(sessionManager.appendToEnv(githubSessionEnv(auth.host, auth.token, "user")))
    vcsSessionMeta.set("github", { host: auth.host, source: "manual" })
  }
}

const missing = () => new Error("missing")

const tokenForHost = (provider: "github" | "gitlab", host: string) =>
  Effect.runPromise(
    getSessionTokenForHost(provider, host, missing).pipe(Effect.orElseSucceed(() => undefined)),
  )

const credential = (host: string | undefined) =>
  Effect.runPromise(
    getGitHubSessionCredential(host, missing).pipe(Effect.orElseSucceed(() => undefined)),
  )

beforeEach(() => {
  vcsSessionMeta.clear()
})

afterEach(() => {
  vcsSessionMeta.clear()
  sessionManager.deleteSession()
})

describe("getSessionTokenForHost — github", () => {
  it("a GHES auth block's token is released for that host only", async () => {
    await setup({}, { host: GHES, token: "t_ghes" })
    expect(await tokenForHost("github", GHES)).toBe("t_ghes")
    expect(await tokenForHost("github", `https://${GHES}/o/r`)).toBe("t_ghes")
    expect(await tokenForHost("github", "github.com")).toBeUndefined()
    expect(await tokenForHost("github", GHEC)).toBeUndefined()
    expect(await tokenForHost("github", "attacker.example.com")).toBeUndefined()
  })

  it("a github.com auth block's token is never released for an enterprise host", async () => {
    await setup({}, { host: "github.com", token: "t_dotcom" })
    expect(await tokenForHost("github", "github.com")).toBe("t_dotcom")
    expect(await tokenForHost("github", GHES)).toBeUndefined()
    expect(await tokenForHost("github", GHEC)).toBeUndefined()
  })

  it("a GHES auth block that overwrote an ambient GITHUB_TOKEN never serves its token to github.com", async () => {
    // Ambient GITHUB_TOKEN (github.com) is overwritten by the GHES block's
    // GITHUB_TOKEN; the session no longer holds a github.com token.
    await setup({ GITHUB_TOKEN: "ambient_dotcom" }, { host: GHES, token: "t_ghes" })
    expect(await tokenForHost("github", "github.com")).toBeUndefined()
    expect(await tokenForHost("github", GHES)).toBe("t_ghes")
  })

  it("without an auth block: the session env is read with gh's binding", async () => {
    await setup({ GITHUB_TOKEN: "d", GH_HOST: GHES, GH_ENTERPRISE_TOKEN: "e" })
    expect(await tokenForHost("github", "github.com")).toBe("d")
    expect(await tokenForHost("github", GHES)).toBe("e")
    expect(await tokenForHost("github", "other-ghes.example.com")).toBeUndefined()
  })

  it("an auth host whose GITHUB_HOST was changed by a script releases nothing (fail closed)", async () => {
    await setup({ GITHUB_TOKEN: "ambient_dotcom" }, { host: GHES, token: "t_ghes" })
    await Effect.runPromise(sessionManager.removeFromEnv(["GITHUB_HOST"]))
    expect(vcsSessionMeta.get("github")?.host).toBe(GHES)
    expect(await tokenForHost("github", GHES)).toBeUndefined()
    expect(await tokenForHost("github", "github.com")).toBeUndefined()
  })

  it("after a session reset (which clears the host bindings) the ambient env binding applies", async () => {
    await setup({ GITHUB_TOKEN: "ambient_dotcom" }, { host: GHES, token: "t_ghes" })
    await Effect.runPromise(sessionManager.resetSession())
    vcsSessionMeta.clear() // what the session:reset handler does
    expect(await tokenForHost("github", GHES)).toBeUndefined()
    expect(await tokenForHost("github", "github.com")).toBe("ambient_dotcom")
  })

  it("fails with onMissing when there is no session", async () => {
    sessionManager.deleteSession()
    expect(await tokenForHost("github", "github.com")).toBeUndefined()
  })
})

describe("getGitHubSessionCredential", () => {
  it("host undefined → the auth block's host and its token", async () => {
    await setup({}, { host: GHES, token: "t_ghes" })
    expect(await credential(undefined)).toEqual({ token: "t_ghes", host: GHES })
  })

  it("host undefined without an auth block → env-bound host", async () => {
    await setup({ GH_HOST: GHES, GH_ENTERPRISE_TOKEN: "e" })
    expect(await credential(undefined)).toEqual({ token: "e", host: GHES })
  })

  it("an unparseable host fails (never github.com)", async () => {
    await setup({ GITHUB_TOKEN: "d" })
    expect(await credential("ftp://github.com")).toBeUndefined()
  })
})

describe("getSessionTokenForProvider — github", () => {
  it("returns the session's GitHub-host token", async () => {
    await setup({}, { host: GHEC, token: "t_ghec" })
    const token = await Effect.runPromise(getSessionTokenForProvider("github", missing))
    expect(token).toBe("t_ghec")
  })
})

describe("getSessionTokenForHost — gitlab (unchanged binding)", () => {
  it("releases GITLAB_TOKEN only for GITLAB_HOST (default gitlab.com)", async () => {
    await setup({ GITLAB_TOKEN: "gl" })
    expect(await tokenForHost("gitlab", "gitlab.com")).toBe("gl")
    expect(await tokenForHost("gitlab", "gitlab.example.com")).toBeUndefined()
  })
})
