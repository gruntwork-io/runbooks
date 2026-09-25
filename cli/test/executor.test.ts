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

  it("fails a GitAuth block with an unknown provider", async () => {
    const executor = await makeExecutor(`<GitAuth id="auth" provider="bitbucket" />`)

    const result = runAuthThenReport(executor, {})

    expect(result.status).toBe("failed")
    expect(result.error).toContain('Unsupported provider "bitbucket"')
  })
})

// ---------------------------------------------------------------------------
// GitClone: a token from a GitLab auth block goes into the URL on any host and
// never into the error. (cli/commands/test.test.ts clones with the token.)
// ---------------------------------------------------------------------------

describe("TestExecutor — GitClone authentication", () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rb-exec-clone-"))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("keeps a GitLab token out of a failed clone's error", async () => {
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
      env: { GITLAB_TOKEN: "fake-gitlab-token", GITLAB_HOST: "", GITLAB_URI: "", GL_HOST: "" },
      steps: [
        { block: "auth", expect: "success" },
        { block: "clone", expect: "success" },
      ],
    })

    expect(result.stepResults[1]?.actualStatus).toBe("fail")
    // The token was in the URL git was given...
    expect(result.error).toContain("https://[REDACTED]@127.0.0.1:1/group/infra.git")
    // ...and nowhere in what's reported.
    expect(result.error).not.toContain("fake-gitlab-token")
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
