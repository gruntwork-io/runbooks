import { describe, it, expect, beforeEach } from "bun:test"
import { Effect } from "effect"
import { SessionManager, appendPathEntries, diffEnv, type SessionState } from "./manager.ts"
import { makeTestEnvironment } from "../../test-utils/TestEnvironment.ts"
import type { Environment } from "../../services/Environment.ts"

function run<A, E>(effect: Effect.Effect<A, E, Environment>, env: Record<string, string> = {}) {
  return Effect.runPromise(effect.pipe(Effect.provide(makeTestEnvironment(env))))
}

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
    const withProtoNames = Object.fromEntries([
      ["__proto__", "1"],
      ["constructor", "2"],
    ])

    expect(Object.entries(diffEnv({}, withProtoNames).set)).toEqual([
      ["__proto__", "1"],
      ["constructor", "2"],
    ])
    expect(diffEnv(withProtoNames, {}).unset).toEqual(["__proto__", "constructor"])
  })
})

describe("appendPathEntries", () => {
  it("adds the entries the PATH lacks to its end, in order, and keeps the rest in place", () => {
    expect(appendPathEntries("/usr/bin:/bin", ["/opt/bin", "/bin", "/usr/local/bin"], ":")).toEqual(
      { path: "/usr/bin:/bin:/opt/bin:/usr/local/bin", added: ["/opt/bin", "/usr/local/bin"] },
    )
  })

  it("adds an entry once, even when it's listed twice, and skips empty entries", () => {
    expect(appendPathEntries("/usr/bin", ["", "/opt/bin", "/opt/bin"], ":")).toEqual({
      path: "/usr/bin:/opt/bin",
      added: ["/opt/bin"],
    })
  })

  it("leaves the PATH as written when it has every entry, empty entries and all", () => {
    expect(appendPathEntries("/usr/bin::/bin", ["/bin", "/usr/bin"], ":")).toEqual({
      path: "/usr/bin::/bin",
      added: [],
    })
  })

  it("builds a PATH from the entries alone when there is none", () => {
    expect(appendPathEntries("", ["/a", "/b"], ":")).toEqual({ path: "/a:/b", added: ["/a", "/b"] })
  })

  it("splits and joins on the delimiter it's given", () => {
    expect(appendPathEntries("C:\\bin", ["C:\\tools"], ";").path).toBe("C:\\bin;C:\\tools")
  })
})

describe("SessionManager", () => {
  let mgr: SessionManager

  beforeEach(() => {
    mgr = new SessionManager()
  })

  describe("createSession", () => {
    it("captures environment from Environment service", async () => {
      await run(mgr.createSession("/work"), { HOME: "/home/user", MY_VAR: "test" })
      const ctx = await Effect.runPromise(mgr.getExecContext())
      expect(ctx.env.HOME).toBe("/home/user")
      expect(ctx.env.MY_VAR).toBe("test")
    })

    it("replaces any existing session", async () => {
      await run(mgr.createSession("/work1"), { A: "1" })
      await run(mgr.createSession("/work2"), { B: "2" })

      // Only the new session's env and workDir remain
      const ctx = await Effect.runPromise(mgr.getExecContext())
      expect(ctx.env).toEqual({ B: "2" })
      expect(ctx.workDir).toBe("/work2")
    })

    it("sets workDir from the working directory it is given", async () => {
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

  describe("resumeSession", () => {
    const saved = (state: Partial<SessionState> = {}) => ({
      workingDir: "/session",
      runbookPath: "/repo/runbook.mdx",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      state: {
        env: { set: {}, unset: [] },
        envExports: {},
        worktrees: [],
        activeWorktree: "",
        executionCount: 0,
        lastActivity: new Date("2026-01-02T00:00:00Z"),
        ...state,
      },
    })

    it("applies the saved env changes on top of the current process env", async () => {
      await run(
        mgr.resumeSession(
          saved({ env: { set: { TOKEN: "t", PATH: "/custom" }, unset: ["GONE"] } }),
        ),
        { PATH: "/usr/bin", GONE: "x", HOME: "/home" },
      )

      const ctx = await run(mgr.getExecContext())
      expect(ctx.env).toEqual({ PATH: "/custom", HOME: "/home", TOKEN: "t" })
    })

    it("resets to the current process env, without the saved changes", async () => {
      await run(mgr.resumeSession(saved({ env: { set: { A: "1" }, unset: [] } })), {
        HOME: "/home",
      })

      await run(mgr.resetSession())

      const ctx = await run(mgr.getExecContext())
      expect(ctx).toMatchObject({ env: { HOME: "/home" }, workDir: "/session" })
    })

    it("restores the worktrees, execution count and creation time", async () => {
      await run(
        mgr.resumeSession(
          saved({
            worktrees: ["/session/a", "/session/b"],
            activeWorktree: "/session/a",
            executionCount: 7,
          }),
        ),
      )

      expect(mgr.getRunbookPath()).toBe("/repo/runbook.mdx")
      expect(mgr.getActiveWorkTreePath()).toBe("/session/a")
      expect(await run(mgr.getMetadata())).toEqual({
        workingDir: "/session",
        executionCount: 7,
        createdAt: "2026-01-01T00:00:00.000Z",
        lastActivity: "2026-01-02T00:00:00.000Z",
      })
    })

    it("replaces the session, so a write scoped to the previous one is dropped", async () => {
      await run(mgr.createSession("/old"), {})
      const previous = mgr.getGeneration()

      await run(mgr.resumeSession(saved()))
      await run(mgr.applyScriptEnv({ env: { LATE: "1" }, generation: previous }))

      expect((await run(mgr.getExecContext())).env.LATE).toBeUndefined()
    })
  })

  describe("setChangeListener", () => {
    it("reports the state after each change, with the env as changes since the session started", async () => {
      await run(mgr.createSession("/work"), { HOME: "/home" })
      const states: SessionState[] = []
      mgr.setChangeListener((state) => states.push(state))

      await run(mgr.applyScriptEnv({ env: { TOKEN: "t" }, generation: mgr.getGeneration() }))
      mgr.registerWorkTreePath("/work/repo")
      mgr.setActiveWorkTreePath("/work/repo")
      const start = await run(mgr.getExecContext())
      await run(mgr.applyScriptEnv({ env: { EXPORTED: "1" }, generation: start.generation }))

      expect(states).toHaveLength(4)
      expect(states.at(-1)).toMatchObject({
        env: { set: { TOKEN: "t", EXPORTED: "1" }, unset: [] },
        worktrees: ["/work/repo"],
        activeWorktree: "/work/repo",
        executionCount: 2,
      })
    })

    it("reports a reset as no env changes", async () => {
      await run(mgr.createSession("/work"), { HOME: "/home" })
      await run(mgr.applyScriptEnv({ env: { TOKEN: "t" }, generation: mgr.getGeneration() }))
      const states: SessionState[] = []
      mgr.setChangeListener((state) => states.push(state))

      await run(mgr.resetSession())

      expect(states).toHaveLength(1)
      expect(states.at(-1)).toMatchObject({ env: { set: {}, unset: [] } })
    })

    it("does not report a write dropped for a stale generation or a repeat registration", async () => {
      await run(mgr.createSession("/work"), {})
      const stale = mgr.getGeneration() - 1
      mgr.registerWorkTreePath("/work/repo")
      const states: SessionState[] = []
      mgr.setChangeListener((state) => states.push(state))

      await run(mgr.applyScriptEnv({ env: { LATE: "1" }, generation: stale }))
      mgr.registerWorkTreePath("/work/other", stale)
      mgr.registerWorkTreePath("/work/repo")

      expect(states).toEqual([])
    })

    it("stops reporting to a listener once its session is replaced", async () => {
      await run(mgr.createSession("/a"), {})
      const states: SessionState[] = []
      mgr.setChangeListener((state) => states.push(state))

      await run(mgr.createSession("/b"), {})
      await run(mgr.applyScriptEnv({ env: { B: "1" }, generation: mgr.getGeneration() }))

      expect(states).toEqual([])
    })
  })

  describe("getExecContext", () => {
    it("returns snapshot with env, workDir and the session's generation", async () => {
      await run(mgr.createSession("/work"), { HOME: "/home", PATH: "/usr/bin" })
      const ctx = await Effect.runPromise(mgr.getExecContext())
      expect(ctx).toEqual({
        env: { HOME: "/home", PATH: "/usr/bin" },
        workDir: "/work",
        generation: mgr.getGeneration(),
      })
    })

    it("returns a copy that later session changes do not affect", async () => {
      await run(mgr.createSession("/work"), { A: "1" })
      const ctx = await Effect.runPromise(mgr.getExecContext())

      await run(mgr.applyScriptEnv({ env: { B: "2" }, generation: mgr.getGeneration() }))

      expect(ctx.env).toEqual({ A: "1" })
    })

    it("fails when no session exists", async () => {
      await expect(Effect.runPromise(mgr.getExecContext())).rejects.toThrow()
    })
  })

  describe("resetSession", () => {
    it("resets the env to the one the session started with", async () => {
      await run(mgr.createSession("/initial"), { A: "1" })
      await run(mgr.applyScriptEnv({ env: { B: "2" }, generation: mgr.getGeneration() }))

      await run(mgr.resetSession())

      const ctx = await Effect.runPromise(mgr.getExecContext())
      expect(ctx.env).toEqual({ A: "1" })
      expect(ctx.workDir).toBe("/initial")
    })

    it("fails when no session exists", async () => {
      await expect(run(mgr.resetSession())).rejects.toThrow()
    })
  })

  describe("env exports", () => {
    const aws = { env: { AWS_ACCESS_KEY_ID: "AKIA" }, clears: ["AWS_SESSION_TOKEN"] }
    const gh = { env: { GITHUB_TOKEN: "ghp" }, clears: [] }

    it("keeps each block's export, and returns the ones envFrom names in its order", async () => {
      await run(mgr.createSession("/work"), {})
      await run(mgr.setEnvExport("aws", aws, mgr.getGeneration()))
      await run(mgr.setEnvExport("gh", gh, mgr.getGeneration()))

      expect(mgr.getEnvExports(["gh", "aws"])).toEqual({ ok: true, exports: [gh, aws] })
      expect(mgr.getEnvExports(["aws", "gcp"])).toEqual({ ok: false, missing: "gcp" })
    })

    it("doesn't put an export in the env scripts get without envFrom", async () => {
      await run(mgr.createSession("/work"), { HOME: "/home" })
      await run(mgr.setEnvExport("aws", aws, mgr.getGeneration()))

      expect((await run(mgr.getExecContext())).env).toEqual({ HOME: "/home" })
    })

    it("drops an export when its block signs out, and every export on reset", async () => {
      await run(mgr.createSession("/work"), {})
      await run(mgr.setEnvExport("aws", aws, mgr.getGeneration()))
      await run(mgr.setEnvExport("gh", gh, mgr.getGeneration()))

      await run(mgr.clearEnvExport("aws", mgr.getGeneration()))
      expect(mgr.getEnvExport("aws")).toBeUndefined()
      expect(mgr.getEnvExport("gh")).toEqual(gh)

      await run(mgr.resetSession())
      expect(mgr.getEnvExport("gh")).toBeUndefined()
    })

    it("drops a sign-in that finished after its session was replaced", async () => {
      await run(mgr.createSession("/a"), {})
      const previous = mgr.getGeneration()
      await run(mgr.createSession("/b"), {})

      await run(mgr.setEnvExport("aws", aws, previous))

      expect(mgr.getEnvExport("aws")).toBeUndefined()
    })

    it("reports the exports to the change listener, and restores them on resume", async () => {
      await run(mgr.createSession("/work"), {})
      const states: SessionState[] = []
      mgr.setChangeListener((state) => states.push(state))

      await run(mgr.setEnvExport("aws", aws, mgr.getGeneration()))
      expect(states.at(-1)?.envExports).toEqual({ aws })

      await run(
        mgr.resumeSession({
          workingDir: "/work",
          runbookPath: "",
          createdAt: new Date(),
          state: { ...states.at(-1)!, envExports: { aws } },
        }),
      )
      expect(mgr.getEnvExport("aws")).toEqual(aws)
    })
  })

  describe("applyScriptEnv", () => {
    it("sets the script's variables and leaves the rest of the env alone", async () => {
      await run(mgr.createSession("/work"), { OLD: "val", A: "1" })

      await run(
        mgr.applyScriptEnv({ env: { NEW: "val", A: "2" }, generation: mgr.getGeneration() }),
      )

      const ctx = await run(mgr.getExecContext())
      expect(ctx.env).toEqual({ OLD: "val", A: "2", NEW: "val" })
      expect(ctx.workDir).toBe("/work")
    })

    it("keeps what another script set while this one ran", async () => {
      await run(mgr.createSession("/work"), {})
      const start = await run(mgr.getExecContext())
      await run(mgr.applyScriptEnv({ env: { OTHER: "1" }, generation: start.generation }))

      await run(mgr.applyScriptEnv({ env: { FOO: "1" }, generation: start.generation }))

      expect((await run(mgr.getExecContext())).env).toEqual({ OTHER: "1", FOO: "1" })
    })

    it("does nothing to a session created after the script started", async () => {
      // Runbook A's script is running when runbook B is opened.
      await run(mgr.createSession("/a", "/a/runbook.mdx"), { A_SECRET: "a" })
      const start = await run(mgr.getExecContext())
      await run(mgr.createSession("/b", "/b/runbook.mdx"), { B: "b" })

      await run(mgr.applyScriptEnv({ env: { EXPORTED_BY_A: "1" }, generation: start.generation }))

      expect((await run(mgr.getExecContext())).env).toEqual({ B: "b" })
      expect((await run(mgr.getMetadata())).executionCount).toBe(0)
    })

    it("counts each run, including one that set nothing", async () => {
      await run(mgr.createSession("/work"), {})
      await run(mgr.applyScriptEnv({ env: {}, generation: mgr.getGeneration() }))
      await run(mgr.applyScriptEnv({ env: {}, generation: mgr.getGeneration() }))

      expect((await run(mgr.getMetadata())).executionCount).toBe(2)
    })

    it("is a no-op when no session exists", async () => {
      await run(mgr.createSession("/work"), {})
      const generation = mgr.getGeneration()
      mgr.deleteSession()

      await run(mgr.applyScriptEnv({ env: { X: "1" }, generation }))

      await expect(run(mgr.getExecContext())).rejects.toThrow()
    })
  })

  describe("appendToPath", () => {
    it("adds the directories the session's PATH lacks to its end, and returns them", async () => {
      await run(mgr.createSession("/work"), { PATH: "/usr/bin:/bin" })

      const added = await run(mgr.appendToPath(["/bin", "/opt/bin"], ":"))

      expect(added).toEqual(["/opt/bin"])
      expect((await run(mgr.getExecContext())).env.PATH).toBe("/usr/bin:/bin:/opt/bin")
    })

    it("adds them to the env the session started from too, so the saved changes leave PATH out", async () => {
      await run(mgr.createSession("/work"), { PATH: "/usr/bin" })
      const states: SessionState[] = []
      mgr.setChangeListener((state) => states.push(state))

      await run(mgr.appendToPath(["/opt/bin"], ":"))

      expect(states.at(-1)?.env).toEqual({ set: {}, unset: [] })
      // Resetting goes back to the env the session started from, which has them.
      await run(mgr.resetSession())
      expect((await run(mgr.getExecContext())).env.PATH).toBe("/usr/bin:/opt/bin")
    })

    it("keeps a PATH a script changed as a saved change, with the directories added", async () => {
      await run(mgr.createSession("/work"), { PATH: "/usr/bin" })
      await run(
        mgr.applyScriptEnv({
          env: { PATH: "/home/me/.local/bin:/usr/bin" },
          generation: mgr.getGeneration(),
        }),
      )
      const states: SessionState[] = []
      mgr.setChangeListener((state) => states.push(state))

      await run(mgr.appendToPath(["/opt/bin"], ":"))

      expect(states.at(-1)?.env).toEqual({
        set: { PATH: "/home/me/.local/bin:/usr/bin:/opt/bin" },
        unset: [],
      })
    })

    it("is a no-op for a session that has been replaced", async () => {
      await run(mgr.createSession("/old"), { PATH: "/usr/bin" })
      const previous = mgr.getGeneration()
      await run(mgr.createSession("/new"), { PATH: "/usr/bin" })

      expect(await run(mgr.appendToPath(["/opt/bin"], ":", previous))).toEqual([])
      expect((await run(mgr.getExecContext())).env.PATH).toBe("/usr/bin")
    })

    it("fails when no session", async () => {
      await expect(run(mgr.appendToPath(["/opt/bin"], ":"))).rejects.toThrow()
    })
  })

  describe("setStartingEnv", () => {
    it("sets and unsets vars as if the session had started with them, out of its saved changes", async () => {
      await run(mgr.createSession("/work"), { SSL_CERT_FILE: "/etc/corp.pem", KEEP: "1" })
      const states: SessionState[] = []
      mgr.setChangeListener((state) => states.push(state))

      await run(
        mgr.setStartingEnv({ SSL_CERT_FILE: undefined, GIT_SSL_CAINFO: "/data/bundle.pem" }),
      )

      const { env } = await run(mgr.getExecContext())
      expect(env).toEqual({ KEEP: "1", GIT_SSL_CAINFO: "/data/bundle.pem" })
      expect(states.at(-1)?.env).toEqual({ set: {}, unset: [] })
      // Resetting goes back to the env the session started from, which has them.
      await run(mgr.resetSession())
      expect((await run(mgr.getExecContext())).env).toEqual(env)
    })

    it("keeps a value a script set, as a saved change", async () => {
      await run(mgr.createSession("/work"), {})
      await run(
        mgr.applyScriptEnv({
          env: { SSL_CERT_FILE: "/script/own.pem" },
          generation: mgr.getGeneration(),
        }),
      )
      const states: SessionState[] = []
      mgr.setChangeListener((state) => states.push(state))

      await run(mgr.setStartingEnv({ SSL_CERT_FILE: "/data/bundle.pem" }))

      expect((await run(mgr.getExecContext())).env.SSL_CERT_FILE).toBe("/script/own.pem")
      expect(states.at(-1)?.env).toEqual({ set: { SSL_CERT_FILE: "/script/own.pem" }, unset: [] })
    })

    it("fails when no session", async () => {
      await expect(run(mgr.setStartingEnv({ X: "1" }))).rejects.toThrow()
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

  describe("generation-scoped writes", () => {
    it("getGeneration changes with every createSession, and only the live one is current", async () => {
      await run(mgr.createSession("/a", "/a/runbook.mdx"), {})
      const a = mgr.getGeneration()
      expect(mgr.isCurrentGeneration(a)).toBe(true)

      await run(mgr.createSession("/b", "/b/runbook.mdx"), {})
      expect(mgr.getGeneration()).not.toBe(a)
      expect(mgr.isCurrentGeneration(a)).toBe(false)
      expect(mgr.isCurrentGeneration(mgr.getGeneration())).toBe(true)

      mgr.deleteSession()
      expect(mgr.isCurrentGeneration(mgr.getGeneration())).toBe(false)
    })

    it("a write started in runbook A that lands after runbook B opened changes nothing in B", async () => {
      // Runbook A: an auth handler or clone captures the generation, then awaits.
      await run(mgr.createSession("/a", "/a/runbook.mdx"), { SHARED: "a" })
      const a = mgr.getGeneration()

      // The user opens runbook B before A's request finishes.
      await run(mgr.createSession("/b", "/b/runbook.mdx"), { SHARED: "b" })

      await run(mgr.applyScriptEnv({ env: { GITHUB_TOKEN: "token-from-a" }, generation: a }))
      mgr.registerWorkTreePath("/a/clone", a)
      mgr.setActiveWorkTreePath("/a/clone", a)

      const ctx = await run(mgr.getExecContext())
      expect(ctx.env).toEqual({ SHARED: "b" })
      expect(mgr.getActiveWorkTreePath()).toBe("")
    })

    it("writes scoped to the live generation apply as usual", async () => {
      await run(mgr.createSession("/b", "/b/runbook.mdx"), { SHARED: "b" })
      const b = mgr.getGeneration()

      await run(mgr.applyScriptEnv({ env: { GITHUB_TOKEN: "token-from-b" }, generation: b }))
      mgr.registerWorkTreePath("/b/clone-1", b)
      mgr.registerWorkTreePath("/b/clone-2", b)
      mgr.setActiveWorkTreePath("/b/clone-1", b)

      const ctx = await run(mgr.getExecContext())
      expect(ctx.env).toEqual({ SHARED: "b", GITHUB_TOKEN: "token-from-b" })
      expect(mgr.getActiveWorkTreePath()).toBe("/b/clone-1")
    })

    it("a sign-in still fails, not no-ops, when there is no session at all", async () => {
      await run(mgr.createSession("/a"), {})
      const a = mgr.getGeneration()
      mgr.deleteSession()

      await expect(run(mgr.setEnvExport("aws", { env: {}, clears: [] }, a))).rejects.toThrow()
      await expect(run(mgr.clearEnvExport("aws", a))).rejects.toThrow()
    })
  })
})
