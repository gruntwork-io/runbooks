/**
 * Host-bound credential lookup for git blocks: exportedVcsCredential and
 * getExportedGitLabTokenForOrigin read the exports of the auth blocks a git
 * block's envFrom names, from the singleton session.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { Effect } from "effect"
import {
  sessionManager,
  exportedVcsCredential,
  getExportedGitLabTokenForOrigin,
} from "./runtime.ts"
import { githubSessionEnv } from "../../../src/domain/github/auth.ts"
import { authEnvExport, type AuthProvider } from "../../../src/domain/exec/authEnv.ts"
import { makeTestEnvironment } from "../../../src/test-utils/TestEnvironment.ts"

const GHES = "ghes.example.com"
const GHEC = "acme.ghe.com"
const CORP = "gitlab.corp.example"

/** Sign auth block `blockId` in with `env`, as its auth block does. */
const signIn = (blockId: string, provider: AuthProvider, env: Record<string, string>) => {
  const envExport = authEnvExport(provider, env)
  if (!envExport.ok) throw new Error(envExport.error)
  return Effect.runPromise(
    sessionManager.setEnvExport(blockId, envExport.export, sessionManager.getGeneration()),
  )
}

const signInGitHub = (blockId: string, host: string, token: string) =>
  signIn(blockId, "github", githubSessionEnv(host, token, "user"))

const signInGitLab = (blockId: string, host: string, token: string) =>
  signIn(blockId, "gitlab", { GITLAB_TOKEN: token, GITLAB_USER: "tanuki", GITLAB_HOST: host })

const tokenFor = (provider: "github" | "gitlab", envFrom: string[], host?: string) =>
  exportedVcsCredential(provider, envFrom, host)?.token

beforeEach(async () => {
  await Effect.runPromise(
    sessionManager
      .createSession("/tmp")
      .pipe(
        Effect.provide(
          makeTestEnvironment({ GITHUB_TOKEN: "ambient_dotcom", GITLAB_TOKEN: "ambient_gl" }),
        ),
      ),
  )
})

afterEach(() => {
  sessionManager.deleteSession()
})

describe("exportedVcsCredential — github", () => {
  it("a GHES block's token is released for that host only", async () => {
    await signInGitHub("ghes", GHES, "t_ghes")
    expect(tokenFor("github", ["ghes"], GHES)).toBe("t_ghes")
    expect(tokenFor("github", ["ghes"], `https://${GHES}/o/r`)).toBe("t_ghes")
    expect(tokenFor("github", ["ghes"], "github.com")).toBeUndefined()
    expect(tokenFor("github", ["ghes"], GHEC)).toBeUndefined()
    expect(tokenFor("github", ["ghes"], "attacker.example.com")).toBeUndefined()
  })

  it("a github.com block's token is never released for an enterprise host", async () => {
    await signInGitHub("dotcom", "github.com", "t_dotcom")
    expect(tokenFor("github", ["dotcom"], "github.com")).toBe("t_dotcom")
    expect(tokenFor("github", ["dotcom"], GHES)).toBeUndefined()
    expect(tokenFor("github", ["dotcom"], GHEC)).toBeUndefined()
  })

  it("without a host, gives the block's own host and token", async () => {
    await signInGitHub("ghes", GHES, "t_ghes")
    expect(exportedVcsCredential("github", ["ghes"])).toEqual({ token: "t_ghes", host: GHES })
  })

  it("a later block wins, and an earlier one still serves a host only it signed in to", async () => {
    await signInGitHub("first", "github.com", "t_first")
    await signInGitHub("second", "github.com", "t_second")
    await signInGitHub("enterprise", GHES, "t_ghes")
    expect(tokenFor("github", ["first", "second"], "github.com")).toBe("t_second")
    expect(tokenFor("github", ["second", "first"], "github.com")).toBe("t_first")
    expect(tokenFor("github", ["first", "enterprise"], "github.com")).toBe("t_first")
    expect(exportedVcsCredential("github", ["first", "enterprise"])?.host).toBe(GHES)
  })

  it("the session's env, and blocks envFrom doesn't name, give nothing", async () => {
    await signInGitHub("other", "github.com", "t_other")
    expect(tokenFor("github", [], "github.com")).toBeUndefined()
    expect(tokenFor("github", ["not_signed_in"], "github.com")).toBeUndefined()
    expect(exportedVcsCredential("github", [])).toBeUndefined()
  })

  it("an unparseable host gets nothing (never github.com)", async () => {
    await signInGitHub("dotcom", "github.com", "t_dotcom")
    expect(tokenFor("github", ["dotcom"], "ftp://github.com")).toBeUndefined()
  })

  it("a signed-out block gives nothing", async () => {
    await signInGitHub("dotcom", "github.com", "t_dotcom")
    await Effect.runPromise(sessionManager.clearEnvExport("dotcom", sessionManager.getGeneration()))
    expect(tokenFor("github", ["dotcom"], "github.com")).toBeUndefined()
  })

  it("a GitLab block gives no GitHub token", async () => {
    await signInGitLab("gl", "gitlab.com", "t_gl")
    expect(exportedVcsCredential("github", ["gl"])).toBeUndefined()
  })
})

describe("exportedVcsCredential — gitlab", () => {
  it("a block's token is released for its host only", async () => {
    await signInGitLab("corp", CORP, "t_block")
    expect(tokenFor("gitlab", ["corp"], CORP)).toBe("t_block")
    expect(tokenFor("gitlab", ["corp"], `https://${CORP.toUpperCase()}/`)).toBe("t_block")
    expect(tokenFor("gitlab", ["corp"], "gitlab.com")).toBeUndefined()
  })

  it("the session's GITLAB_TOKEN goes nowhere", () => {
    expect(tokenFor("gitlab", [], "gitlab.com")).toBeUndefined()
  })
})

describe("getExportedGitLabTokenForOrigin", () => {
  const forOrigin = (envFrom: string[], origin: string) =>
    Effect.runPromise(
      getExportedGitLabTokenForOrigin(envFrom, origin, () => new Error("missing")).pipe(
        Effect.orElseSucceed(() => undefined),
      ),
    )

  it("releases the token only over https, to the block's host", async () => {
    await signInGitLab("corp", CORP, "t_block")
    expect(await forOrigin(["corp"], `https://${CORP}`)).toBe("t_block")
    expect(await forOrigin(["corp"], `http://${CORP}`)).toBeUndefined()
    expect(await forOrigin(["corp"], "https://gitlab.com")).toBeUndefined()
    expect(await forOrigin(["corp"], "not a url")).toBeUndefined()
  })
})
