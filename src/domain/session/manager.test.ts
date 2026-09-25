import { describe, it, expect, beforeEach } from "bun:test"
import { Effect } from "effect"
import { SessionManager, diffEnv, filterCapturedEnv } from "./manager.ts"
import { makeTestEnvironment } from "../../test-utils/TestEnvironment.ts"
import type { SessionExecSnapshot } from "../../types.ts"

function run<A>(effect: Effect.Effect<A, any, any>, env: Record<string, string> = {}) {
  return Effect.runPromise(effect.pipe(Effect.provide(makeTestEnvironment(env))) as unknown as Effect.Effect<A, any, never>)
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

describe("diffEnv", () => {
  it("reports added and re-assigned keys as set and removed keys as unset", () => {
    const result = diffEnv(
      { SAME: "1", CHANGED: "old", GONE: "x" },
      { SAME: "1", CHANGED: "new", ADDED: "y" },
    )
    expect(result).toEqual({ set: { CHANGED: "new", ADDED: "y" }, unset: ["GONE"] })
  })

  it("reports nothing for an unchanged env", () => {
    expect(diffEnv({ A: "1", B: "2" }, { B: "2", A: "1" })).toEqual({ set: {}, unset: [] })
  })

  it("treats a key assigned an empty string as set, not unset", () => {
    expect(diffEnv({ A: "1" }, { A: "" })).toEqual({ set: { A: "" }, unset: [] })
  })

  it("handles names that exist on Object.prototype", () => {
    const withProtoNames = Object.fromEntries([["__proto__", "1"], ["constructor", "2"]])

    expect(Object.entries(diffEnv({}, withProtoNames).set)).toEqual([
      ["__proto__", "1"],
      ["constructor", "2"],
    ])
    expect(diffEnv(withProtoNames, {}).unset).toEqual(["__proto__", "constructor"])
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

    it("does not carry a protected list over to a session set up with []", async () => {
      const env = { AWS_ACCESS_KEY_ID: "AKIA...", AWS_SECRET_ACCESS_KEY: "secret" }

      // Runbook A has <AwsAuth>: its session starts without the AWS keys.
      mgr.setProtectedEnvVars(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"])
      await run(mgr.createSession("/a", "/a/runbook.mdx"), env)
      expect((await run(mgr.getExecContext())).env.AWS_ACCESS_KEY_ID).toBeUndefined()

      // Runbook B has none: its session gets the environment's keys as-is.
      mgr.setProtectedEnvVars([])
      await run(mgr.createSession("/b", "/b/runbook.mdx"), env)
      const ctx = await run(mgr.getExecContext())
      expect(ctx.env.AWS_ACCESS_KEY_ID).toBe("AKIA...")
      expect(ctx.env.AWS_SECRET_ACCESS_KEY).toBe("secret")
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

    it("tracks the runbook path passed in", async () => {
      await run(mgr.createSession("/work", "/work/runbook.mdx"), {})
      expect(mgr.getRunbookPath()).toBe("/work/runbook.mdx")
    })

    it("clears worktree state from a previous session (switching runbooks)", async () => {
      await run(mgr.createSession("/repo-a", "/repo-a/runbook.mdx"), {})
      mgr.registerWorkTreePath("/repo-a/clone")
      mgr.setActiveWorkTreePath("/repo-a/clone")
      expect(mgr.getActiveWorkTreePath()).toBe("/repo-a/clone")

      // Opening a different runbook creates a fresh session — the previous
      // runbook's worktree must not leak into it.
      await run(mgr.createSession("/repo-b", "/repo-b/runbook.mdx"), {})
      expect(mgr.getActiveWorkTreePath()).toBe("")
      expect(mgr.getRunbookPath()).toBe("/repo-b/runbook.mdx")
    })
  })

  describe("getRunbookPath", () => {
    it("returns null when no session exists", () => {
      expect(mgr.getRunbookPath()).toBeNull()
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
      // createSession makes the first token; join 19 more to reach capacity (20).
      const { token: originalToken } = await run(mgr.createSession("/work"), {})

      for (let i = 0; i < 19; i++) {
        await run(mgr.joinSession())
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
      const start = await run(mgr.getExecContext())
      await run(mgr.applyCapturedEnv({
        before: start.env,
        after: { A: "1", B: "2" },
        startWorkDir: start.workDir,
        pwd: "/new/dir",
        generation: start.generation,
      }))

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

  describe("applyCapturedEnv", () => {
    /** Apply a script's capture the way exec:run does, against its start snapshot. */
    function applyCapture(
      start: SessionExecSnapshot,
      after: Record<string, string>,
      pwd: string = start.workDir,
    ) {
      return run(mgr.applyCapturedEnv({
        before: start.env,
        after,
        startWorkDir: start.workDir,
        pwd,
        generation: start.generation,
      }))
    }

    it("applies the script's exports and working dir", async () => {
      await run(mgr.createSession("/work"), { OLD: "val" })
      const start = await run(mgr.getExecContext())

      await applyCapture(start, { OLD: "val", NEW: "val" }, "/new")

      const ctx = await run(mgr.getExecContext())
      expect(ctx.env).toEqual({ OLD: "val", NEW: "val" })
      expect(ctx.workDir).toBe("/new")
    })

    it("deletes a key the script unset", async () => {
      await run(mgr.createSession("/work"), { DEBUG: "1", KEEP: "1" })
      const start = await run(mgr.getExecContext())
      const after = { ...start.env }
      delete after.DEBUG

      await applyCapture(start, after)

      const ctx = await run(mgr.getExecContext())
      expect(ctx.env).toEqual({ KEEP: "1" })
    })

    it("keeps a credential an auth block added while the script ran", async () => {
      await run(mgr.createSession("/work"), { PATH: "/usr/bin" })
      const start = await run(mgr.getExecContext())
      await run(mgr.appendToEnv({ GITHUB_TOKEN: "ghp_mid_run" }))

      await applyCapture(start, { ...start.env, FOO: "1" })

      const ctx = await run(mgr.getExecContext())
      expect(ctx.env.FOO).toBe("1")
      expect(ctx.env.GITHUB_TOKEN).toBe("ghp_mid_run")
    })

    it("keeps a value an auth block replaced while the script ran", async () => {
      await run(mgr.createSession("/work"), { GOOGLE_APPLICATION_CREDENTIALS: "/tmp/old.json" })
      const start = await run(mgr.getExecContext())
      await run(mgr.appendToEnv({ GOOGLE_APPLICATION_CREDENTIALS: "/tmp/new.json" }))

      await applyCapture(start, { ...start.env })

      const ctx = await run(mgr.getExecContext())
      expect(ctx.env.GOOGLE_APPLICATION_CREDENTIALS).toBe("/tmp/new.json")
    })

    it("keeps a var an auth block removed while the script ran removed", async () => {
      await run(mgr.createSession("/work"), {
        CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: "/tmp/cred.json",
      })
      const start = await run(mgr.getExecContext())
      await run(mgr.removeFromEnv(["CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE"]))

      await applyCapture(start, { ...start.env })

      const ctx = await run(mgr.getExecContext())
      expect(ctx.env.CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE).toBeUndefined()
    })

    it("keeps a working dir set during the run when the script did not cd", async () => {
      await run(mgr.createSession("/work"), {})
      const start = await run(mgr.getExecContext())
      mgr.setWorkingDir("/moved")

      await applyCapture(start, { ...start.env }, "/work")

      const ctx = await run(mgr.getExecContext())
      expect(ctx.workDir).toBe("/moved")
    })

    it("keeps the working dir when the script's pwd capture came back empty", async () => {
      await run(mgr.createSession("/work"), {})
      const start = await run(mgr.getExecContext())

      await applyCapture(start, { ...start.env, FOO: "1" }, "")

      const ctx = await run(mgr.getExecContext())
      expect(ctx.workDir).toBe("/work")
      expect(ctx.env.FOO).toBe("1")
    })

    it("does nothing to a session created after the script started", async () => {
      // Runbook A's script is running when runbook B is opened.
      await run(mgr.createSession("/a", "/a/runbook.mdx"), { A_SECRET: "a" })
      const start = await run(mgr.getExecContext())
      await run(mgr.createSession("/b", "/b/runbook.mdx"), { B: "b" })

      await applyCapture(start, { ...start.env, EXPORTED_BY_A: "1" }, "/a/sub")

      const ctx = await run(mgr.getExecContext())
      expect(ctx.env).toEqual({ B: "b" })
      expect(ctx.workDir).toBe("/b")
      expect((await run(mgr.getMetadata())).executionCount).toBe(0)
    })

    it("increments execution count", async () => {
      await run(mgr.createSession("/work"), {})
      const start = await run(mgr.getExecContext())
      await applyCapture(start, {})
      await applyCapture(start, {})

      const meta = await run(mgr.getMetadata())
      expect(meta.executionCount).toBe(2)
    })

    it("is a no-op when no session exists", async () => {
      await run(mgr.createSession("/work"), {})
      const start = await run(mgr.getExecContext())
      mgr.deleteSession()

      await applyCapture(start, { X: "1" })

      expect(mgr.hasSession()).toBe(false)
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

  describe("removeFromEnv", () => {
    it("deletes the given keys, leaving others untouched", async () => {
      const { token } = await run(
        mgr.createSession("/work"),
        { A: "1", B: "2" },
      )
      await run(mgr.appendToEnv({ C: "3" }))

      await run(mgr.removeFromEnv(["B"]))

      const ctx = await Effect.runPromise(mgr.validateToken(token))
      expect(ctx!.env).toEqual({ A: "1", C: "3" })
    })

    it("is a no-op for a key that is not set", async () => {
      const { token } = await run(mgr.createSession("/work"), { A: "1" })

      await run(mgr.removeFromEnv(["NEVER_SET"]))

      const ctx = await Effect.runPromise(mgr.validateToken(token))
      expect(ctx!.env).toEqual({ A: "1" })
    })

    it("fails when no session", async () => {
      await expect(run(mgr.removeFromEnv(["X"]))).rejects.toThrow()
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
