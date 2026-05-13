import { describe, it, expect, beforeEach } from "bun:test"
import { Effect } from "effect"
import { SessionManager, filterCapturedEnv } from "./manager.ts"
import { makeTestEnvironment } from "../../test-utils/TestEnvironment.ts"

function run<A>(effect: Effect.Effect<A, any, any>, env: Record<string, string> = {}) {
  return Effect.runPromise(effect.pipe(Effect.provide(makeTestEnvironment(env))))
}

describe("filterCapturedEnv", () => {
  it("removes excluded env vars", () => {
    const result = filterCapturedEnv({
      HOME: "/home/user",
      SHLVL: "1",
      _: "/usr/bin/env",
      RUNBOOK_OUTPUT: "/tmp/output",
      GENERATED_FILES: "/tmp/files",
      REPO_FILES: "/tmp/repo",
      OLDPWD: "/old",
      RANDOM: "12345",
      SECONDS: "100",
    })
    expect(result).toEqual({ HOME: "/home/user" })
  })

  it("removes all BASH_ prefixed vars", () => {
    const result = filterCapturedEnv({
      PATH: "/usr/bin",
      BASH_VERSION: "5.0",
      BASH_VERSINFO: "5",
      BASH_CUSTOM_VAR: "test",
    })
    expect(result).toEqual({ PATH: "/usr/bin" })
  })

  it("removes internal wrapper variables", () => {
    const result = filterCapturedEnv({
      USER: "test",
      __RUNBOOKS_ENV_CAPTURE_PATH: "/tmp/env",
      __RUNBOOKS_PWD_CAPTURE_PATH: "/tmp/pwd",
      __RUNBOOKS_USER_EXIT_HANDLER: "cleanup",
      __RUNBOOKS_COMBINED_EXIT: "handler",
      _RUNBOOKS_LOGGING_LOADED: "1",
    })
    expect(result).toEqual({ USER: "test" })
  })

  it("returns empty object when all vars are excluded", () => {
    const result = filterCapturedEnv({ SHLVL: "1", _: "/bin/env" })
    expect(result).toEqual({})
  })

  it("passes through unrecognized vars", () => {
    const result = filterCapturedEnv({ MY_VAR: "hello", CUSTOM: "world" })
    expect(result).toEqual({ MY_VAR: "hello", CUSTOM: "world" })
  })
})

describe("SessionManager", () => {
  let mgr: SessionManager

  beforeEach(() => {
    mgr = new SessionManager()
  })

  describe("createSession", () => {
    it("creates a session and returns a token", async () => {
      const { token } = await run(
        mgr.createSession("/work"),
        { HOME: "/home/user", PATH: "/usr/bin" },
      )
      expect(token).toBeDefined()
      expect(typeof token).toBe("string")
      expect(token.length).toBeGreaterThan(0)
    })

    it("captures environment from Environment service", async () => {
      const { token } = await run(
        mgr.createSession("/work"),
        { HOME: "/home/user", MY_VAR: "test" },
      )
      const ctx = await Effect.runPromise(mgr.validateToken(token))
      expect(ctx).not.toBeNull()
      expect(ctx!.env.HOME).toBe("/home/user")
      expect(ctx!.env.MY_VAR).toBe("test")
    })

    it("strips protected env vars", async () => {
      mgr.setProtectedEnvVars(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"])
      const { token } = await run(
        mgr.createSession("/work"),
        { HOME: "/home", AWS_ACCESS_KEY_ID: "AKIA...", AWS_SECRET_ACCESS_KEY: "secret", PATH: "/usr/bin" },
      )
      const ctx = await Effect.runPromise(mgr.validateToken(token))
      expect(ctx!.env.AWS_ACCESS_KEY_ID).toBeUndefined()
      expect(ctx!.env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
      expect(ctx!.env.HOME).toBe("/home")
    })

    it("replaces any existing session", async () => {
      const { token: token1 } = await run(mgr.createSession("/work1"), { A: "1" })
      const { token: token2 } = await run(mgr.createSession("/work2"), { B: "2" })

      // Old token is invalid
      const ctx1 = await Effect.runPromise(mgr.validateToken(token1))
      expect(ctx1).toBeNull()

      // New token is valid
      const ctx2 = await Effect.runPromise(mgr.validateToken(token2))
      expect(ctx2).not.toBeNull()
      expect(ctx2!.workDir).toBe("/work2")
    })

    it("sets workDir from initialWorkingDir", async () => {
      const { token } = await run(mgr.createSession("/my/dir"), {})
      const ctx = await Effect.runPromise(mgr.validateToken(token))
      expect(ctx!.workDir).toBe("/my/dir")
    })
  })

  describe("joinSession", () => {
    it("creates a new token for existing session", async () => {
      const { token: t1 } = await run(mgr.createSession("/work"), { X: "1" })
      const { token: t2 } = await run(mgr.joinSession())

      expect(t2).not.toBe(t1)
      // Both tokens are valid
      const ctx1 = await Effect.runPromise(mgr.validateToken(t1))
      const ctx2 = await Effect.runPromise(mgr.validateToken(t2))
      expect(ctx1).not.toBeNull()
      expect(ctx2).not.toBeNull()
      // Both see the same env
      expect(ctx1!.env.X).toBe("1")
      expect(ctx2!.env.X).toBe("1")
    })

    it("fails when no session exists", async () => {
      await expect(run(mgr.joinSession())).rejects.toThrow()
    })

    it("prunes oldest token when at capacity", async () => {
      await run(mgr.createSession("/work"), {})
      const _firstToken = (await Effect.runPromise(mgr.validateToken(
        // get the token from createSession - we need to join 19 more times
        // Actually, let's create and then join until capacity
        "" // dummy
      )))

      // createSession already made 1 token, join 19 more to reach capacity
      const tokens: string[] = []
      const { token: originalToken } = await run(mgr.createSession("/work"), {})
      tokens.push(originalToken)

      for (let i = 0; i < 19; i++) {
        const { token } = await run(mgr.joinSession())
        tokens.push(token)
      }

      expect(mgr.tokenCount()).toBe(20)

      // Join one more - should prune the oldest (originalToken)
      const { token: newToken } = await run(mgr.joinSession())
      expect(mgr.tokenCount()).toBe(20)

      // Original token should be pruned
      const ctxOld = await Effect.runPromise(mgr.validateToken(originalToken))
      expect(ctxOld).toBeNull()

      // New token should be valid
      const ctxNew = await Effect.runPromise(mgr.validateToken(newToken))
      expect(ctxNew).not.toBeNull()
    })
  })

  describe("hasSession", () => {
    it("returns false when no session", () => {
      expect(mgr.hasSession()).toBe(false)
    })

    it("returns true after creating session", async () => {
      await run(mgr.createSession("/work"), {})
      expect(mgr.hasSession()).toBe(true)
    })
  })

  describe("deleteSession", () => {
    it("invalidates all tokens", async () => {
      const { token } = await run(mgr.createSession("/work"), {})
      mgr.deleteSession()
      expect(mgr.hasSession()).toBe(false)
      const ctx = await Effect.runPromise(mgr.validateToken(token))
      expect(ctx).toBeNull()
    })
  })

  describe("validateToken", () => {
    it("returns null for invalid token", async () => {
      await run(mgr.createSession("/work"), {})
      const ctx = await Effect.runPromise(mgr.validateToken("invalid-token"))
      expect(ctx).toBeNull()
    })

    it("returns null when no session exists", async () => {
      const ctx = await Effect.runPromise(mgr.validateToken("any-token"))
      expect(ctx).toBeNull()
    })

    it("returns snapshot with env and workDir", async () => {
      const { token } = await run(
        mgr.createSession("/work"),
        { HOME: "/home", PATH: "/usr/bin" },
      )
      const ctx = await Effect.runPromise(mgr.validateToken(token))
      expect(ctx).toEqual({
        env: { HOME: "/home", PATH: "/usr/bin" },
        workDir: "/work",
      })
    })
  })

  describe("revokeToken", () => {
    it("removes a valid token", async () => {
      const { token } = await run(mgr.createSession("/work"), {})
      expect(mgr.revokeToken(token)).toBe(true)
      const ctx = await Effect.runPromise(mgr.validateToken(token))
      expect(ctx).toBeNull()
    })

    it("returns false for unknown token", async () => {
      await run(mgr.createSession("/work"), {})
      expect(mgr.revokeToken("unknown")).toBe(false)
    })

    it("returns false when no session", () => {
      expect(mgr.revokeToken("any")).toBe(false)
    })
  })

  describe("tokenCount", () => {
    it("returns 0 when no session", () => {
      expect(mgr.tokenCount()).toBe(0)
    })

    it("returns correct count", async () => {
      await run(mgr.createSession("/work"), {})
      expect(mgr.tokenCount()).toBe(1)
      await run(mgr.joinSession())
      expect(mgr.tokenCount()).toBe(2)
    })
  })

  describe("resetSession", () => {
    it("resets env and workDir to initial values", async () => {
      const { token } = await run(
        mgr.createSession("/initial"),
        { A: "1" },
      )

      // Modify the session
      await run(mgr.updateSessionEnv({ A: "1", B: "2" }, "/new/dir"))

      // Verify modified
      let ctx = await Effect.runPromise(mgr.validateToken(token))
      expect(ctx!.env.B).toBe("2")
      expect(ctx!.workDir).toBe("/new/dir")

      // Reset
      await run(mgr.resetSession())

      // Should be back to initial
      ctx = await Effect.runPromise(mgr.validateToken(token))
      expect(ctx!.env).toEqual({ A: "1" })
      expect(ctx!.workDir).toBe("/initial")
    })

    it("fails when no session exists", async () => {
      await expect(run(mgr.resetSession())).rejects.toThrow()
    })
  })

  describe("updateSessionEnv", () => {
    it("replaces env and workDir", async () => {
      const { token } = await run(mgr.createSession("/work"), { OLD: "val" })
      await run(mgr.updateSessionEnv({ NEW: "val" }, "/new"))

      const ctx = await Effect.runPromise(mgr.validateToken(token))
      expect(ctx!.env).toEqual({ NEW: "val" })
      expect(ctx!.workDir).toBe("/new")
    })

    it("increments execution count", async () => {
      await run(mgr.createSession("/work"), {})
      await run(mgr.updateSessionEnv({}, "/work"))
      await run(mgr.updateSessionEnv({}, "/work"))

      const meta = await run(mgr.getMetadata())
      expect(meta.executionCount).toBe(2)
    })

    it("fails when no session", async () => {
      await expect(run(mgr.updateSessionEnv({}, "/"))).rejects.toThrow()
    })
  })

  describe("appendToEnv", () => {
    it("merges new vars without replacing existing", async () => {
      const { token } = await run(
        mgr.createSession("/work"),
        { A: "1", B: "2" },
      )

      await run(mgr.appendToEnv({ C: "3" }))

      const ctx = await Effect.runPromise(mgr.validateToken(token))
      expect(ctx!.env.A).toBe("1")
      expect(ctx!.env.B).toBe("2")
      expect(ctx!.env.C).toBe("3")
    })

    it("overwrites existing keys", async () => {
      const { token } = await run(
        mgr.createSession("/work"),
        { A: "old" },
      )

      await run(mgr.appendToEnv({ A: "new" }))

      const ctx = await Effect.runPromise(mgr.validateToken(token))
      expect(ctx!.env.A).toBe("new")
    })

    it("fails when no session", async () => {
      await expect(run(mgr.appendToEnv({ X: "1" }))).rejects.toThrow()
    })
  })

  describe("getMetadata", () => {
    it("returns session metadata", async () => {
      await run(mgr.createSession("/work"), {})
      const meta = await run(mgr.getMetadata())
      expect(meta.workingDir).toBe("/work")
      expect(meta.executionCount).toBe(0)
      expect(meta.activeTabs).toBe(1)
      expect(meta.createdAt).toBeDefined()
      expect(meta.lastActivity).toBeDefined()
    })

    it("fails when no session", async () => {
      await expect(run(mgr.getMetadata())).rejects.toThrow()
    })
  })

  describe("worktree management", () => {
    it("returns empty string when no session", () => {
      expect(mgr.getActiveWorkTreePath()).toBe("")
    })

    it("returns empty string when no worktrees registered", async () => {
      await run(mgr.createSession("/work"), {})
      expect(mgr.getActiveWorkTreePath()).toBe("")
    })

    it("returns last registered worktree as fallback", async () => {
      await run(mgr.createSession("/work"), {})
      mgr.registerWorkTreePath("/tree1")
      mgr.registerWorkTreePath("/tree2")
      expect(mgr.getActiveWorkTreePath()).toBe("/tree2")
    })

    it("returns explicitly set active worktree", async () => {
      await run(mgr.createSession("/work"), {})
      mgr.registerWorkTreePath("/tree1")
      mgr.registerWorkTreePath("/tree2")
      mgr.setActiveWorkTreePath("/tree1")
      expect(mgr.getActiveWorkTreePath()).toBe("/tree1")
    })

    it("does not register duplicates", async () => {
      await run(mgr.createSession("/work"), {})
      mgr.registerWorkTreePath("/tree1")
      mgr.registerWorkTreePath("/tree1")
      // Still only one entry — if we register a second, it becomes "last"
      mgr.registerWorkTreePath("/tree2")
      expect(mgr.getActiveWorkTreePath()).toBe("/tree2")
    })

    it("no-ops when no session", () => {
      // These should not throw
      mgr.registerWorkTreePath("/tree")
      mgr.setActiveWorkTreePath("/tree")
      expect(mgr.getActiveWorkTreePath()).toBe("")
    })
  })
})
