/**
 * End-to-end tests for `test`: runs the real CLI entry point in a subprocess,
 * so exit codes, stdout/stderr and --output-file behave exactly as in CI.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

const CLI_ENTRY = path.resolve(import.meta.dirname, "..", "index.ts")
const CLI_TIMEOUT = 60_000

const PASSING_MDX = `# Passing\n\n<Command id="hello" command="echo hi" />\n`
const FAILING_MDX = `# Failing\n\n<Command id="boom" command="echo boom; exit 1" />\n`

function testYml(block: string, name = "happy", expect = "success"): string {
  return `version: 1\ntests:\n  - name: ${name}\n    steps:\n      - block: ${block}\n        expect: ${expect}\n`
}

let tmp: string

function writeRunbook(name: string, mdx: string, yml: string): string {
  const dir = path.join(tmp, name)
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, "runbook.mdx"), mdx)
  fs.writeFileSync(path.join(dir, "runbook_test.yml"), yml)
  return dir
}

function runCli(...args: string[]) {
  return runCliWithEnv(process.env, ...args)
}

function runCliWithEnv(env: NodeJS.ProcessEnv, ...args: string[]) {
  const proc = spawnSync(process.execPath, [CLI_ENTRY, "test", ...args], {
    cwd: tmp,
    env,
    encoding: "utf-8",
    timeout: CLI_TIMEOUT,
  })
  return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rb-cli-test-"))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("runbooks-cli test — config errors", () => {
  it("fails the run when a runbook_test.yml doesn't load", () => {
    const bad = writeRunbook("bad", PASSING_MDX, testYml("hello", "typo", "sucess"))

    const { status, stdout } = runCli(bad)

    expect(status).toBe(1)
    expect(stdout).toContain("config")
    expect(stdout).toContain('invalid expect value "sucess"')
    expect(stdout).toContain("0 passed, 1 failed")
  }, CLI_TIMEOUT)

  it("still fails when the broken runbook runs next to a passing one", () => {
    const bad = writeRunbook("bad", PASSING_MDX, testYml("hello", "typo", "sucess"))
    const good = writeRunbook("good", PASSING_MDX, testYml("hello"))

    const { status, stdout } = runCli(bad, good)

    expect(status).toBe(1)
    expect(stdout).toContain("1 passed, 1 failed")
  }, CLI_TIMEOUT)
})

describe("runbooks-cli test — --test filter", () => {
  it("fails when no runbook has a test case with that name", () => {
    const good = writeRunbook("good", PASSING_MDX, testYml("hello"))

    const { status, stderr } = runCli(good, "--test", "hapy")

    expect(status).toBe(1)
    expect(stderr).toContain('No test case named "hapy" found in 1 runbook(s)')
  }, CLI_TIMEOUT)

  it("passes when one of several runbooks has the test case", () => {
    writeRunbook("a", PASSING_MDX, testYml("hello", "happy"))
    writeRunbook("b", PASSING_MDX, testYml("hello", "other"))

    const { status, stdout } = runCli(`${tmp}/...`, "--test", "happy")

    expect(status).toBe(0)
    expect(stdout).toContain("1 passed, 0 failed")
  }, CLI_TIMEOUT)
})

describe("runbooks-cli test — --output-file", () => {
  it("writes the JUnit file before exiting on a failing run", () => {
    const failing = writeRunbook("failing", FAILING_MDX, testYml("boom"))
    const out = path.join(tmp, "results.xml")

    const { status } = runCli(failing, "--output", "junit", "--output-file", out)

    expect(status).toBe(1)
    const xml = fs.readFileSync(out, "utf-8")
    expect(xml).toContain('<testsuites tests="1" failures="1"')
    expect(xml).toContain("</testsuites>")
  }, CLI_TIMEOUT)

  it("falls back to stdout when the file can't be written", () => {
    const good = writeRunbook("good", PASSING_MDX, testYml("hello"))
    const out = path.join(tmp, "missing-dir", "results.xml")

    const { status, stdout, stderr } = runCli(good, "--output", "junit", "--output-file", out)

    expect(status).toBe(0)
    expect(stderr).toContain("Error writing to output file")
    expect(stdout).toContain('<testsuites tests="1" failures="0"')
  }, CLI_TIMEOUT)
})

describe("runbooks-cli test — unexpected errors", () => {
  it("records a test case that throws as failed and keeps running the rest", () => {
    // A dangling symlink in $GENERATED_FILES makes file capture throw ENOENT
    // out of TestExecutor.runTest.
    const throwing = writeRunbook(
      "throwing",
      `# Throwing\n\n<Command id="dangle" command='ln -s /nonexistent/target "$GENERATED_FILES/dangling"' />\n`,
      testYml("dangle", "throws"),
    )
    const good = writeRunbook("good", PASSING_MDX, testYml("hello"))

    const { status, stdout } = runCli(throwing, good)

    expect(status).toBe(1)
    expect(stdout).toContain("throws")
    expect(stdout).toContain("ENOENT")
    expect(stdout).toContain("happy")
    expect(stdout).toContain("1 passed, 1 failed")
  }, CLI_TIMEOUT)
})

describe("runbooks-cli test — test case isolation", () => {
  it("runs each test case in a fresh working dir", () => {
    const dir = writeRunbook(
      "isolated",
      `# Isolated\n\n<Command id="gen" command='touch "$GENERATED_FILES/made.txt"' />\n\n<Command id="noop" command="true" />\n`,
      [
        "version: 1",
        "tests:",
        "  - name: first",
        "    steps:",
        "      - block: gen",
        "        expect: success",
        "    assertions:",
        "      - type: file_exists",
        "        path: made.txt",
        "  - name: second",
        "    steps:",
        "      - block: noop",
        "        expect: success",
        "    assertions:",
        "      - type: file_not_exists",
        "        path: made.txt",
        "",
      ].join("\n"),
    )

    const { status, stdout } = runCli(dir)

    expect(stdout).toContain("2 passed, 0 failed")
    expect(status).toBe(0)
  }, CLI_TIMEOUT)

  it("lets every test case clone the same repo", () => {
    const repo = path.join(tmp, "upstream")
    fs.mkdirSync(repo)
    const git = (...args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf-8" })
    git("init", "-q")
    fs.writeFileSync(path.join(repo, "main.tf"), "# tf\n")
    git("add", ".")
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init")

    const clone = "      - block: clone\n        expect: success\n"
    const dir = writeRunbook(
      "clones",
      `# Clones\n\n<GitClone id="clone" prefilledUrl="file://${repo}" />\n`,
      `version: 1\ntests:\n  - name: first\n    steps:\n${clone}  - name: second\n    steps:\n${clone}`,
    )

    const { status, stdout } = runCli(dir)

    expect(stdout).toContain("2 passed, 0 failed")
    expect(status).toBe(0)
  }, CLI_TIMEOUT)

  it("removes every temp dir it makes", () => {
    // Per block: output, files, script, and the bash env/pwd capture dirs;
    // per test case: the working dir.
    const dir = writeRunbook(
      "temp-dirs",
      `# Temp dirs\n\n<Command id="export" command="export FOO=bar" />\n\n<Command id="gen" command='touch "$GENERATED_FILES/made.txt"' />\n`,
      `version: 1\ntests:\n  - name: one\n  - name: two\n`,
    )
    const tmpdir = path.join(tmp, "tmpdir")
    fs.mkdirSync(tmpdir)

    const { status, stdout } = runCliWithEnv({ ...process.env, TMPDIR: tmpdir }, dir)

    expect(stdout).toContain("2 passed, 0 failed")
    expect(status).toBe(0)
    expect(fs.readdirSync(tmpdir).filter((name) => name.startsWith("runbook-"))).toEqual([])
  }, CLI_TIMEOUT)
})
