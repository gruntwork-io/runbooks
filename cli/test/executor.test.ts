import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { TestExecutor } from "./executor.ts"
import { loadConfig, type CleanupAction } from "./config.ts"

// Resolve relative to the test file so this works regardless of cwd.
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..")
const FIXTURE_DIR = path.join(REPO_ROOT, "testdata", "sample-runbooks", "my-first-runbook")
const RUNBOOK = path.join(FIXTURE_DIR, "runbook.mdx")

const fixtureAvailable =
  fs.existsSync(RUNBOOK) && fs.existsSync(path.join(FIXTURE_DIR, "runbook_test.yml"))

const maybe = fixtureAvailable ? describe : describe.skip

maybe("TestExecutor — fixture smoke", () => {
  let tmpWorkDir: string
  let executor: TestExecutor

  beforeEach(() => {
    tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-exec-test-"))
    executor = new TestExecutor(RUNBOOK, tmpWorkDir, "generated", {
      timeout: 30_000,
      verbose: false,
    })
  })

  afterEach(() => {
    fs.rmSync(tmpWorkDir, { recursive: true, force: true })
  })

  it("init() parses the fixture runbook without throwing", async () => {
    await executor.init()
    // init populates internal state — if it didn't throw, the executable
    // registry, validator, template parsers, and auth-deps all loaded.
  })

  it("loadConfig parses the fixture's runbook_test.yml", () => {
    const cfg = loadConfig(path.join(FIXTURE_DIR, "runbook_test.yml"))
    expect(cfg.version).toBe(1)
    expect(cfg.tests.length).toBeGreaterThan(0)
    // The fixture contains a 'happy-path' test case.
    const names = cfg.tests.map((t) => t.name)
    expect(names).toContain("happy-path")
  })
})

// ---------------------------------------------------------------------------
// Failure-path: a runbook with an unknown block type should surface a
// config error during init() (validator picks it up).
// ---------------------------------------------------------------------------

describe("TestExecutor — config-error surfacing", () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rb-exec-bad-"))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("parses a runbook with an unknown block without throwing", async () => {
    const rb = path.join(tmp, "runbook.mdx")
    fs.writeFileSync(rb, `# Bad Runbook\n\n<MysteryBlock id="x" />\n`)

    const executor = new TestExecutor(rb, tmp, "generated", {
      timeout: 5_000,
      verbose: false,
    })
    // init() should succeed; the validator records the error internally so
    // runTest can surface it. We assert init does not throw.
    await executor.init()
  })
})

// ---------------------------------------------------------------------------
// GitClone with source="local": adopt a checkout that already exists instead
// of cloning it.
// ---------------------------------------------------------------------------

describe("TestExecutor — GitClone local checkout", () => {
  let tmp: string

  const runLocalGitClone = async (repoDir: string) => {
    const rb = path.join(tmp, "runbook.mdx")
    fs.writeFileSync(
      rb,
      `# Local checkout\n\n<GitClone id="repo" source="local" prefilledRepoDir="${repoDir}" />\n`,
    )
    const executor = new TestExecutor(rb, tmp, "generated", { timeout: 30_000, verbose: false })
    await executor.init()
    return executor.runTest({
      name: "local",
      steps: [{ block: "repo", expect: "success" }],
    })
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rb-exec-local-"))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("adopts an existing checkout and emits clone_path", async () => {
    const repo = path.join(tmp, "checkout")
    fs.mkdirSync(repo)
    execFileSync("git", ["init", "-q"], { cwd: repo })
    fs.writeFileSync(path.join(repo, "main.tf"), "# tf\n")
    execFileSync("git", ["add", "."], { cwd: repo })

    const result = await runLocalGitClone(repo)

    expect(result.stepResults[0]?.actualStatus).toBe("success")
    // git init resolves through symlinks on macOS (/var → /private/var), so
    // compare against the repo's own resolved path.
    expect(result.stepResults[0]?.outputs?.clone_path).toBe(fs.realpathSync(repo))
    expect(result.stepResults[0]?.outputs?.file_count).toBe("1")
  })

  it("fails when the directory is not a git repository", async () => {
    const notARepo = path.join(tmp, "notes")
    fs.mkdirSync(notARepo)

    const result = await runLocalGitClone(notARepo)

    expect(result.stepResults[0]?.actualStatus).toBe("fail")
    expect(result.stepResults[0]?.error).toMatch(/Not a git repository/)
  })
})

// ---------------------------------------------------------------------------
// Cleanup: runs from the output dir even when no block generated files, a
// failing action never aborts the run, and it still runs when block
// processing throws.
// ---------------------------------------------------------------------------

describe("TestExecutor — cleanup", () => {
  let tmp: string
  let marker: string
  let warn: ReturnType<typeof spyOn>

  const runWithCleanup = async (command: string, cleanup: CleanupAction[]) => {
    const rb = path.join(tmp, "runbook.mdx")
    fs.writeFileSync(rb, `# Cleanup\n\n<Command id="run" command='${command}' />\n`)
    const executor = new TestExecutor(rb, tmp, "generated", { timeout: 30_000, verbose: false })
    await executor.init()
    return () => executor.runTest({ name: "cleanup", cleanup })
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rb-exec-cleanup-"))
    marker = path.join(tmp, "marker")
    warn = spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("runs in the output dir even when no block generated files", async () => {
    const runTest = await runWithCleanup("echo hi", [{ command: `pwd -P > "${marker}"` }])

    const result = runTest()

    expect(result.status).toBe("passed")
    expect(fs.readFileSync(marker, "utf-8").trim()).toBe(
      fs.realpathSync(path.join(tmp, "generated")),
    )
    expect(warn).not.toHaveBeenCalled()
  })

  it("warns about a missing cleanup script and runs the remaining actions", async () => {
    const runTest = await runWithCleanup("echo hi", [
      { path: "cleanup/missing.sh" },
      { command: `touch "${marker}"` },
    ])

    const result = runTest()

    expect(result.status).toBe("passed")
    expect(fs.existsSync(marker)).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/cleanup "cleanup\/missing\.sh" failed: ENOENT/)
  })

  it("warns with the exit code and stderr of a failing cleanup command", async () => {
    const runTest = await runWithCleanup("echo hi", [{ command: "echo teardown broke >&2; exit 3" }])

    expect(runTest().status).toBe("passed")
    expect(String(warn.mock.calls[0]?.[0])).toContain("failed: exit code 3: teardown broke")
  })

  it("still runs when block processing throws", async () => {
    // A dangling symlink in $GENERATED_FILES makes file capture throw ENOENT
    // out of runTest.
    const runTest = await runWithCleanup(
      'ln -s /nonexistent/target "$GENERATED_FILES/dangling"',
      [{ command: `touch "${marker}"` }],
    )

    expect(runTest).toThrow(/ENOENT/)
    expect(fs.existsSync(marker)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Explicit steps: run in the order listed (a block may appear more than once),
// and `expect: blocked` is judged before any template rendering.
// ---------------------------------------------------------------------------

describe("TestExecutor — explicit steps", () => {
  let tmp: string

  const makeExecutor = async (mdx: string) => {
    const rb = path.join(tmp, "runbook.mdx")
    fs.writeFileSync(rb, mdx)
    const executor = new TestExecutor(rb, tmp, "generated", { timeout: 30_000, verbose: false })
    await executor.init()
    return executor
  }

  // The runbook from the testing docs' "Out-of-Order Testing" example.
  const OUTPUTS_RUNBOOK = [
    "# Outputs",
    "",
    `<Command id="create-account" command='echo "account_id=123" >> "$RUNBOOK_OUTPUT"' />`,
    "",
    `<Command id="create-resources" command="echo {{ .outputs.create_account.account_id }}" />`,
    "",
  ].join("\n")

  const blockedOnAccount = {
    block: "create-resources",
    expect: "blocked" as const,
    missing_outputs: ["outputs.create_account.account_id"],
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rb-exec-steps-"))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("runs steps in the order listed, once per step", async () => {
    const executor = await makeExecutor(OUTPUTS_RUNBOOK)

    const result = executor.runTest({
      name: "out-of-order",
      steps: [
        blockedOnAccount,
        { block: "create-account", expect: "success" },
        { block: "create-resources", expect: "success" },
      ],
    })

    expect(result.error).toBeUndefined()
    expect(result.status).toBe("passed")
    expect(result.stepResults.map((s) => [s.block, s.actualStatus])).toEqual([
      ["command:create-resources", "blocked"],
      ["command:create-account", "success"],
      ["command:create-resources", "success"],
    ])
    expect(result.stepResults[2]?.logs).toContain("123")
  })

  it("fails a blocked expectation once the dependency has produced the output", async () => {
    const executor = await makeExecutor(OUTPUTS_RUNBOOK)

    const result = executor.runTest({
      name: "not-blocked",
      steps: [{ block: "create-account", expect: "success" }, blockedOnAccount],
    })

    expect(result.status).toBe("failed")
    expect(result.stepResults[1]?.actualStatus).toBe("not_blocked")
  })

  it("fails, without running anything, when a step names an unknown block", async () => {
    const executor = await makeExecutor(OUTPUTS_RUNBOOK)

    const result = executor.runTest({
      name: "typo",
      steps: [
        { block: "create-account", expect: "success" },
        { block: "create-acount", expect: "success" },
      ],
    })

    expect(result.status).toBe("failed")
    expect(result.error).toBe('Test step 2 references unknown block "create-acount"')
    expect(result.stepResults).toEqual([])
  })

  it("passes a blocked expectation when the block's auth block hasn't run or was skipped", async () => {
    const executor = await makeExecutor(
      `# Auth\n\n<AwsAuth id="aws" />\n\n<Command id="deploy" awsAuthId="aws" command="echo deploy" />\n`,
    )

    const notRun = executor.runTest({
      name: "auth-not-run",
      steps: [{ block: "deploy", expect: "blocked" }],
    })
    expect(notRun.error).toBeUndefined()
    expect(notRun.stepResults[0]?.actualStatus).toBe("blocked")

    const skipped = executor.runTest({
      name: "auth-skipped",
      steps: [
        { block: "aws", expect: "skip" },
        { block: "deploy", expect: "blocked" },
      ],
    })
    expect(skipped.error).toBeUndefined()
    expect(skipped.stepResults[1]?.actualStatus).toBe("blocked")
  })
})
