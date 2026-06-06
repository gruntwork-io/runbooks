/**
 * Integration tests for the live GitClient implementation, run against a real
 * temporary git repository (not a stub).
 *
 * These are the regression guard for the `git.diff()` originalContent bug: the
 * workspace unit tests stub `git.diff` to *return* `originalContent`, so they
 * pass even when the real implementation never populates it. Only a test that
 * drives the actual `GitCliClientLive` layer against real git catches that.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect, Layer } from "effect"
import { GitClient } from "../services/GitClient.ts"
import { GitCliClientLive } from "./GitCliClient.ts"
import { ChildProcessSpawnerLive } from "./ChildProcessSpawner.ts"

const layer = GitCliClientLive.pipe(Layer.provide(ChildProcessSpawnerLive))

const runDiff = (repoPath: string, filePath?: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const git = yield* GitClient
      return yield* git.diff(repoPath, filePath)
    }).pipe(Effect.provide(layer)),
  )

const runStageAll = (repoPath: string, excludePaths: string[] = []) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const git = yield* GitClient
      return yield* git.stageAll(repoPath, excludePaths)
    }).pipe(Effect.provide(layer)),
  )

const runCommitEither = (
  repoPath: string,
  message: string,
  options?: { allowEmpty?: boolean; author?: { name: string; email: string } },
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const git = yield* GitClient
      return yield* git.commit(repoPath, message, options)
    }).pipe(Effect.provide(layer), Effect.either),
  )

/** Stand-in for the authenticated GitLab/GitHub user threaded into commits. */
const TEST_AUTHOR = { name: "Authed User", email: "authed@example.com" }

/** git config args shared by the deterministic helpers below. */
const GIT_CONFIG = [
  "-c", "user.email=test@example.com",
  "-c", "user.name=Test",
  "-c", "commit.gpgsign=false",
  "-c", "init.defaultBranch=main",
]

/** Run git in the repo with deterministic, environment-independent config. */
function git(repoPath: string, ...args: string[]): void {
  execFileSync("git", [...GIT_CONFIG, ...args], { cwd: repoPath, stdio: "pipe" })
}

/** Like `git`, but returns stdout (for inspecting the index, etc.). */
function gitOut(repoPath: string, ...args: string[]): string {
  return execFileSync("git", [...GIT_CONFIG, ...args], {
    cwd: repoPath,
    stdio: ["pipe", "pipe", "pipe"],
  }).toString()
}

/** Restore (or delete) a process.env var captured before a test mutated it. */
function restoreEnv(key: string, saved: string | undefined): void {
  if (saved === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = saved
  }
}

describe("GitCliClientLive.diff (real repo)", () => {
  let repoPath: string

  beforeEach(() => {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-gitdiff-"))
    git(repoPath, "init")
    fs.writeFileSync(path.join(repoPath, "tracked.txt"), "line one\nline two\n")
    git(repoPath, "add", "tracked.txt")
    git(repoPath, "commit", "-m", "initial")
  })

  afterEach(() => {
    fs.rmSync(repoPath, { recursive: true, force: true })
  })

  it("populates originalContent from HEAD for a modified file", async () => {
    fs.writeFileSync(path.join(repoPath, "tracked.txt"), "line one\nCHANGED\n")

    const entries = await runDiff(repoPath)
    const entry = entries.find((e) => e.path === "tracked.txt")

    expect(entry).toBeDefined()
    // The committed (HEAD) version, not the working-tree version.
    expect(entry?.originalContent).toBe("line one\nline two")
    expect(entry?.additions).toBeGreaterThan(0)
    expect(entry?.deletions).toBeGreaterThan(0)
  })

  it("populates originalContent from HEAD for a deleted file", async () => {
    fs.rmSync(path.join(repoPath, "tracked.txt"))

    const entries = await runDiff(repoPath)
    const entry = entries.find((e) => e.path === "tracked.txt")

    expect(entry).toBeDefined()
    expect(entry?.originalContent).toBe("line one\nline two")
  })

  it("leaves originalContent undefined for a file not in HEAD", async () => {
    // Stage a brand-new file, then modify it in the working tree. The
    // worktree-vs-index diff surfaces it, but there is no HEAD version to read,
    // so originalContent must stay undefined rather than error out.
    fs.writeFileSync(path.join(repoPath, "fresh.txt"), "brand new\n")
    git(repoPath, "add", "fresh.txt")
    fs.writeFileSync(path.join(repoPath, "fresh.txt"), "brand new\nmore\n")

    const entries = await runDiff(repoPath, "fresh.txt")
    const entry = entries.find((e) => e.path === "fresh.txt")

    expect(entry).toBeDefined()
    expect(entry?.originalContent).toBeUndefined()
  })
})

describe("GitCliClientLive.stageAll (real repo)", () => {
  let repoPath: string

  beforeEach(() => {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-gitstage-"))
    git(repoPath, "init")
    // A plain untracked file that SHOULD be staged.
    fs.writeFileSync(path.join(repoPath, "normal.txt"), "hello\n")
    // An embedded git repository (nested .git) — git reports it as `sub/` and
    // `git add -A` would otherwise stage it as a submodule gitlink (mode 160000).
    const sub = path.join(repoPath, "sub")
    fs.mkdirSync(sub)
    git(sub, "init")
    fs.writeFileSync(path.join(sub, "inner.txt"), "inner\n")
    git(sub, "add", "inner.txt")
    git(sub, "commit", "-m", "sub initial")
  })

  afterEach(() => {
    fs.rmSync(repoPath, { recursive: true, force: true })
  })

  it("excludes an embedded repo from the index while staging the rest", async () => {
    await runStageAll(repoPath, ["sub"])

    const staged = gitOut(repoPath, "ls-files", "--stage")
    expect(staged).toContain("normal.txt")
    // No gitlink (mode 160000) for the embedded repo.
    expect(staged).not.toContain("160000")
    expect(staged).not.toContain("sub")
  })

  it("without excludes, stages the embedded repo as a gitlink (control)", async () => {
    await runStageAll(repoPath, [])

    const staged = gitOut(repoPath, "ls-files", "--stage")
    expect(staged).toContain("normal.txt")
    // The embedded repo lands as a mode-160000 submodule pointer — the broken
    // behavior the excludePaths argument exists to prevent.
    expect(staged).toContain("160000")
    expect(staged).toContain("sub")
  })
})

describe("GitCliClientLive.commit (real repo)", () => {
  let repoPath: string
  let savedConfigGlobal: string | undefined
  let savedConfigSystem: string | undefined

  beforeEach(() => {
    // Make git ignore any *ambient* (global/system) identity so these tests
    // exercise the layer's own identity handling deterministically — the repo
    // starts with NO resolvable identity on every machine, dev laptop or clean
    // CI runner. (GitCliClientLive runs git via gitSpawnEnv(), which spreads
    // process.env, so these reach the real commit too.)
    savedConfigGlobal = process.env.GIT_CONFIG_GLOBAL
    savedConfigSystem = process.env.GIT_CONFIG_SYSTEM
    process.env.GIT_CONFIG_GLOBAL = "/dev/null"
    process.env.GIT_CONFIG_SYSTEM = "/dev/null"

    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-gitcommit-"))
    // The git() helper supplies identity per-invocation via -c, so the setup
    // commit succeeds without persisting any identity into the repo.
    git(repoPath, "init")
    fs.writeFileSync(path.join(repoPath, "tracked.txt"), "one\n")
    git(repoPath, "add", "tracked.txt")
    git(repoPath, "commit", "-m", "initial")
  })

  afterEach(() => {
    fs.rmSync(repoPath, { recursive: true, force: true })
    restoreEnv("GIT_CONFIG_GLOBAL", savedConfigGlobal)
    restoreEnv("GIT_CONFIG_SYSTEM", savedConfigSystem)
  })

  it("surfaces git's stdout reason when there is nothing to commit (exit 1)", async () => {
    // `git commit` with a clean tree exits 1 and prints "nothing to commit,
    // working tree clean" to STDOUT (not stderr). The error must carry that
    // reason instead of a bare "exit 1" — this is exactly the MR-block failure.
    // A fallback author is supplied so the failure is the clean-tree one, not
    // "author identity unknown".
    const result = await runCommitEither(repoPath, "[skip ci] no-op commit", {
      author: TEST_AUTHOR,
    })

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.exitCode).not.toBe(0)
      expect(result.left.stderr.toLowerCase()).toContain("nothing to commit")
      // command carries the "git " prefix exactly once, and the injected
      // identity is passed via env — never leaked into the command string.
      expect(result.left.command.startsWith("git commit")).toBe(true)
      expect(result.left.command).not.toContain("authed@example.com")
    }
  })

  it("commits as the fallback author when the repo has no configured identity", async () => {
    // The MR/PR failure mode: a machine with no git identity. The layer must
    // commit as the authenticated user instead of dying with "author identity
    // unknown".
    fs.writeFileSync(path.join(repoPath, "tracked.txt"), "one\ntwo\n")
    await runStageAll(repoPath, [])

    const result = await runCommitEither(repoPath, "add line two", {
      author: TEST_AUTHOR,
    })

    expect(result._tag).toBe("Right")
    expect(gitOut(repoPath, "log", "--oneline")).toContain("add line two")
    expect(gitOut(repoPath, "log", "-1", "--format=%an <%ae>").trim()).toBe(
      "Authed User <authed@example.com>",
    )
  })

  it("respects the repo's configured identity over the fallback author", async () => {
    // When the user HAS a git identity, theirs wins — the fallback is ignored.
    git(repoPath, "config", "user.name", "Local Dev")
    git(repoPath, "config", "user.email", "local@example.com")
    fs.writeFileSync(path.join(repoPath, "tracked.txt"), "one\ntwo\n")
    await runStageAll(repoPath, [])

    const result = await runCommitEither(repoPath, "respect local identity", {
      author: TEST_AUTHOR,
    })

    expect(result._tag).toBe("Right")
    expect(gitOut(repoPath, "log", "-1", "--format=%an <%ae>").trim()).toBe(
      "Local Dev <local@example.com>",
    )
  })

  it("fails with 'author identity unknown' when no identity and no fallback author", async () => {
    // Regression guard: without the fallback author, an unconfigured machine
    // can't commit — exactly the bug the author option fixes. useConfigOnly
    // disables git's gecos-based auto-detection so the failure is deterministic
    // on dev machines too (CI runners have an empty gecos and fail anyway).
    git(repoPath, "config", "user.useConfigOnly", "true")
    fs.writeFileSync(path.join(repoPath, "tracked.txt"), "one\ntwo\n")
    await runStageAll(repoPath, [])

    const result = await runCommitEither(repoPath, "no identity available")

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.stderr.toLowerCase()).toContain("author identity unknown")
    }
  })
})
