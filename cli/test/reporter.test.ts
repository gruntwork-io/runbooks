import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { JUnitReporter, TextReporter, reportToFile } from "./reporter.ts"
import type { RunbookTestSuite, TestResult } from "./config.ts"

// Characters XML 1.0 forbids anywhere in a document, escaped or not.
// eslint-disable-next-line no-control-regex
const XML_INVALID = /[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/

function makeSuite(results: Partial<TestResult>[]): RunbookTestSuite {
  const full: TestResult[] = results.map((r, i) => ({
    testCase: `case-${i}`,
    status: "passed",
    duration: 5,
    stepResults: [],
    assertions: [],
    ...r,
  }))
  return {
    runbookPath: "/runbooks/demo/runbook.mdx",
    duration: 10,
    results: full,
    passed: full.filter((r) => r.status === "passed").length,
    failed: full.filter((r) => r.status === "failed").length,
    skipped: full.filter((r) => r.status === "skipped").length,
    warnings: [],
  }
}

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rb-reporter-"))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// reportToFile
// ---------------------------------------------------------------------------

describe("reportToFile", () => {
  it("has written the full report by the time it returns", () => {
    // The CLI calls process.exit(1) right after this on a failing run, so the
    // file must be complete without waiting for any stream to flush.
    const suites = [makeSuite([{ status: "failed", error: "boom" }])]
    const file = path.join(tmp, "results.xml")

    reportToFile(new JUnitReporter(), suites, file)

    expect(fs.readFileSync(file, "utf-8")).toBe(new JUnitReporter().render(suites))
    expect(fs.readFileSync(file, "utf-8")).toContain('<testsuites tests="1" failures="1"')
  })

  it("throws synchronously when the file cannot be opened", () => {
    // The caller falls back to stdout on a throw; an async stream 'error'
    // would bypass that and crash the process instead.
    const file = path.join(tmp, "missing-dir", "results.xml")
    expect(() => reportToFile(new JUnitReporter(), [makeSuite([{}])], file)).toThrow(/ENOENT/)
  })

  it("writes the text report without ANSI escapes", () => {
    const suites = [makeSuite([{ status: "failed", error: "\x1b[31mred output\x1b[0m" }])]
    const file = path.join(tmp, "results.txt")

    reportToFile(new TextReporter(true), suites, file)

    const text = fs.readFileSync(file, "utf-8")
    expect(text).toContain("red output")
    expect(text).toContain("Results: 0 passed, 1 failed, 0 skipped")
    expect(text).not.toContain("\x1b")
  })
})

// ---------------------------------------------------------------------------
// JUnit XML
// ---------------------------------------------------------------------------

describe("JUnitReporter", () => {
  it("strips ANSI sequences and XML-invalid characters from script output", () => {
    const error =
      "Command block 'x' failed\n\n--- Script Output ---\n\x1b[31mboom\x1b[0m\x07\x00 & <done>"
    const xml = new JUnitReporter().render([makeSuite([{ status: "failed", error }])])

    expect(xml).toContain("boom")
    expect(xml).not.toContain("[31m")
    expect(xml).not.toContain("[0m")
    expect(xml).not.toMatch(XML_INVALID)
    // Ordinary escaping still applies after sanitizing.
    expect(xml).toContain("&amp; &lt;done&gt;")
    expect(xml).toContain("&apos;x&apos;")
  })

  it("strips OSC hyperlink sequences, keeping the link text", () => {
    const error = "see \x1b]8;;https://example.com\x07the docs\x1b]8;;\x07"
    const xml = new JUnitReporter().render([makeSuite([{ status: "failed", error }])])

    expect(xml).toContain("see the docs")
    expect(xml).not.toContain("example.com")
    expect(xml).not.toMatch(XML_INVALID)
  })

  it("puts a runbook's warnings in its suite's error stream, failing nothing", () => {
    const suite = { ...makeSuite([{}]), warnings: ['Command "greet": inserts <x>', "second"] }
    const xml = new JUnitReporter().render([suite])

    expect(xml).toContain(
      "    <system-err>Command &quot;greet&quot;: inserts &lt;x&gt;\nsecond</system-err>\n  </testsuite>",
    )
    expect(xml).toContain('<testsuites tests="1" failures="0"')
  })

  it("has no error stream for a runbook without warnings", () => {
    expect(new JUnitReporter().render([makeSuite([{}])])).not.toContain("system-err")
  })
})

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

describe("TextReporter", () => {
  it("colors the terminal report by default", () => {
    const text = new TextReporter(false).render([makeSuite([{ status: "passed" }])])
    expect(text).toContain("\x1b[32m")
    expect(text).toContain("Results: 1 passed, 0 failed, 0 skipped")
  })

  it("lists a runbook's warnings under its heading and counts them in the summary", () => {
    const suites = [
      {
        ...makeSuite([{ status: "passed" }]),
        warnings: ['Command "greet": one', 'Check "ok": two'],
      },
    ]
    const text = new TextReporter(false, false).render(suites)

    expect(text).toContain(
      'runbook.mdx ===\n  ⚠ Command "greet": one\n  ⚠ Check "ok": two\n  ✓ case-0',
    )
    expect(text).toContain("Results: 1 passed, 0 failed, 0 skipped, 2 warnings")
  })

  it("leaves warnings out of the summary when there are none", () => {
    const text = new TextReporter(false, false).render([makeSuite([{ status: "passed" }])])
    expect(text).not.toContain("warning")
  })

  it("renders the same report on every call", () => {
    const reporter = new TextReporter(false)
    const suites = [makeSuite([{ status: "passed" }])]
    expect(reporter.render(suites)).toBe(reporter.render(suites))
  })
})
