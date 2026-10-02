import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { TestExecutor } from "./executor.ts"
import { loadConfig, type CleanupAction, type ExpectedStatus } from "./config.ts"

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
// Blocks run in document order, even when block types are interleaved.
// ---------------------------------------------------------------------------

describe("TestExecutor — block order", () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rb-exec-order-"))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("runs an interleaved Check/Command/Check runbook top to bottom", async () => {
    const rb = path.join(tmp, "runbook.mdx")
    fs.writeFileSync(
      rb,
      [
        "# Ordered",
        "",
        '<Check id="check-first" command="echo first" />',
        "",
        '<Command id="setup" command="touch setup-done" />',
        "",
        '<Check id="verify-setup" command="test -f setup-done" />',
        "",
      ].join("\n"),
    )
    const executor = new TestExecutor(rb, tmp, "generated", { timeout: 30_000, verbose: false })
    await executor.init()

    // No explicit steps: every block runs, in the order the validator lists them
    const result = await executor.runTest({ name: "ordered" })

    expect(result.stepResults.map((r) => r.block)).toEqual([
      "check:check-first",
      "command:setup",
      "check:verify-setup",
    ])
    expect(result.status).toBe("passed")
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

  const runWithCleanup = async (
    command: string,
    cleanup: CleanupAction[],
    env?: Record<string, string>,
  ) => {
    const rb = path.join(tmp, "runbook.mdx")
    fs.writeFileSync(rb, `# Cleanup\n\n<Command id="run" command='${command}' />\n`)
    const executor = new TestExecutor(rb, tmp, "generated", { timeout: 30_000, verbose: false })
    await executor.init()
    return () => executor.runTest({ name: "cleanup", cleanup, env })
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

  it("sees the test case's env and what earlier blocks exported", async () => {
    const runTest = await runWithCleanup(
      "export FROM_BLOCK=exported",
      [{ command: `echo "$FROM_BLOCK $FROM_TEST" > "${marker}"` }],
      { FROM_TEST: "test-env" },
    )

    expect(runTest().status).toBe("passed")
    expect(fs.readFileSync(marker, "utf-8").trim()).toBe("exported test-env")
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

  it("skips a block whose auth block hasn't run when the step expects skip", async () => {
    const executor = await makeExecutor(
      `# Auth\n\n<AwsAuth id="aws" />\n\n<Command id="deploy" awsAuthId="aws" command="echo deploy" />\n`,
    )

    const result = executor.runTest({ name: "skip", steps: [{ block: "deploy", expect: "skip" }] })

    expect(result.error).toBeUndefined()
    expect(result.stepResults[0]?.actualStatus).toBe("skipped")
  })
})

// ---------------------------------------------------------------------------
// Session env and cwd: a bash block's exports and final cwd carry into later
// blocks, as they do in the app, but nothing carries into the next test case.
// ---------------------------------------------------------------------------

describe("TestExecutor — session env and cwd", () => {
  let tmp: string

  // `report` records what it sees as outputs, so a test can check which
  // exports, credentials and cwd reached it.
  const report = [
    "foo=${ISO_FOO:-unset}",
    "tc_env=${ISO_TC_ENV:-unset}",
    "token=${GITHUB_TOKEN:-unset}",
    "cwd=$(pwd -P)",
  ].map((line) => `echo "${line}" >> "$RUNBOOK_OUTPUT"`).join("; ")
  const RUNBOOK = [
    "# Session",
    "",
    `<GitHubAuth id="gh" />`,
    "",
    `<Command id="set-env" command='export ISO_FOO=bar; mkdir -p sub; cd sub' />`,
    "",
    `<Check id="report" command='${report}' />`,
    "",
  ].join("\n")

  const makeExecutor = async () => {
    const rb = path.join(tmp, "runbook.mdx")
    fs.writeFileSync(rb, RUNBOOK)
    const executor = new TestExecutor(rb, tmp, "generated", { timeout: 30_000, verbose: false })
    await executor.init()
    return executor
  }

  const reported = (result: ReturnType<TestExecutor["runTest"]>) =>
    result.stepResults.find((s) => s.block === "check:report")?.outputs ?? {}

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rb-exec-session-"))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("carries a bash block's exports and cd into the next block", async () => {
    const executor = await makeExecutor()

    const result = executor.runTest({
      name: "persist",
      steps: [
        { block: "set-env", expect: "success" },
        { block: "report", expect: "success" },
      ],
    })

    expect(result.error).toBeUndefined()
    expect(reported(result).foo).toBe("bar")
    expect(reported(result).cwd).toBe(fs.realpathSync(path.join(tmp, "sub")))
  })

  it("doesn't carry exports, cwd, tc.env or auth credentials into the next test case", async () => {
    const executor = await makeExecutor()

    const first = executor.runTest({
      name: "first",
      env: { ISO_TC_ENV: "from-first", RUNBOOKS_GITHUB_TOKEN: "first-test-token" },
      steps: [
        { block: "gh", expect: "success" },
        { block: "set-env", expect: "success" },
        { block: "report", expect: "success" },
      ],
    })
    expect(first.error).toBeUndefined()
    expect(reported(first)).toMatchObject({
      foo: "bar",
      tc_env: "from-first",
      token: "first-test-token",
    })

    const second = executor.runTest({
      name: "second",
      steps: [{ block: "report", expect: "success" }],
    })

    expect(second.error).toBeUndefined()
    expect(reported(second).foo).toBe("unset")
    expect(reported(second).tc_env).toBe("unset")
    expect(reported(second).token).not.toBe("first-test-token")
    expect(reported(second).cwd).toBe(fs.realpathSync(tmp))
  })

  it("gives script assertions the test case's env before any bash block has run", async () => {
    const executor = await makeExecutor()

    const result = executor.runTest({
      name: "assert-env",
      env: { ISO_TC_ENV: "from-test" },
      // Nothing runs, so nothing has captured the test's env into the session
      steps: [{ block: "set-env", expect: "skip" }],
      assertions: [{ type: "script", command: 'test "${ISO_TC_ENV:-unset}" = from-test' }],
    })

    expect(result.error).toBeUndefined()
    expect(result.assertions[0]?.passed).toBe(true)
  })

  it("runs each test case in the working dir it is given", async () => {
    const executor = await makeExecutor()
    const other = path.join(tmp, "other")
    fs.mkdirSync(other)

    const result = executor.runTest({ name: "other-dir", steps: [{ block: "report", expect: "success" }] }, other)

    expect(reported(result).cwd).toBe(fs.realpathSync(other))
  })

  it("filters shell internals and per-block vars out of the capture, as the app does", async () => {
    const rb = path.join(tmp, "runbook.mdx")
    const shlvl = `<Command id="ID" command='echo "shlvl=$SHLVL" >> "$RUNBOOK_OUTPUT"' />`
    fs.writeFileSync(rb, ["# Filter", ...["a", "b", "c"].map((id) => `\n${shlvl.replace("ID", id)}`), ""].join("\n"))
    const executor = new TestExecutor(rb, tmp, "generated", { timeout: 30_000, verbose: false })
    await executor.init()

    const result = executor.runTest({
      name: "filter",
      // Script assertions run with the session env, so a captured
      // RUNBOOK_OUTPUT would point at a block's deleted output file.
      assertions: [{ type: "script", command: 'test -z "${RUNBOOK_OUTPUT:-}"' }],
    })

    expect(result.error).toBeUndefined()
    // bash bumps SHLVL on start; if the capture kept it, it would climb by
    // one per block. (Block a starts from the process env, so compare b, c.)
    const [, b, c] = result.stepResults
    expect(b?.outputs.shlvl).toBeDefined()
    expect(c?.outputs.shlvl).toBe(b?.outputs.shlvl)
  })
})

// ---------------------------------------------------------------------------
// RUNBOOK_OUTPUT is parsed by the app's parser, so outputs match the app's.
// ---------------------------------------------------------------------------

describe("TestExecutor — block outputs", () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rb-exec-outputs-"))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("keeps value whitespace and skips lines without a valid key", async () => {
    const rb = path.join(tmp, "runbook.mdx")
    fs.writeFileSync(
      rb,
      `# Outputs\n\n<Command id="out" command='printf "MSG= hi\\n=no-key\\nbad-key=x\\nOK=1\\n" >> "$RUNBOOK_OUTPUT"' />\n`,
    )
    const executor = new TestExecutor(rb, tmp, "generated", { timeout: 30_000, verbose: false })
    await executor.init()

    const result = executor.runTest({ name: "outputs" })

    expect(result.stepResults[0]?.outputs).toEqual({ MSG: " hi", OK: "1" })
  })
})

// ---------------------------------------------------------------------------
// files_generated counts the files the named block wrote this test case, not
// whatever happens to be in the output dir.
// ---------------------------------------------------------------------------

describe("TestExecutor — files_generated", () => {
  let tmp: string

  const makeExecutor = async (blocks: string[]) => {
    const tmplDir = path.join(tmp, "templates", "cfg")
    fs.mkdirSync(path.join(tmplDir, "nested"), { recursive: true })
    fs.writeFileSync(path.join(tmplDir, "boilerplate.yml"), "variables: []\n")
    fs.writeFileSync(path.join(tmplDir, "main.tf"), "# main\n")
    fs.writeFileSync(path.join(tmplDir, "nested", "vars.tf"), "# vars\n")

    const rb = path.join(tmp, "runbook.mdx")
    fs.writeFileSync(rb, ["# Files", ...blocks, ""].join("\n\n"))
    const executor = new TestExecutor(rb, tmp, "generated", { timeout: 30_000, verbose: false })
    await executor.init()
    return executor
  }

  const RUNBOOK_BLOCKS = [
    `<Template id="tmpl" path="templates/cfg" />`,
    `<TemplateInline id="inline" outputPath="inline.txt" generateFile={true}>\n\`\`\`\nhello\n\`\`\`\n</TemplateInline>`,
    `<Command id="capture" command='mkdir -p "$GENERATED_FILES/sub" && echo a > "$GENERATED_FILES/a.txt" && echo b > "$GENERATED_FILES/sub/b.txt"' />`,
    `<Command id="echo-only" command="echo hi" />`,
  ]

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rb-exec-files-"))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("counts Template, TemplateInline and $GENERATED_FILES writes per block", async () => {
    const executor = await makeExecutor(RUNBOOK_BLOCKS)

    const result = executor.runTest({
      name: "generated",
      assertions: [
        { type: "files_generated", block: "tmpl", min_count: 2 },
        { type: "files_generated", block: "inline" },
        { type: "files_generated", block: "capture", min_count: 2 },
      ],
    })

    expect(result.error).toBeUndefined()
    expect(result.status).toBe("passed")
  })

  it("fails for a block that wrote nothing, though other blocks filled the output dir", async () => {
    const executor = await makeExecutor(RUNBOOK_BLOCKS)

    const result = executor.runTest({
      name: "echo-only",
      assertions: [{ type: "files_generated", block: "echo-only" }],
    })

    expect(fs.readdirSync(path.join(tmp, "generated")).length).toBeGreaterThan(0)
    expect(result.status).toBe("failed")
    expect(result.error).toBe('Assertion failed: Block "echo-only" generated 0 file(s), expected at least 1')
  })

  it("doesn't count files a block wrote in an earlier test case", async () => {
    const executor = await makeExecutor(RUNBOOK_BLOCKS)
    const assertions = [{ type: "files_generated" as const, block: "tmpl" }]

    expect(executor.runTest({ name: "first", assertions }).status).toBe("passed")
    const second = executor.runTest({
      name: "second",
      steps: [{ block: "echo-only", expect: "success" }],
      assertions,
    })

    // tmpl's files are still in the shared output dir, but tmpl didn't run
    expect(fs.existsSync(path.join(tmp, "generated", "main.tf"))).toBe(true)
    expect(second.status).toBe("failed")
  })

  it("counts files a Template wrote into the worktree", async () => {
    const repo = path.join(tmp, "checkout")
    fs.mkdirSync(repo)
    execFileSync("git", ["init", "-q"], { cwd: repo })
    const executor = await makeExecutor([
      `<GitClone id="repo" source="local" prefilledRepoDir="${repo}" />`,
      `<Template id="tmpl" path="templates/cfg" target="worktree" />`,
    ])

    const result = executor.runTest({
      name: "worktree",
      assertions: [{ type: "files_generated", block: "tmpl", min_count: 2 }],
    })

    expect(result.error).toBeUndefined()
    expect(result.status).toBe("passed")
    expect(fs.existsSync(path.join(repo, "nested", "vars.tf"))).toBe(true)
    expect(fs.existsSync(path.join(tmp, "generated"))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// A variable the test doesn't set starts from the value the app's form starts
// from: its default, else what its control shows (false for a bool, one
// element per schema key for a tuple). So a runbook that works in the app
// without touching those fields also passes its test.
// ---------------------------------------------------------------------------

describe("TestExecutor — untouched values", () => {
  let tmp: string

  const BOILERPLATE_YML = [
    "variables:",
    "  - name: dry_run",
    "    type: bool",
    "  - name: verbose",
    "    type: bool",
    "    default: true",
    "  - name: pair",
    "    type: list",
    "    x-schema:",
    '      "0": string',
    '      "1": bool',
    "",
  ].join("\n")

  const makeExecutor = async (pairRequired = false) => {
    const tmplDir = path.join(tmp, "templates", "flags")
    fs.mkdirSync(tmplDir, { recursive: true })
    fs.writeFileSync(
      path.join(tmplDir, "boilerplate.yml"),
      pairRequired ? BOILERPLATE_YML + "    validations:\n      - required\n" : BOILERPLATE_YML,
    )
    fs.writeFileSync(path.join(tmplDir, "flags.txt"), "dry_run={{ .dry_run }} verbose={{ .verbose }} pair={{ .pair }}\n")

    const rb = path.join(tmp, "runbook.mdx")
    fs.writeFileSync(
      rb,
      [
        "# Untouched",
        '<Inputs id="opts">\n```yaml\nvariables:\n  - name: confirm\n    type: bool\n```\n</Inputs>',
        '<Command id="show" inputsId="opts" command="echo confirm={{ .inputs.confirm }}" />',
        '<Template id="tmpl" path="templates/flags" />',
        "",
      ].join("\n\n"),
    )
    const executor = new TestExecutor(rb, tmp, "generated", { timeout: 30_000, verbose: false })
    await executor.init()
    return executor
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rb-exec-untouched-"))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("fills an unset bool with no default as false, in Inputs and Template blocks", async () => {
    const executor = await makeExecutor()

    const result = executor.runTest({ name: "untouched" })

    expect(result.error).toBeUndefined()
    expect(result.status).toBe("passed")
    expect(result.stepResults.find((r) => r.block === "command:show")?.logs).toContain("confirm=false")
    // A declared default still wins; the tuple is its displayed elements ('' and false).
    expect(fs.readFileSync(path.join(tmp, "generated", "flags.txt"), "utf8")).toBe("dry_run=false verbose=true pair=,false\n")
  })

  it("fails a required tuple left at its displayed elements, as the form does", async () => {
    const executor = await makeExecutor(true)

    const result = executor.runTest({ name: "untouched-required" })

    expect(result.status).toBe("failed")
    expect(result.error).toContain("tmpl.pair: pair is required")
  })

  it("uses the test's own values over the untouched ones", async () => {
    const executor = await makeExecutor(true)

    const result = executor.runTest({
      name: "set",
      inputs: {
        "opts.confirm": { literal: true },
        "tmpl.dry_run": { literal: true },
        "tmpl.pair": { literal: ["a", true] },
      },
    })

    expect(result.error).toBeUndefined()
    expect(result.stepResults.find((r) => r.block === "command:show")?.logs).toContain("confirm=true")
    expect(fs.readFileSync(path.join(tmp, "generated", "flags.txt"), "utf8")).toBe("dry_run=true verbose=true pair=a,true\n")
  })
})

// ---------------------------------------------------------------------------
// Filled-in values never replace the test's own. The CLI gives every block one
// `.inputs` map, so a variable two blocks declare must end up with the value
// the test set, and a Template variable it imports with inputsId (read-only
// and synced in the app) takes the imported value, not its own default.
// ---------------------------------------------------------------------------

describe("TestExecutor — variables two blocks declare", () => {
  let tmp: string

  const makeExecutor = async (templateProps: string, templateVars: string[], inputsBlocks: string[]) => {
    const tmplDir = path.join(tmp, "templates", "shared")
    fs.mkdirSync(tmplDir, { recursive: true })
    fs.writeFileSync(path.join(tmplDir, "boilerplate.yml"), ["variables:", ...templateVars, ""].join("\n"))
    fs.writeFileSync(
      path.join(tmplDir, "out.txt"),
      "top={{ .enable }}/{{ .Region }} inputs={{ .inputs.enable }}/{{ .inputs.Region }}\n",
    )

    const rb = path.join(tmp, "runbook.mdx")
    fs.writeFileSync(
      rb,
      [
        "# Shared",
        ...inputsBlocks,
        '<Command id="show" inputsId="opts" command="echo enable={{ .inputs.enable }} region={{ .inputs.Region }}" />',
        `<Template id="tmpl" path="templates/shared" ${templateProps}/>`,
        "",
      ].join("\n\n"),
    )
    const executor = new TestExecutor(rb, tmp, "generated", { timeout: 30_000, verbose: false })
    await executor.init()
    return executor
  }

  const inputsBlock = (id: string, vars: string[]) =>
    `<Inputs id="${id}">\n\`\`\`yaml\nvariables:\n${vars.join("\n")}\n\`\`\`\n</Inputs>`

  const ENABLE = ["  - name: enable", "    type: bool"]
  const region = (dflt: string) => ["  - name: Region", "    type: string", `    default: ${dflt}`]

  const showLogs = (result: ReturnType<TestExecutor["runTest"]>) =>
    result.stepResults.find((r) => r.block === "command:show")?.logs
  const out = () => fs.readFileSync(path.join(tmp, "generated", "out.txt"), "utf8")

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rb-exec-shared-"))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("keeps the test's value when another block's untouched value has the same name", async () => {
    // The Template doesn't import opts: its enable is its own, untouched false.
    const executor = await makeExecutor("", [...ENABLE, ...region("tmpl-region")], [
      inputsBlock("opts", [...ENABLE, ...region("opts-region")]),
    ])

    const result = executor.runTest({
      name: "set-opts",
      inputs: { "opts.enable": { literal: true }, "opts.Region": { literal: "set-region" } },
    })

    expect(result.error).toBeUndefined()
    expect(showLogs(result)).toContain("enable=true region=set-region")
  })

  it("gives a Template's shared variables the value of the block it imports", async () => {
    const executor = await makeExecutor('inputsId="opts" ', [...ENABLE, ...region("tmpl-region")], [
      inputsBlock("opts", [...ENABLE, ...region("opts-region")]),
    ])

    // enable is set by the test; Region is left at opts's default.
    const result = executor.runTest({ name: "set-opts", inputs: { "opts.enable": { literal: true } } })

    expect(result.error).toBeUndefined()
    expect(showLogs(result)).toContain("enable=true region=opts-region")
    expect(out()).toBe("top=true/opts-region inputs=true/opts-region\n")
  })

  it("takes a shared variable from the last inputsId that has it", async () => {
    const executor = await makeExecutor(`inputsId={["base", "opts"]} `, [...ENABLE, ...region("tmpl-region")], [
      inputsBlock("base", [...ENABLE, ...region("base-region")]),
      inputsBlock("opts", region("opts-region")),
    ])

    // enable comes from base (opts doesn't declare it), Region from opts.
    const result = executor.runTest({ name: "merge", inputs: { "base.enable": { literal: true } } })

    expect(result.error).toBeUndefined()
    expect(out()).toContain("top=true/opts-region")
  })

  it("still uses a value the test sets on the Template itself", async () => {
    const executor = await makeExecutor('inputsId="opts" ', [...ENABLE, ...region("tmpl-region")], [
      inputsBlock("opts", [...ENABLE, ...region("opts-region")]),
    ])

    const result = executor.runTest({ name: "set-tmpl", inputs: { "tmpl.Region": { literal: "tmpl-set" } } })

    expect(result.error).toBeUndefined()
    expect(out()).toContain("top=false/tmpl-set")
  })
})

// ---------------------------------------------------------------------------
// PR blocks: recognized and parsed, so a runbook with one can be tested, and
// a step that names one can only expect `skip` (or `blocked`).
// ---------------------------------------------------------------------------

describe("TestExecutor — PR blocks", () => {
  let tmp: string

  const RUNBOOK = [
    "# PR blocks",
    "",
    `<GitAuth id="git-auth" provider="gitlab" />`,
    "",
    `<Command id="hello" command="echo hello" />`,
    "",
    `<GitPullRequest id="pr" gitAuthId="git-auth" />`,
    "",
    `<GitHubPullRequest id="gh-pr" />`,
    "",
    `<GitLabMergeRequest id="mr" gitAuthId="git-auth" />`,
    "",
  ].join("\n")

  const makeExecutor = async () => {
    const rb = path.join(tmp, "runbook.mdx")
    fs.writeFileSync(rb, RUNBOOK)
    const executor = new TestExecutor(rb, tmp, "generated", { timeout: 30_000, verbose: false })
    await executor.init()
    return executor
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rb-exec-pr-"))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("runs a test of a runbook that contains PR blocks", async () => {
    const executor = await makeExecutor()

    const result = executor.runTest({ name: "command-only", steps: [{ block: "hello", expect: "success" }] })

    expect(result.error).toBeUndefined()
    expect(result.status).toBe("passed")
  })

  it("skips every PR block type when a step expects skip", async () => {
    const executor = await makeExecutor()

    const result = executor.runTest({
      name: "skip-prs",
      env: { GITLAB_TOKEN: "fake-gitlab-token", GITLAB_HOST: "" },
      steps: [
        { block: "git-auth", expect: "success" },
        { block: "pr", expect: "skip" },
        { block: "gh-pr", expect: "skip" },
        { block: "mr", expect: "skip" },
      ],
    })

    expect(result.error).toBeUndefined()
    expect(result.stepResults.map((s) => [s.block, s.actualStatus])).toEqual([
      ["gitAuth:git-auth", "success"],
      ["gitPullRequest:pr", "skipped"],
      ["gitHubPullRequest:gh-pr", "skipped"],
      ["gitLabMergeRequest:mr", "skipped"],
    ])
  })

  it("fails a PR step that expects anything but skip", async () => {
    const executor = await makeExecutor()

    const result = executor.runTest({ name: "run-pr", steps: [{ block: "gh-pr", expect: "success" }] })

    expect(result.status).toBe("failed")
    expect(result.error).toContain("PR blocks can only be tested with expect: skip")
  })

  it("blocks a PR block on the auth block it references", async () => {
    const executor = await makeExecutor()

    const result = executor.runTest({
      name: "pr-blocked",
      env: { GITLAB_TOKEN: "", GITLAB_ACCESS_TOKEN: "", OAUTH_TOKEN: "" },
      steps: [
        { block: "git-auth", expect: "skip" },
        { block: "mr", expect: "blocked" },
      ],
    })

    expect(result.error).toBeUndefined()
    expect(result.stepResults[1]?.actualStatus).toBe("blocked")
  })

  it("skips a PR block whose auth block hasn't run", async () => {
    const executor = await makeExecutor()

    const result = executor.runTest({
      name: "skip-pr-only",
      steps: [
        { block: "hello", expect: "success" },
        { block: "pr", expect: "skip" },
        { block: "mr", expect: "skip" },
      ],
    })

    expect(result.error).toBeUndefined()
    expect(result.stepResults.map((s) => s.actualStatus)).toEqual(["success", "skipped", "skipped"])
  })

  it("expects PR blocks to skip when the test lists no steps", async () => {
    const rb = path.join(tmp, "runbook.mdx")
    fs.writeFileSync(rb, `# PR\n\n<Command id="hello" command="echo hello" />\n\n<GitHubPullRequest id="gh-pr" />\n`)
    const executor = new TestExecutor(rb, tmp, "generated", { timeout: 30_000, verbose: false })
    await executor.init()

    const result = executor.runTest({ name: "all-blocks" })

    expect(result.error).toBeUndefined()
    expect(result.stepResults.map((s) => [s.block, s.actualStatus])).toEqual([
      ["command:hello", "success"],
      ["gitHubPullRequest:gh-pr", "skipped"],
    ])
  })
})

// ---------------------------------------------------------------------------
// Git auth: GitHubAuth, GitLabAuth and GitAuth (either provider) find a token
// in the provider's env vars and write the session vars the app writes.
// ---------------------------------------------------------------------------

describe("TestExecutor — git auth blocks", () => {
  let tmp: string

  // Blank every GitLab token and host var, so the developer's own env can't
  // leak into a test.
  const NO_GITLAB_ENV = {
    GITLAB_TOKEN: "",
    GITLAB_ACCESS_TOKEN: "",
    OAUTH_TOKEN: "",
    GITLAB_HOST: "",
    GITLAB_URI: "",
    GL_HOST: "",
  }

  const report = [
    "gitlab_token=${GITLAB_TOKEN:-unset}",
    "gitlab_host=${GITLAB_HOST:-unset}",
    "github_token=${GITHUB_TOKEN:-unset}",
  ].map((line) => `echo "${line}" >> "$RUNBOOK_OUTPUT"`).join("; ")

  /** A runbook with `authBlock` and a Command that reports what it sees. */
  const makeExecutor = async (authBlock: string) => {
    const rb = path.join(tmp, "runbook.mdx")
    fs.writeFileSync(
      rb,
      `# Git auth\n\n${authBlock}\n\n<Command id="report" gitAuthId="auth" command='${report}' />\n`,
    )
    const executor = new TestExecutor(rb, tmp, "generated", { timeout: 30_000, verbose: false })
    await executor.init()
    return executor
  }

  const runAuthThenReport = (
    executor: TestExecutor,
    env: Record<string, string>,
    authStep: { env_prefix?: string } = {},
  ) =>
    executor.runTest({
      name: "auth",
      env: { ...NO_GITLAB_ENV, ...env },
      steps: [
        { block: "auth", expect: "success", ...authStep },
        { block: "report", expect: "success" },
      ],
    })

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rb-exec-gitauth-"))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it.each([
    ["GitLabAuth", `<GitLabAuth id="auth" />`],
    ["GitAuth provider=gitlab", `<GitAuth id="auth" provider="gitlab" />`],
  ])("%s injects GITLAB_TOKEN and GITLAB_HOST", async (_name, authBlock) => {
    const executor = await makeExecutor(authBlock)

    const result = runAuthThenReport(executor, { GITLAB_ACCESS_TOKEN: "fake-gitlab-token" })

    expect(result.error).toBeUndefined()
    expect(result.stepResults[1]?.outputs).toMatchObject({
      gitlab_token: "fake-gitlab-token",
      gitlab_host: "gitlab.com",
    })
  })

  it("GitAuth defaults to GitHub and injects GITHUB_TOKEN", async () => {
    const executor = await makeExecutor(`<GitAuth id="auth" />`)

    const result = runAuthThenReport(executor, { RUNBOOKS_GITHUB_TOKEN: "fake-github-token" })

    expect(result.error).toBeUndefined()
    expect(result.stepResults[1]?.outputs?.github_token).toBe("fake-github-token")
  })

  it("reads GitLab tokens under the step's env_prefix", async () => {
    const executor = await makeExecutor(`<GitLabAuth id="auth" />`)

    const result = runAuthThenReport(executor, { CI_OAUTH_TOKEN: "prefixed-token" }, { env_prefix: "CI_" })

    expect(result.error).toBeUndefined()
    expect(result.stepResults[1]?.outputs?.gitlab_token).toBe("prefixed-token")
  })

  it("skips GitLab auth when no token is set", async () => {
    const executor = await makeExecutor(`<GitLabAuth id="auth" />`)

    // (`expect: skip` would skip the block without looking for a token.)
    const result = executor.runTest({ name: "no-token", env: NO_GITLAB_ENV, steps: [{ block: "auth", expect: "success" }] })

    expect(result.status).toBe("failed")
    expect(result.stepResults[0]?.actualStatus).toBe("skipped")
  })

  it("uses a pinned GitLab host only when the env token is bound to it", async () => {
    const executor = await makeExecutor(
      `<GitAuth id="auth" provider="gitlab" instanceUrl="https://gitlab.example.com/" />`,
    )

    const unbound = runAuthThenReport(executor, { GITLAB_TOKEN: "fake-gitlab-token" })
    expect(unbound.stepResults[0]?.actualStatus).toBe("skipped")

    const bound = runAuthThenReport(executor, {
      GITLAB_TOKEN: "fake-gitlab-token",
      GITLAB_HOST: "https://gitlab.example.com",
    })
    expect(bound.error).toBeUndefined()
    expect(bound.stepResults[1]?.outputs?.gitlab_host).toBe("gitlab.example.com")
  })

  it("skips, rather than falling back to gitlab.com, when the pinned GitLab host is invalid", async () => {
    const executor = await makeExecutor(`<GitAuth id="auth" provider="gitlab" instanceUrl="ftp://corp" />`)

    // The env token is bound to gitlab.com (no GITLAB_HOST).
    const result = runAuthThenReport(executor, { GITLAB_TOKEN: "fake-gitlab-token" })

    expect(result.stepResults[0]?.actualStatus).toBe("skipped")
  })

  it("fails a GitAuth block with an unknown provider", async () => {
    const executor = await makeExecutor(`<GitAuth id="auth" provider="bitbucket" />`)

    const result = runAuthThenReport(executor, {})

    expect(result.status).toBe("failed")
    expect(result.error).toContain('Unsupported provider "bitbucket"')
  })
})

// ---------------------------------------------------------------------------
// GitClone: a GitLab auth block's token goes to the host it is bound to, in
// git's environment, and never into the clone URL or the error.
// (cli/commands/test.test.ts clones with the token.)
// ---------------------------------------------------------------------------

describe("TestExecutor — GitClone authentication", () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rb-exec-clone-"))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("keeps a GitLab token out of the clone URL and a failed clone's error", async () => {
    const rb = path.join(tmp, "runbook.mdx")
    fs.writeFileSync(
      rb,
      // Port 1 refuses the connection, so the clone fails fast.
      `# Clone\n\n<GitLabAuth id="auth" />\n\n<GitClone id="clone" gitAuthId="auth" prefilledUrl="https://127.0.0.1:1/group/infra.git" />\n`,
    )
    const executor = new TestExecutor(rb, tmp, "generated", { timeout: 30_000, verbose: false })
    await executor.init()

    const result = executor.runTest({
      name: "clone",
      // Bind the token to the clone's host, so the clone is authenticated.
      env: { GITLAB_TOKEN: "fake-gitlab-token", GITLAB_HOST: "127.0.0.1:1", GITLAB_URI: "", GL_HOST: "" },
      steps: [
        { block: "auth", expect: "success" },
        { block: "clone", expect: "success" },
      ],
    })

    expect(result.stepResults[1]?.actualStatus).toBe("fail")
    // git was given the plain URL; the token went in its environment...
    expect(result.error).toContain("https://127.0.0.1:1/group/infra.git")
    expect(result.error).not.toContain("[REDACTED]")
    // ...and is nowhere in what's reported.
    expect(result.error).not.toContain("fake-gitlab-token")
  })
})

// ---------------------------------------------------------------------------
// GitClone with option-like values: a runbook's URL, ref or repo path must
// never reach git as an option.
// ---------------------------------------------------------------------------

describe("TestExecutor — GitClone option-like values", () => {
  let tmp: string
  let source: string
  let marker: string
  let savedCwd: string

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd,
      stdio: "pipe",
    })

  const runGitClone = async (props: Record<string, string>) => {
    const attrs = Object.entries(props)
      .map(([key, value]) => `${key}="${value}"`)
      .join(" ")
    const rb = path.join(tmp, "runbook.mdx")
    fs.writeFileSync(rb, `# Clone\n\n<GitClone id="repo" ${attrs} />\n`)
    const work = path.join(tmp, "work")
    fs.mkdirSync(work, { recursive: true })
    const executor = new TestExecutor(rb, work, "generated", { timeout: 30_000, verbose: false })
    await executor.init()
    const result = await executor.runTest({
      name: "clone",
      steps: [{ block: "repo", expect: "success" }],
    })
    return result.stepResults[0]
  }

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rb-exec-clone-")))
    source = path.join(tmp, "source")
    fs.mkdirSync(path.join(source, "modules"), { recursive: true })
    fs.writeFileSync(path.join(source, "main.tf"), "# tf\n")
    fs.writeFileSync(path.join(source, "modules", "vpc.tf"), "# vpc\n")
    git(source, "init", "-q")
    git(source, "add", ".")
    git(source, "commit", "-q", "-m", "initial")
    marker = path.join(tmp, "pwned")
    // The CLI runs git clone from the process cwd. Pin it to an empty
    // directory so a URL read as an option can't clone into the repo.
    savedCwd = process.cwd()
    fs.mkdirSync(path.join(tmp, "cwd"))
    process.chdir(path.join(tmp, "cwd"))
  })

  afterEach(() => {
    process.chdir(savedCwd)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("takes an option-like URL as the repository, never running it", async () => {
    // Without `--`, git reads the URL as --upload-pack and clones the
    // "destination" (an existing repo) by running the smuggled command.
    const step = await runGitClone({
      prefilledUrl: `--upload-pack=touch ${marker}; git-upload-pack`,
      prefilledLocalPath: source,
    })

    expect(step?.actualStatus).toBe("fail")
    expect(step?.error).toMatch(/does not exist/)
    expect(fs.existsSync(marker)).toBe(false)
    expect(fs.readdirSync(path.join(tmp, "cwd"))).toEqual([])
  })

  it("refuses an option-like ref before cloning", async () => {
    const step = await runGitClone({ prefilledUrl: `file://${source}`, prefilledRef: "--orphan=evil" })

    expect(step?.actualStatus).toBe("fail")
    expect(step?.error).toMatch(/Invalid ref "--orphan=evil"/)
    expect(fs.existsSync(path.join(tmp, "work", "source"))).toBe(false)
  })

  it("still checks out an ordinary ref", async () => {
    git(source, "tag", "v1")

    const step = await runGitClone({ prefilledUrl: `file://${source}`, prefilledRef: "v1" })

    expect(step?.actualStatus).toBe("success")
    expect(step?.outputs?.ref).toBe("v1")
  })

  it("takes an option-like repo path as the sparse-checkout directory", async () => {
    const step = await runGitClone({ prefilledUrl: `file://${source}`, prefilledRepoPath: "--no-cone" })

    expect(step?.actualStatus).toBe("success")
    const dest = path.join(tmp, "work", "source")
    // Read as an option, `--no-cone` would have switched the checkout out of cone mode.
    expect(execFileSync("git", ["config", "core.sparseCheckoutCone"], { cwd: dest }).toString().trim()).toBe("true")
    expect(execFileSync("git", ["sparse-checkout", "list"], { cwd: dest }).toString().trim()).toBe("--no-cone")
  })
})

// ---------------------------------------------------------------------------
// GoogleAuth: a credentials file also points the gcloud CLI at itself.
// ---------------------------------------------------------------------------

describe("TestExecutor — GoogleAuth gcloud credential override", () => {
  let tmp: string

  const report = `echo "override=\${CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE:-unset}" >> "$RUNBOOK_OUTPUT"`

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rb-exec-google-"))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("sets the override for a credentials file and clears it for an access token", async () => {
    const rb = path.join(tmp, "runbook.mdx")
    fs.writeFileSync(
      rb,
      [
        "# Google",
        `<GoogleAuth id="file-auth" />`,
        `<Command id="after-file" command='${report}' />`,
        `<GoogleAuth id="token-auth" />`,
        `<Command id="after-token" command='${report}' />`,
        "",
      ].join("\n\n"),
    )
    const executor = new TestExecutor(rb, tmp, "generated", { timeout: 30_000, verbose: false })
    await executor.init()

    const result = executor.runTest({
      name: "google",
      env: {
        FILE_GOOGLE_APPLICATION_CREDENTIALS: "/secrets/key.json",
        TOKEN_GOOGLE_OAUTH_ACCESS_TOKEN: "ya29.fake",
      },
      steps: [
        { block: "file-auth", expect: "success", env_prefix: "FILE_" },
        { block: "after-file", expect: "success" },
        { block: "token-auth", expect: "success", env_prefix: "TOKEN_" },
        { block: "after-token", expect: "success" },
      ],
    })

    expect(result.error).toBeUndefined()
    expect(result.stepResults[1]?.outputs?.override).toBe("/secrets/key.json")
    expect(result.stepResults[3]?.outputs?.override).toBe("unset")
  })
})

// ---------------------------------------------------------------------------
// #!/bin/sh blocks get the bash env-capture wrapper, so they must run under
// bash like they do in the app.
// ---------------------------------------------------------------------------

describe("TestExecutor — #!/bin/sh blocks", () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rb-exec-sh-"))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("runs the wrapped script under bash, not in POSIX mode", async () => {
    // Under dash the wrapper is a syntax error (exit 2, "warn"). Under
    // bash-as-sh (macOS) POSIX mode is on, which lets the user's EXIT trap
    // replace the wrapper's env-capture handler.
    fs.mkdirSync(path.join(tmp, "scripts"))
    fs.writeFileSync(
      path.join(tmp, "scripts", "cleanup.sh"),
      "#!/bin/sh\ntrap 'echo cleanup' EXIT\nshopt -oq posix && echo POSIX_MODE || echo NOT_POSIX\n",
    )
    const rb = path.join(tmp, "runbook.mdx")
    fs.writeFileSync(rb, `# sh block\n\n<Command id="sh-block" path="scripts/cleanup.sh" />\n`)

    const executor = new TestExecutor(rb, tmp, "generated", { timeout: 30_000, verbose: false })
    await executor.init()
    const result = await executor.runTest({
      name: "sh",
      steps: [{ block: "sh-block", expect: "success" }],
    })

    expect(result.stepResults[0]?.actualStatus).toBe("success")
    expect(result.stepResults[0]?.logs).toContain("NOT_POSIX")
    expect(result.stepResults[0]?.logs).not.toContain("POSIX_MODE")
    expect(result.stepResults[0]?.logs).toContain("cleanup")
  })
})

// ---------------------------------------------------------------------------
// Log files ($RUNBOOK_LOG, $RUNBOOK_INFO_LOG etc.): the CLI shows their lines.
// ---------------------------------------------------------------------------

describe("TestExecutor — log files", () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rb-exec-logs-"))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("shows the helpers' lines among stdout and stderr in script order, then the per-level files' lines", async () => {
    fs.mkdirSync(path.join(tmp, "scripts"))
    fs.writeFileSync(
      path.join(tmp, "scripts", "logs.sh"),
      [
        "#!/bin/bash",
        'log_info "starting"',
        "get_json() {",
        '  log_info "looking up"',
        `  echo '{"ok":true}'`,
        "}",
        "json=$(get_json)",
        'echo "json=$json"',
        'log_error "step failed"',
        'echo "to stderr" >&2',
        'echo "raw error" >> "$RUNBOOK_ERROR_LOG"',
        'log_warn "careful"',
        "echo done",
        "",
      ].join("\n"),
    )
    const rb = path.join(tmp, "runbook.mdx")
    fs.writeFileSync(rb, `# Logs\n\n<Command id="logs" path="scripts/logs.sh" />\n`)
    const executor = new TestExecutor(rb, tmp, "generated", { timeout: 30_000, verbose: false })
    await executor.init()

    const result = executor.runTest({
      name: "logs",
      steps: [{ block: "logs", expect: "success" }],
      // The log files belong to one block run, so the session env must not
      // keep pointing at them.
      assertions: [
        {
          type: "script",
          command: 'test -z "${RUNBOOK_LOG:-}${RUNBOOK_INFO_LOG:-}${RUNBOOK_ERROR_LOG:-}"',
        },
      ],
    })

    expect(result.error).toBeUndefined()
    expect(result.status).toBe("passed")
    const stamp = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\] /
    const shown = result.stepResults[0]!.logs!
      .trimEnd()
      .split("\n")
      .map((line) => line.replace(stamp, ""))
    expect(shown).toEqual([
      "[INFO]  starting",
      "[INFO]  looking up",
      // The capture holds only the JSON (#269).
      'json={"ok":true}',
      "[ERROR] step failed",
      "to stderr",
      "[WARN]  careful",
      "done",
      "[ERROR] raw error",
    ])
  })
})

// ---------------------------------------------------------------------------
// GitClone with prefilledRepoPath: a sparse clone, built by the same
// buildCloneSteps the app's git:clone handler uses.
// ---------------------------------------------------------------------------

describe("TestExecutor — GitClone sparse checkout", () => {
  const SANDBOX_VARS = ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"] as const
  const savedEnv: Record<string, string | undefined> = {}
  let tmp: string
  let origin: string

  // `env: process.env` because bun's child_process otherwise starts git with
  // the environment the test process began with, not the sandbox below.
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd,
      stdio: "pipe",
      env: process.env,
    })

  const runGitClone = async (props: string, expected: ExpectedStatus = "success") => {
    const rb = path.join(tmp, "runbook.mdx")
    fs.writeFileSync(rb, `# Sparse clone\n\n<GitClone id="repo" prefilledUrl="file://${origin}" ${props} />\n`)
    const executor = new TestExecutor(rb, tmp, "generated", { timeout: 30_000, verbose: false })
    await executor.init()
    return executor.runTest({
      name: "sparse",
      steps: [{ block: "repo", expect: expected }],
    })
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rb-exec-sparse-"))
    // git runs with a sandboxed HOME and no global or system config.
    for (const key of SANDBOX_VARS) savedEnv[key] = process.env[key]
    fs.mkdirSync(path.join(tmp, "home"))
    process.env.HOME = path.join(tmp, "home")
    process.env.GIT_CONFIG_GLOBAL = "/dev/null"
    process.env.GIT_CONFIG_SYSTEM = "/dev/null"
    // A small monorepo whose `release` branch has a file `main` lacks.
    origin = path.join(tmp, "origin")
    fs.mkdirSync(path.join(origin, "modules", "vpc"), { recursive: true })
    fs.mkdirSync(path.join(origin, "modules", "eks"), { recursive: true })
    fs.writeFileSync(path.join(origin, "README.md"), "# mono\n")
    fs.writeFileSync(path.join(origin, "modules", "vpc", "main.tf"), "# vpc\n")
    fs.writeFileSync(path.join(origin, "modules", "eks", "main.tf"), "# eks\n")
    git(origin, "init", "-q", "-b", "main")
    git(origin, "add", ".")
    git(origin, "commit", "-q", "-m", "init")
    git(origin, "checkout", "-q", "-b", "release")
    fs.writeFileSync(path.join(origin, "modules", "vpc", "release.tf"), "# release\n")
    git(origin, "add", ".")
    git(origin, "commit", "-q", "-m", "release")
    git(origin, "checkout", "-q", "main")
  })
  afterEach(() => {
    for (const key of SANDBOX_VARS) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("checks out only the repo path, at the requested ref", async () => {
    const result = await runGitClone(
      `prefilledRef="release" prefilledRepoPath="modules/vpc" prefilledLocalPath="mono"`,
    )

    expect(result.stepResults[0]?.actualStatus).toBe("success")
    const clone = path.join(tmp, "mono")
    // The ref is honored: this file exists only on `release`.
    expect(fs.existsSync(path.join(clone, "modules", "vpc", "release.tf"))).toBe(true)
    // Sibling directories stay out; cone mode keeps the root's own files.
    expect(fs.existsSync(path.join(clone, "modules", "eks"))).toBe(false)
    expect(fs.existsSync(path.join(clone, "README.md"))).toBe(true)
  })

  it("clones a repository with no commits, skipping the checkout", async () => {
    // A repository that was created but never pushed to.
    origin = path.join(tmp, "empty.git")
    git(tmp, "init", "-q", "--bare", "-b", "main", origin)

    const result = await runGitClone(`prefilledRepoPath="modules/vpc" prefilledLocalPath="empty"`)

    expect(result.stepResults[0]?.actualStatus).toBe("success")
    expect(fs.existsSync(path.join(tmp, "empty", ".git"))).toBe(true)
  })

  it("fails with git's error when it can't tell whether the clone has commits", async () => {
    // Only an unborn HEAD (exit 1) means an empty clone. Any other failure,
    // here a git that refuses the new checkout as dubious ownership (exit
    // 128), must not skip the checkout and pass an empty clone; the app runs
    // the checkout, which fails with the real error.
    const realGit = execFileSync("sh", ["-c", "command -v git"], { env: process.env }).toString().trim()
    const bin = path.join(tmp, "bin")
    fs.mkdirSync(bin)
    fs.writeFileSync(
      path.join(bin, "git"),
      [
        "#!/bin/sh",
        'for arg in "$@"; do',
        '  case "$arg" in rev-parse|checkout) echo "fatal: detected dubious ownership in repository" >&2; exit 128;; esac',
        "done",
        `exec "${realGit}" "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    )
    const savedPath = process.env.PATH
    process.env.PATH = `${bin}${path.delimiter}${savedPath}`
    try {
      const result = await runGitClone(`prefilledRepoPath="modules/vpc" prefilledLocalPath="mono"`, "fail")

      expect(result.stepResults[0]).toMatchObject({ actualStatus: "fail", passed: true })
      expect(result.stepResults[0]?.error).toMatch(/dubious ownership/)
    } finally {
      process.env.PATH = savedPath
    }
  })

  it("fails a repo path outside the repository without cloning", async () => {
    const result = await runGitClone(`prefilledRepoPath="../elsewhere" prefilledLocalPath="mono"`)

    expect(result.stepResults[0]?.actualStatus).toBe("fail")
    expect(result.stepResults[0]?.error).toMatch(/invalid repo path/)
    expect(fs.existsSync(path.join(tmp, "mono"))).toBe(false)
  })

  it("passes a step that expects the clone to fail", async () => {
    // Rejected before git runs: the repo path is outside the repository.
    const badPath = await runGitClone(`prefilledRepoPath="../elsewhere" prefilledLocalPath="mono"`, "fail")
    expect(badPath.stepResults[0]).toMatchObject({ actualStatus: "fail", passed: true })

    // Failed by git: the ref doesn't exist.
    const badRef = await runGitClone(`prefilledRef="no-such-branch" prefilledLocalPath="mono"`, "fail")
    expect(badRef.stepResults[0]).toMatchObject({ actualStatus: "fail", passed: true })
  })
})
