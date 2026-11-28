/**
 * `runbooks test` end to end: the command line, the engine through the
 * in-process client, and the real Node file system, in a temporary folder
 * per test. The registry is the toy one with `Script`, a task whose props
 * say what its run does: log lines, outputs, a file, an exit code, or never
 * ending.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Deferred, Effect, Redacted, Schema, Stream } from "effect"
import { endWithExitCode, TaskFailed } from "@runbooks/blocks-core/contract"
import { defineTask, type TaskEvent } from "@runbooks/blocks-core/contract"
import type { Registry } from "@runbooks/blocks-core/registry"
import { FileSystem } from "@runbooks/core/services/FileSystem"
import {
  FAKE_SCRIPT,
  type FakeScript,
  fakeCredentialProviders,
} from "@runbooks/core/credential/fake"
import { TOY_REGISTRY } from "@runbooks/core/test-utils/toyRegistry"
import { TestReport } from "./contract.ts"
import { runCliForTest, tempFolder } from "./test-utils/runCliForTest.ts"

// ---------------------------------------------------------------------------
// The toy Script task
// ---------------------------------------------------------------------------

/** What the Script runs record, for the tests to read. Reset before each test. */
const seen = {
  runs: 0,
  /** Runs stopped while they ran: cancelled, or ended with the session. */
  interrupted: 0,
  /** Completes when a `hang` run has started. */
  hanging: Deferred.makeUnsafe<void>(),
  /** Named signals: `signal` completes one, `waitFor` waits for it. */
  signals: new Map<string, Deferred.Deferred<void>>(),
}

const signal = (name: string) => {
  const existing = seen.signals.get(name)
  if (existing !== undefined) return existing
  const made = Deferred.makeUnsafe<void>()
  seen.signals.set(name, made)
  return made
}

const ScriptProps = Schema.Struct({
  say: Schema.optionalKey(Schema.Array(Schema.String)),
  /** `key=value` each. */
  outputs: Schema.optionalKey(Schema.Array(Schema.String)),
  /** A file left in `$GENERATED_FILES`, holding "hello", as a script leaves one. */
  write: Schema.optionalKey(Schema.String),
  /** A file in the generated folder the run reports it removed. */
  removes: Schema.optionalKey(Schema.String),
  exit: Schema.optionalKey(Schema.Int),
  hang: Schema.optionalKey(Schema.Boolean),
  signal: Schema.optionalKey(Schema.String),
  waitFor: Schema.optionalKey(Schema.String),
  /** How long the run takes before it ends. */
  takesMillis: Schema.optionalKey(Schema.Int),
  /** The block's own time limit, as a Command's `timeoutMs` gives it. */
  timeLimitMillis: Schema.optionalKey(Schema.Int),
})
type ScriptProps = typeof ScriptProps.Type

const outputPairs = (p: ScriptProps) =>
  (p.outputs ?? []).map((pair) => {
    const at = pair.indexOf("=")
    return [pair.slice(0, at), pair.slice(at + 1)] as const
  })

const script = defineTask({
  name: "Script",
  since: "0.1.0",
  class: "task",
  props: ScriptProps,
  children: { kind: "none" },
  references: {},
  runbookFiles: () => [],
  provides: ["run"],
  effects: ["process"],
  outputs: (p) => Object.fromEntries(outputPairs(p).map(([key]) => [key, { sensitive: false }])),
  timeLimit: (p) => p.timeLimitMillis,
  run: (p, input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        seen.runs++
        const fs = yield* FileSystem
        const steps: Array<Stream.Stream<TaskEvent<string>, TaskFailed, never>> = [
          Stream.fromIterable(
            (p.say ?? []).map((line) => ({
              _tag: "Log" as const,
              stream: "stdout" as const,
              line,
            })),
          ),
        ]
        if (p.write !== undefined) {
          const folder = input.env["GENERATED_FILES"]
          if (folder === undefined)
            return yield* new TaskFailed({ message: "The run has no GENERATED_FILES." })
          const file = path.join(Redacted.value(folder), p.write)
          yield* fs
            .writeFile(file, "hello\n")
            .pipe(Effect.mapError(() => new TaskFailed({ message: `could not write ${file}` })))
        }
        if (p.removes !== undefined)
          steps.push(
            Stream.make({
              _tag: "File" as const,
              path: path.join(input.roots.generated, p.removes),
              change: "deleted" as const,
            }),
          )
        steps.push(
          Stream.fromIterable(
            outputPairs(p).map(([key, value]) => ({ _tag: "Output" as const, key, value })),
          ),
        )
        if (p.signal !== undefined) yield* Deferred.succeed(signal(p.signal), undefined)
        if (p.waitFor !== undefined)
          steps.push(Stream.fromEffect(Deferred.await(signal(p.waitFor))).pipe(Stream.drain))
        if (p.hang === true)
          steps.push(
            Stream.fromEffect(
              Deferred.succeed(seen.hanging, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() => Effect.sync(() => seen.interrupted++)),
              ),
            ),
          )
        if (p.takesMillis !== undefined)
          steps.push(Stream.fromEffect(Effect.sleep(p.takesMillis)).pipe(Stream.drain))
        steps.push(endWithExitCode(p.exit ?? 0))
        return steps.reduce((all, next) => Stream.concat(all, next))
      }),
    ),
  instruction: () => [],
  plugins: [],
})

const REGISTRY: Registry = { ...TOY_REGISTRY, Script: script }

// ---------------------------------------------------------------------------
// A runbook in a temporary folder, and the command run over it
// ---------------------------------------------------------------------------

let folder: ReturnType<typeof tempFolder>

/**
 * The temporary folder this test's runs make their case folders in. Another
 * suite on the machine makes `runbooks-test-*` folders too, so each test
 * gives its runs a folder of their own (`os.tmpdir()` reads `TMPDIR`).
 */
let runsTemp = ""
const TMPDIR = process.env["TMPDIR"]

/** `runbooks-test-*` folders the runs made: each test case's. */
const caseFolders = () => readdirSync(runsTemp).filter((name) => name.startsWith("runbooks-test-"))

beforeEach(() => {
  folder = tempFolder()
  runsTemp = mkdtempSync(path.join(os.tmpdir(), "runbooks-cli-runs-"))
  process.env["TMPDIR"] = runsTemp
  seen.runs = 0
  seen.interrupted = 0
  seen.hanging = Deferred.makeUnsafe<void>()
  seen.signals.clear()
})

afterEach(() => {
  if (TMPDIR === undefined) delete process.env["TMPDIR"]
  else process.env["TMPDIR"] = TMPDIR
  // No test case leaves its temporary folder behind.
  const left = caseFolders()
  rmSync(runsTemp, { recursive: true, force: true })
  expect(left).toEqual([])
  folder.remove()
})

/** Writes `rb/runbook.mdx` and `rb/runbook_test.yml`, or another folder's. */
function runbook(mdx: string, testYaml: string, name = "rb") {
  const dir = path.join(folder.path, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, "runbook.mdx"), mdx)
  writeFileSync(path.join(dir, "runbook_test.yml"), testYaml)
  return dir
}

const runTest = (args: ReadonlyArray<string>, interrupted?: Effect.Effect<void>) =>
  runCliForTest(["test", ...args], {
    registry: REGISTRY,
    cwd: folder.path,
    ...(interrupted === undefined ? {} : { interrupted }),
  })

const decodeReport = Schema.decodeUnknownSync(TestReport)

const BUILD = [
  "# Build",
  '<Note id="intro" title="About" />',
  '<Form id="config">\n```yaml\n- name: region\n  type: string\n```\n</Form>',
  '<Script id="build" say={["building", "built"]} write="out.txt" outputs={["artifact=app.tar"]} />',
  '<Script id="lint" say={["one warning"]} exit={2} />',
].join("\n\n")

const BUILD_TEST = `version: 1
tests:
  - name: happy
    inputs:
      config.region: us-west-2
    steps:
      - block: intro
      - block: config
        assertions:
          - { type: output_equals, block: config, output: region, value: us-west-2 }
      - block: build
        assertions:
          - { type: output_equals, block: build, output: artifact, value: app.tar }
          - { type: file_contains, path: out.txt, contains: hello }
      - block: lint
        expect: warn
    assertions:
      - { type: files_generated, block: build, min_count: 1 }
      - { type: file_exists, path: out.txt }
`

const DEPLOY = [
  "# Deploy",
  '<Script id="setup" say={["setting up"]} />',
  '<Script id="deploy" say={["deploying", "boom"]} exit={1} />',
].join("\n\n")

const DEPLOY_TEST = `version: 1
tests:
  - name: deploys
`

// ---------------------------------------------------------------------------

describe("runbooks test", () => {
  it("runs a passing runbook's steps in order and checks their assertions", async () => {
    const dir = runbook(BUILD, BUILD_TEST)
    const { code, stdout, stderr } = await runTest(["rb", "--output", "json"])
    expect(stderr).toBe("")
    expect(code).toBe(0)
    const report = decodeReport(JSON.parse(stdout))
    expect(report.outcome).toBe("passed")
    expect(report.summary).toEqual({ runbooks: 1, passed: 1, failed: 0, skipped: 0, warnings: 0 })
    const [test] = report.runbooks[0]!.tests
    expect(test!.steps.map((s) => [s.block, s.expected, s.actual, s.passed])).toEqual([
      ["intro", "success", "success", true],
      ["config", "success", "success", true],
      ["build", "success", "success", true],
      ["lint", "warn", "warn", true],
    ])
    expect(test!.steps[2]!.assertions).toEqual([
      { type: "output_equals", passed: true },
      { type: "file_contains", passed: true },
    ])
    expect(test!.assertions.map((a) => a.passed)).toEqual([true, true])
    expect(test!.steps[2]!.outputs).toEqual({ artifact: { _tag: "Shown", value: "app.tar" } })
    expect(seen.runs).toBe(2)
    // The runbook's folder holds what it held: the file went to the test case's temporary folder.
    expect(readdirSync(dir).sort()).toEqual(["runbook.mdx", "runbook_test.yml"])
    expect(readdirSync(folder.path)).toEqual(["rb"])
  })

  it("matches a pattern as today's CLI does: `$` ends the text, and `\\-` is a hyphen", async () => {
    runbook(
      BUILD,
      `version: 1
tests:
  - name: patterns
    inputs:
      config.region: us-west-2
    steps:
      - block: build
        assertions:
          - { type: output_matches, block: build, output: artifact, pattern: '^app\\.tar\\-?$' }
          - { type: file_matches, path: out.txt, pattern: '^hello\\-?$' }
`,
    )
    const { code, stdout } = await runTest(["rb", "--output", "json"])
    expect(code).toBe(1)
    const [test] = decodeReport(JSON.parse(stdout)).runbooks[0]!.tests
    expect(test!.steps[0]!.assertions).toEqual([
      { type: "output_matches", passed: true },
      { type: "file_matches", passed: false, message: "out.txt does not match ^hello\\-?$." },
    ])
  })

  it("counts for files_generated only the files the named block generated, as today's CLI does", async () => {
    runbook(
      `${BUILD}\n\n<Script id="clean" write="new.txt" removes="old.txt" />`,
      `version: 1
tests:
  - name: by block
    inputs:
      config.region: us-west-2
    steps:
      - block: build
      - block: lint
        expect: warn
    assertions:
      - { type: files_generated, block: build }
      - { type: files_generated, block: lint }
  - name: by count
    steps:
      - block: build
    assertions:
      - { type: files_generated, block: build, min_count: 2 }
  - name: no such block
    steps:
      - block: build
    assertions:
      - { type: files_generated, block: nope }
  - name: not what it removed
    steps:
      - block: clean
    assertions:
      - { type: files_generated, block: clean, min_count: 2 }
`,
    )
    const { code, stdout } = await runTest(["rb", "--output", "json"])
    expect(code).toBe(1)
    const tests = decodeReport(JSON.parse(stdout)).runbooks[0]!.tests
    expect(tests.map((test) => test.assertions)).toEqual([
      [
        { type: "files_generated", passed: true },
        {
          type: "files_generated",
          passed: false,
          message: "lint generated 0 files, fewer than 1.",
        },
      ],
      [
        {
          type: "files_generated",
          passed: false,
          message: "build generated 1 file, fewer than 2.",
        },
      ],
      [
        {
          type: "files_generated",
          passed: false,
          message: 'The runbook has no block with the id "nope".',
        },
      ],
      [
        {
          type: "files_generated",
          passed: false,
          message: "clean generated 1 file, fewer than 2.",
        },
      ],
    ])
  })

  it("fails a step that does not end as it expects, with that step's log only", async () => {
    runbook(DEPLOY, DEPLOY_TEST)
    const { code, stdout } = await runTest(["rb"])
    expect(code).toBe(1)
    expect(stdout).toContain("✗ deploys")
    expect(stdout).toContain("Error: deploy: Expected success, got fail")
    expect(stdout).toContain("✗ deploy: fail (expected success, exit 1")
    expect(stdout).toContain("      | deploying\n      | boom")
    expect(stdout).not.toContain("setting up")
    expect(stdout).toContain("Results: 0 passed, 1 failed, 0 skipped")
  })

  it("says which value a blocked step waits for, and runs it once its test gives the value", async () => {
    const reads = [
      "# Reads",
      '<Form id="config">\n```yaml\n- name: id\n  type: string\n```\n</Form>',
      '<Script id="use" inputsId="config" env={{ ID: "{{ .inputs.id }}" }} />',
    ].join("\n\n")
    const steps = "    steps:\n      - block: use\n"
    runbook(reads, `version: 1\ntests:\n  - name: empty\n${steps}`)
    const empty = await runTest(["rb"])
    expect(empty.code).toBe(1)
    expect(empty.stdout).toContain("Error: use: Expected success, got blocked")
    expect(empty.stdout).toContain("Waiting for a value for id in config")
    expect(seen.runs).toBe(0)

    // An input left empty gives no value.
    runbook(
      reads,
      `version: 1\ntests:\n  - name: left-empty\n    inputs:\n      config.id:\n${steps}`,
    )
    expect((await runTest(["rb"])).stdout).toContain("Waiting for a value for id in config")
    expect(seen.runs).toBe(0)

    runbook(
      reads,
      `version: 1\ntests:\n  - name: given\n    inputs:\n      config.id: i-123\n${steps}`,
    )
    expect((await runTest(["rb"])).code).toBe(0)
    expect(seen.runs).toBe(1)
  })

  it("reports a passing step against an expect it does not meet as failed", async () => {
    runbook(
      DEPLOY,
      `version: 1\ntests:\n  - name: one\n    steps:\n      - block: setup\n        expect: fail\n`,
    )
    const { code, stdout } = await runTest(["rb", "--output", "json"])
    expect(code).toBe(1)
    const step = decodeReport(JSON.parse(stdout)).runbooks[0]!.tests[0]!.steps[0]!
    expect(step).toMatchObject({
      block: "setup",
      expected: "fail",
      actual: "success",
      passed: false,
    })
  })

  it("expects success of a step that does not say", async () => {
    runbook(DEPLOY, `version: 1\ntests:\n  - name: one\n    steps:\n      - block: deploy\n`)
    const { code, stdout } = await runTest(["rb", "--output", "json"])
    expect(code).toBe(1)
    const step = decodeReport(JSON.parse(stdout)).runbooks[0]!.tests[0]!.steps[0]!
    expect(step).toMatchObject({ expected: "success", actual: "fail", passed: false, exitCode: 1 })
  })

  it("puts a form step's set_outputs in the field each output carries", async () => {
    const mdx = [
      "# Pick",
      '<Publisher id="pick" outputs={{ PATH: "path" }}>\n```yaml\n- name: path\n  type: string\n  required: true\n```\n</Publisher>',
    ].join("\n\n")
    runbook(
      mdx,
      `version: 1
tests:
  - name: picks
    steps:
      - block: pick
        set_outputs: { PATH: dev/region-1 }
        assertions:
          - { type: output_equals, block: pick, output: PATH, value: dev/region-1 }
`,
    )
    const { code, stdout } = await runTest(["rb", "--output", "json"])
    const step = decodeReport(JSON.parse(stdout)).runbooks[0]!.tests[0]!.steps[0]!
    expect([step.actual, step.passed, step.message]).toEqual(["success", true, undefined])
    expect(step.outputs).toEqual({ PATH: { _tag: "Shown", value: "dev/region-1" } })
    expect(code).toBe(0)
  })

  it("names a refused set_outputs value by the output the test file gives", async () => {
    runbook(
      '<Publisher id="pick" outputs={{ PATH: "path" }}>\n```yaml\n- name: path\n  type: string\n  default: dev\n  locked: true\n```\n</Publisher>',
      "version: 1\ntests:\n  - name: picks\n    steps:\n      - block: pick\n        set_outputs: { PATH: prod }\n",
    )
    const { code, stdout } = await runTest(["rb", "--output", "json"])
    const step = decodeReport(JSON.parse(stdout)).runbooks[0]!.tests[0]!.steps[0]!
    expect([step.actual, step.passed]).toEqual(["fail", false])
    expect(step.message).toContain('set_outputs.PATH: "path" is read-only.')
    expect(code).toBe(1)
  })

  it("streams every log line to stderr with --verbose", async () => {
    runbook(DEPLOY, DEPLOY_TEST)
    const { code, stderr, stdout } = await runTest(["rb", "--verbose"])
    expect(code).toBe(1)
    expect(stderr.split("\n")).toEqual([
      "rb/runbook.mdx setup | setting up",
      "rb/runbook.mdx deploy | deploying",
      "rb/runbook.mdx deploy | boom",
    ])
    expect(stdout).toContain("✓ setup: success (expected success")
  })

  it("fails a test file with an unknown key as its runbook's config test, with its line, and runs nothing", async () => {
    runbook(
      DEPLOY,
      `version: 1\ntests:\n  - name: one\n    steps:\n      - block: setup\n        expects: success\n`,
    )
    const { code, stdout } = await runTest(["rb", "--output", "json"])
    expect(code).toBe(1)
    const report = decodeReport(JSON.parse(stdout))
    expect(report.failure).toBeUndefined()
    expect(report.outcome).toBe("failed")
    expect(report.runbooks.map((r) => r.tests.map((test) => [test.name, test.outcome]))).toEqual([
      [["config", "failed"]],
    ])
    expect(report.runbooks[0]?.tests[0]?.message).toBe(
      "rb/runbook_test.yml:6:9: tests[0].steps[0].expects: there is no key expects here. Did you mean expect?",
    )
    expect(seen.runs).toBe(0)
  })

  it("goes on to the other runbooks after one whose test file can't be loaded, and says so in JUnit", async () => {
    runbook(DEPLOY, "version: 1\ntests: nope\n", "a-broken")
    runbook(BUILD, BUILD_TEST, "b-good")
    const json = decodeReport(JSON.parse((await runTest(["./...", "--output", "json"])).stdout))
    expect(json.failure).toBeUndefined()
    expect(json.runbooks.map((r) => [r.path, r.tests.map((test) => test.outcome)])).toEqual([
      [path.join(folder.path, "a-broken", "runbook.mdx"), ["failed"]],
      [path.join(folder.path, "b-good", "runbook.mdx"), ["passed"]],
    ])
    const junit = await runTest(["./...", "--output", "junit"])
    expect(junit.code).toBe(1)
    expect(junit.stdout).toContain('<testcase name="config"')
    expect(junit.stdout).toMatch(/<testsuites[^>]* tests="2" failures="1"/)
  })

  it("maps a Misconfigured block to config_error, and checks error_contains", async () => {
    const mdx = '# Broken\n\n<Script id="broken" exit="one" />\n'
    runbook(
      mdx,
      `version: 1
tests:
  - name: expects it
    steps:
      - block: broken
        expect: config_error
        error_contains: EXIT
  - name: expects another error
    steps:
      - block: broken
        expect: config_error
        error_contains: no such file
  - name: expects success
    steps:
      - block: broken
`,
    )
    const { code, stdout } = await runTest(["rb", "--output", "json"])
    expect(code).toBe(1)
    const [expected, other, success] = decodeReport(JSON.parse(stdout)).runbooks[0]!.tests
    expect(expected!.outcome).toBe("passed")
    expect(expected!.steps[0]).toMatchObject({ expected: "config_error", actual: "config_error" })
    expect(other!.outcome).toBe("failed")
    expect(other!.message).toContain('No configuration error contains "no such file"')
    expect(success!.steps[0]).toMatchObject({ actual: "config_error", passed: false })
    expect(seen.runs).toBe(0)
  })

  it("cancels the running block on Ctrl-C, runs nothing more, and fails", async () => {
    runbook(
      '# Hang\n\n<Script id="wait" say={["waiting"]} hang />\n\n<Script id="after" />\n',
      "version: 1\ntests:\n  - name: first\n  - name: second\n",
    )
    const started = Date.now()
    const { code, stdout, stderr } = await runTest(
      ["rb", "--output", "json"],
      Deferred.await(seen.hanging),
    )
    expect(code).toBe(1)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(stderr).toContain("Press Ctrl-C again to stop at once.")
    expect(stderr).toContain("Stopped by Ctrl-C or SIGTERM")
    const report = decodeReport(JSON.parse(stdout))
    expect(report.failure).toEqual({ _tag: "Cancelled" })
    const [first, second] = report.runbooks[0]!.tests
    expect(first!.steps.map((s) => [s.block, s.actual])).toEqual([["wait", "cancelled"]])
    expect(first!.steps[0]!.log).toBe("waiting")
    expect(second!.outcome).toBe("skipped")
    // The run was stopped by the cancel, and nothing after it started.
    expect(seen.interrupted).toBe(1)
    expect(seen.runs).toBe(1)
  })

  it("writes text, junit and json reports of the same run", async () => {
    runbook(BUILD, BUILD_TEST, "build")
    runbook(DEPLOY, DEPLOY_TEST, "deploy")

    const text = await runTest(["build", "deploy"])
    expect(text.code).toBe(1)
    expect(text.stdout).toContain("=== build/runbook.mdx ===\n  ✓ happy (")
    expect(text.stdout).toContain("=== deploy/runbook.mdx ===\n  ✗ deploys (")
    expect(text.stdout).toMatch(/Results: 1 passed, 1 failed, 0 skipped \(total: [\d.]+s\)$/u)

    const junit = await runTest(["build", "deploy", "--output", "junit"])
    expect(junit.code).toBe(1)
    expect(junit.stdout).toStartWith(
      '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="2" failures="1" skipped="0"',
    )
    expect(junit.stdout).toContain('<testcase name="happy" classname="build"')
    expect(junit.stdout).toContain('<testcase name="deploys" classname="deploy"')
    expect(junit.stdout).toMatch(
      /<failure message="deploy: Expected success, got fail[^"]*" type="TestFailure">/u,
    )
    expect(junit.stdout).toContain("deploying\nboom</failure>")

    const json = await runTest(["build", "deploy", "--output", "json"])
    expect(json.code).toBe(1)
    const report = decodeReport(JSON.parse(json.stdout))
    expect(report.runbooks.map((r) => path.relative(folder.path, r.path))).toEqual([
      "build/runbook.mdx",
      "deploy/runbook.mdx",
    ])
    expect(report.summary).toEqual({ runbooks: 2, passed: 1, failed: 1, skipped: 0, warnings: 0 })
  })

  it("writes the report to --output-file, or to stdout when it cannot", async () => {
    runbook(BUILD, BUILD_TEST)
    const written = await runTest(["rb", "--output", "junit", "--output-file", "out/report.xml"])
    // The tests passed: a report that went to stdout instead does not fail them.
    expect(written.code).toBe(0)
    expect(written.stderr).toContain("out/report.xml could not be written")
    expect(written.stdout).toStartWith("<?xml")

    mkdirSync(path.join(folder.path, "out"))
    const again = await runTest(["rb", "--output", "junit", "--output-file", "out/report.xml"])
    expect(again.code).toBe(0)
    expect(again.stdout).toBe("")
    expect(readFileSync(path.join(folder.path, "out/report.xml"), "utf8")).toContain(
      '<testcase name="happy" classname="rb"',
    )
  })

  it("refuses an --output it does not have, with nothing on stdout", async () => {
    runbook(BUILD, BUILD_TEST)
    const { code, stdout, stderr } = await runTest(["rb", "--output", "yaml"])
    expect(code).toBe(1)
    expect(stdout).toBe("")
    expect(stderr).toContain("yaml")
    expect(seen.runs).toBe(0)
  })

  it("runs only the test case --test names, and fails when none has that name", async () => {
    runbook(
      BUILD,
      BUILD_TEST.replace(
        "tests:\n",
        "tests:\n  - name: other\n    steps:\n      - block: lint\n        expect: fail\n",
      ),
    )
    const one = await runTest(["rb", "--test", "happy", "--output", "json"])
    expect(one.code).toBe(0)
    expect(decodeReport(JSON.parse(one.stdout)).runbooks[0]!.tests.map((t) => t.name)).toEqual([
      "happy",
    ])
    const none = await runTest(["rb", "--test", "nope", "--output", "json"])
    expect(none.code).toBe(1)
    expect(decodeReport(JSON.parse(none.stdout)).failure).toEqual({
      _tag: "TestCaseNotFound",
      name: "nope",
      runbooks: 1,
    })
  })

  it("ignores a block's own time limit, as today's runner does: the timeout setting limits every step", async () => {
    runbook(
      '# Slow\n\n<Script id="slow" takesMillis={200} timeLimitMillis={20} />\n',
      "version: 1\ntests:\n  - name: slow\n",
    )
    const { code, stdout } = await runTest(["rb", "--output", "json"])
    const [rb] = decodeReport(JSON.parse(stdout)).runbooks
    expect(rb!.tests[0]!.steps[0]).toMatchObject({ block: "slow", actual: "success", passed: true })
    expect(code).toBe(0)
  })

  it("tests runbooks at once with --max-parallel, each with its own engine", async () => {
    // a waits for b's run, so they pass only when they run at the same time.
    const settings = "settings:\n  timeout: 2s\n"
    runbook(
      '# A\n\n<Script id="a" waitFor="b" />\n',
      `version: 1\n${settings}tests:\n  - name: a\n`,
      "a",
    )
    runbook(
      '# B\n\n<Script id="b" signal="b" />\n',
      `version: 1\n${settings}tests:\n  - name: b\n`,
      "b",
    )
    const together = await runTest(["./...", "--max-parallel", "2", "--output", "json"])
    expect(decodeReport(JSON.parse(together.stdout)).summary.passed).toBe(2)
    expect(together.code).toBe(0)

    seen.signals.clear()
    const oneAtATime = await runTest(["./...", "--output", "json"])
    expect(oneAtATime.code).toBe(1)
    const [a] = decodeReport(JSON.parse(oneAtATime.stdout)).runbooks
    expect(a!.tests[0]!.steps[0]).toMatchObject({ block: "a", actual: "timeout" })
  })

  it("fails a credential step when no credential provider opens", async () => {
    runbook(
      '# Git\n\n<GitLogin id="git" />\n',
      "version: 1\ntests:\n  - name: signs in\n  - name: fails\n    steps:\n      - block: git\n        expect: fail\n",
    )
    const { code, stdout } = await runTest(["rb", "--output", "json"])
    expect(code).toBe(1)
    const [signsIn, fails] = decodeReport(JSON.parse(stdout)).runbooks[0]!.tests
    expect(signsIn!.outcome).toBe("failed")
    expect(fails!.outcome).toBe("passed")
  })

  it("signs a credential block in with the providers it is given: confirms a login it finds, and skips one with none", async () => {
    const cloud: FakeScript = {
      ...FAKE_SCRIPT,
      prefix: "CLOUD",
      names: { token: "CLOUD_TOKEN", account: "CLOUD_ACCOUNT" },
      logins: [
        {
          token: "fake-key-0001",
          principal: "fake-key@example.com",
          kind: "user",
          targets: { account: "111111111111", role: "Admin" },
        },
      ],
    }
    runbook(
      '# Cloud\n\n<CloudLogin id="cloud" />\n',
      [
        "version: 1",
        "tests:",
        "  - name: found",
        "    env:",
        "      CLOUD_TOKEN: fake-key-0001",
        "  - name: none",
      ].join("\n"),
    )
    const { stdout } = await runCliForTest(["test", "rb", "--output", "json"], {
      registry: REGISTRY,
      cwd: folder.path,
      credentialProviders: fakeCredentialProviders({ cloud }),
    })
    const [found, none] = decodeReport(JSON.parse(stdout)).runbooks[0]!.tests
    expect(found!.steps[0]).toMatchObject({ block: "cloud", actual: "success", passed: true })
    expect(none!.steps[0]).toMatchObject({
      block: "cloud",
      actual: "skip",
      message: "Expected success, got skip: No login was found to sign in with.",
    })
  })

  it("fails every test case of a runbook that does not open, and lists its errors", async () => {
    runbook("# Bad\n\n<Nope />\n", DEPLOY_TEST)
    const { code, stdout } = await runTest(["rb"])
    expect(code).toBe(1)
    expect(stdout).toContain("rb/runbook.mdx:3:1: error unknownBlock")
    expect(stdout).toContain("✗ deploys")
    expect(stdout).toContain("The runbook does not open")
  })

  it("skips a runbook named alone that has no test file, with a warning", async () => {
    runbook(BUILD, BUILD_TEST)
    mkdirSync(path.join(folder.path, "bare"))
    writeFileSync(path.join(folder.path, "bare/runbook.mdx"), "# Bare\n")
    const { code, stderr } = await runTest(["rb", "bare"])
    expect(code).toBe(0)
    expect(stderr).toBe(
      "warning: bare/runbook.mdx has no runbook_test.yml next to it, so it was not tested.",
    )
    const none = await runTest(["bare", "--output", "json"])
    expect(none.code).toBe(1)
    expect(decodeReport(JSON.parse(none.stdout)).failure).toEqual({
      _tag: "NoRunbooks",
      patterns: ["bare"],
    })
  })

  it("fails a test that uses a key this build does not run yet, never passing it", async () => {
    runbook(BUILD, `${BUILD_TEST}    cleanup:\n      - command: rm -f out.txt\n`)
    const { code, stdout } = await runTest(["rb", "--output", "json"])
    expect(code).toBe(1)
    const [test] = decodeReport(JSON.parse(stdout)).runbooks[0]!.tests
    expect(test!.message).toBe(
      "cleanup is not built yet: runbooks test runs no command of its own.",
    )
    expect(seen.runs).toBe(0)
  })

  /** BUILD_TEST with `config.region` drawn as `fuzz` says, and the step checking it as `assertion` says. */
  const fuzzed = (fuzz: string, assertion: string) =>
    BUILD_TEST.replace(
      "      config.region: us-west-2\n",
      `      config.region:\n        fuzz: ${fuzz}\n`,
    ).replace("{ type: output_equals, block: config, output: region, value: us-west-2 }", assertion)

  it("draws a fuzz input within its settings, and enters it", async () => {
    runbook(
      BUILD,
      fuzzed(
        "{ type: string, length: 6, prefix: us- }",
        '{ type: output_matches, block: config, output: region, pattern: "^us-[A-Za-z0-9]{6}$" }',
      ),
    )
    const { code, stdout } = await runTest(["rb", "--output", "json"])
    const [test] = decodeReport(JSON.parse(stdout)).runbooks[0]!.tests
    expect([test!.outcome, test!.message]).toEqual(["passed", undefined])
    expect(code).toBe(0)
    expect(seen.runs).toBe(2)
  })

  it("fails a test case whose fuzz settings draw nothing, naming the input, and runs nothing", async () => {
    runbook(
      BUILD,
      fuzzed(
        "{ type: string, minLength: 5, maxLength: 3 }",
        "{ type: output_exists, block: config, output: region }",
      ),
    )
    const { code, stdout } = await runTest(["rb", "--output", "json"])
    expect(code).toBe(1)
    const [test] = decodeReport(JSON.parse(stdout)).runbooks[0]!.tests
    expect(test!.message).toBe(
      "inputs config.region: fuzz string: maxLength (3) is less than minLength (5)",
    )
    expect(test!.steps).toEqual([])
    expect(seen.runs).toBe(0)
  })

  /** Two test cases, each drawing `config.region`. */
  const TWO_FUZZED = ["first", "second"]
    .map(
      (name) =>
        `  - name: ${name}\n    inputs:\n      config.region:\n        fuzz: { type: string, length: 12 }\n    steps:\n      - block: config\n`,
    )
    .join("")

  /** The seed the json report names, and the region each test case of each runbook drew. */
  const drawnWith = async (args: ReadonlyArray<string>) => {
    const { code, stdout } = await runTest(["--output", "json", ...args])
    expect(code).toBe(0)
    const report = decodeReport(JSON.parse(stdout))
    const regions = report.runbooks.map((r) =>
      Object.fromEntries(r.tests.map((t) => [t.name, t.steps[0]!.outputs["region"]])),
    )
    return { seed: report.fuzzSeed, regions }
  }

  it("draws fuzz inputs from a seed it reports, and the same seed draws them again", async () => {
    runbook(BUILD, `version: 1\ntests:\n${TWO_FUZZED}`)
    const drawn = await drawnWith(["rb"])
    expect(drawn.seed).toMatch(/^\d+$/u)
    const { first, second } = drawn.regions[0]!
    expect(first).toEqual({ _tag: "Shown", value: expect.stringMatching(/^\w{12}$/u) })
    expect(second).not.toEqual(first)
    expect(await drawnWith(["rb", "--fuzz-seed", drawn.seed!])).toEqual(drawn)
    // One test case alone draws what it drew among the others.
    expect(await drawnWith(["rb", "--fuzz-seed", drawn.seed!, "--test", "second"])).toEqual({
      seed: drawn.seed,
      regions: [{ second }],
    })
    const other = await drawnWith(["rb", "--fuzz-seed", "other"])
    expect(other.seed).toBe("other")
    expect(other.regions[0]!["first"]).not.toEqual(first)
    // With no seed given, each run draws its own.
    expect((await drawnWith(["rb"])).seed).not.toBe(drawn.seed)
  })

  it("draws its own value for each input, test case and runbook, from one seed", async () => {
    runbook(BUILD, `version: 1\ntests:\n${TWO_FUZZED}`, "one")
    runbook(BUILD, `version: 1\ntests:\n${TWO_FUZZED}`, "two")
    const { regions } = await drawnWith(["one", "two", "--fuzz-seed", "7"])
    expect(regions[0]!["first"]).not.toEqual(regions[1]!["first"])
    // Two inputs with the same settings, in one test case.
    runbook(
      '<Form id="config">\n```yaml\n- name: region\n  type: string\n- name: zone\n  type: string\n```\n</Form>',
      "version: 1\ntests:\n  - name: both\n    inputs:\n      config.region:\n        fuzz: { type: string, length: 12 }\n      config.zone:\n        fuzz: { type: string, length: 12 }\n    steps:\n      - block: config\n",
      "pair",
    )
    const { stdout } = await runTest(["pair", "--output", "json", "--fuzz-seed", "7"])
    const { outputs } = decodeReport(JSON.parse(stdout)).runbooks[0]!.tests[0]!.steps[0]!
    expect(outputs["region"]).toEqual({ _tag: "Shown", value: expect.stringMatching(/^\w{12}$/u) })
    expect(outputs["zone"]).not.toEqual(outputs["region"])
  })

  it("reports no seed when no test case it runs has a fuzz input", async () => {
    runbook(BUILD, BUILD_TEST)
    runbook(BUILD, `version: 1\ntests:\n${TWO_FUZZED}`, "fuzzed")
    const { stdout } = await runTest(["rb", "--output", "json"])
    expect(JSON.parse(stdout)).not.toHaveProperty("fuzzSeed")
    const text = await runTest(["rb", "--fuzz-seed", "7"])
    expect(text.stdout).not.toContain("Fuzz seed")
    expect((await runTest(["fuzzed", "--fuzz-seed", "7"])).stdout).toContain(
      "Fuzz seed: 7 (--fuzz-seed 7 draws the same values)",
    )
  })

  it("writes nothing in the runbook's folder or the working directory", async () => {
    runbook(BUILD, BUILD_TEST)
    const before = readdirSync(folder.path, { recursive: true }).map(String).sort()
    const { code } = await runTest(["rb"])
    expect(code).toBe(0)
    // The Script wrote out.txt: in the test case's temporary folder, gone now.
    expect(readdirSync(folder.path, { recursive: true }).map(String).sort()).toEqual(before)
  })
})
