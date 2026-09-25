import { describe, it, expect, beforeEach } from "bun:test"
import { Effect } from "effect"
import { SessionManager, filterCapturedEnv } from "./manager.ts"
import { makeTestEnvironment } from "../../test-utils/TestEnvironment.ts"

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

describe("SessionManager", () => {
  let mgr: SessionManager

  beforeEach(() => {
    mgr = new SessionManager()
  })

  describe("createSession", () => {
    it("captures environment from Environment service", async () => {
      await run(
        mgr.createSession("/work"),
        { HOME: "/home/user", MY_VAR: "test" },
      )
      const ctx = await Effect.runPromise(mgr.getExecContext())
      expect(ctx.env.HOME).toBe("/home/user")
      expect(ctx.env.MY_VAR).toBe("test")
    })

    it("strips protected env vars", async () => {
      mgr.setProtectedEnvVars(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"])
      await run(
        mgr.createSession("/work"),
        { HOME: "/home", AWS_ACCESS_KEY_ID: "AKIA...", AWS_SECRET_ACCESS_KEY: "secret", PATH: "/usr/bin" },
      )
      const ctx = await Effect.runPromise(mgr.getExecContext())
      expect(ctx.env.AWS_ACCESS_KEY_ID).toBeUndefined()
      expect(ctx.env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
      expect(ctx.env.HOME).toBe("/home")
    })

    it("replaces any existing session", async () => {
      await run(mgr.createSession("/work1"), { A: "1" })
      await run(mgr.createSession("/work2"), { B: "2" })

      // Only the new session's env and workDir remain
      const ctx = await Effect.runPromise(mgr.getExecContext())
      expect(ctx.env).toEqual({ B: "2" })
      expect(ctx.workDir).toBe("/work2")
    })

    it("sets workDir from initialWorkingDir", async () => {
      await run(mgr.createSession("/my/dir"), {})
      const ctx = await Effect.runPromise(mgr.getExecContext())
      expect(ctx.workDir).toBe("/my/dir")
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

  describe("getExecContext", () => {
    it("returns snapshot with env and workDir", async () => {
      await run(
        mgr.createSession("/work"),
        { HOME: "/home", PATH: "/usr/bin" },
      )
      const ctx = await Effect.runPromise(mgr.getExecContext())
      expect(ctx).toEqual({
        env: { HOME: "/home", PATH: "/usr/bin" },
        workDir: "/work",
      })
    })

    it("returns a copy that later session changes do not affect", async () => {
      await run(mgr.createSession("/work"), { A: "1" })
      const ctx = await Effect.runPromise(mgr.getExecContext())

      await run(mgr.appendToEnv({ B: "2" }))

      expect(ctx.env).toEqual({ A: "1" })
    })

    it("fails when no session exists", async () => {
      await expect(Effect.runPromise(mgr.getExecContext())).rejects.toThrow()
    })
  })

  describe("resetSession", () => {
    it("resets env and workDir to initial values", async () => {
      await run(
        mgr.createSession("/initial"),
        { A: "1" },
      )

      // Modify the session
      await run(mgr.updateSessionEnv({ A: "1", B: "2" }, "/new/dir"))

      // Verify modified
      let ctx = await Effect.runPromise(mgr.getExecContext())
      expect(ctx.env.B).toBe("2")
      expect(ctx.workDir).toBe("/new/dir")

      // Reset
      await run(mgr.resetSession())

      // Should be back to initial
      ctx = await Effect.runPromise(mgr.getExecContext())
      expect(ctx.env).toEqual({ A: "1" })
      expect(ctx.workDir).toBe("/initial")
    })

    it("fails when no session exists", async () => {
      await expect(run(mgr.resetSession())).rejects.toThrow()
    })
  })

  describe("updateSessionEnv", () => {
    it("replaces env and workDir", async () => {
      await run(mgr.createSession("/work"), { OLD: "val" })
      await run(mgr.updateSessionEnv({ NEW: "val" }, "/new"))

      const ctx = await Effect.runPromise(mgr.getExecContext())
      expect(ctx.env).toEqual({ NEW: "val" })
      expect(ctx.workDir).toBe("/new")
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
      await run(
        mgr.createSession("/work"),
        { A: "1", B: "2" },
      )

      await run(mgr.appendToEnv({ C: "3" }))

      const ctx = await Effect.runPromise(mgr.getExecContext())
      expect(ctx.env.A).toBe("1")
      expect(ctx.env.B).toBe("2")
      expect(ctx.env.C).toBe("3")
    })

    it("overwrites existing keys", async () => {
      await run(
        mgr.createSession("/work"),
        { A: "old" },
      )

      await run(mgr.appendToEnv({ A: "new" }))

      const ctx = await Effect.runPromise(mgr.getExecContext())
      expect(ctx.env.A).toBe("new")
    })

    it("fails when no session", async () => {
      await expect(run(mgr.appendToEnv({ X: "1" }))).rejects.toThrow()
    })
  })

  describe("removeFromEnv", () => {
    it("deletes the given keys, leaving others untouched", async () => {
      await run(
        mgr.createSession("/work"),
        { A: "1", B: "2" },
      )
      await run(mgr.appendToEnv({ C: "3" }))

      await run(mgr.removeFromEnv(["B"]))

      const ctx = await Effect.runPromise(mgr.getExecContext())
      expect(ctx.env).toEqual({ A: "1", C: "3" })
    })

    it("is a no-op for a key that is not set", async () => {
      await run(mgr.createSession("/work"), { A: "1" })

      await run(mgr.removeFromEnv(["NEVER_SET"]))

      const ctx = await Effect.runPromise(mgr.getExecContext())
      expect(ctx.env).toEqual({ A: "1" })
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
