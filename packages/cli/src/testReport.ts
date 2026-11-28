/**
 * `runbooks test`'s report in each format: `text` for people, `junit` for
 * CI test reports, `json` for scripts (the contract's `TestReport`). Text
 * and JUnit keep today's shapes.
 */
import path from "node:path"
import { Schema } from "effect"
import { describeFailure } from "./cliFailure.ts"
import { problemLines, shownPath } from "./configProblems.ts"
import { type TestOutputFormat, TestReport, type TestCaseReport } from "./contract.ts"

const seconds = (millis: number) => `${(millis / 1000).toFixed(2)}s`

const ICON = { passed: "✓", failed: "✗", skipped: "○" } as const

/** Each line of `lines`, indented. */
const indented = (lines: string, by: string) =>
  lines
    .split("\n")
    .map((line) => `${by}${line}`)
    .join("\n")

function testLines(test: TestCaseReport, verbose: boolean): string[] {
  const lines = [`  ${ICON[test.outcome]} ${test.name} (${seconds(test.durationMillis)})`]
  if (test.message !== undefined) lines.push(indented(`Error: ${test.message}`, "    "))
  for (const step of test.steps) {
    if (verbose || !step.passed) {
      const exit = step.exitCode === undefined ? "" : `, exit ${step.exitCode}`
      lines.push(
        `    ${step.passed ? "✓" : "✗"} ${step.block}: ${step.actual} (expected ${step.expected}${exit}, ${seconds(step.durationMillis)})`,
      )
    }
    // With --verbose every log has streamed to stderr already; the report repeats a failed step's.
    if (step.log !== undefined && !step.passed) lines.push(indented(step.log, "      | "))
    for (const a of step.assertions)
      if (verbose || !a.passed)
        lines.push(`      ${a.passed ? "✓" : "✗"} ${a.type}${a.message ? `: ${a.message}` : ""}`)
  }
  for (const a of test.assertions)
    if (verbose || !a.passed)
      lines.push(`    ${a.passed ? "✓" : "✗"} ${a.type}${a.message ? `: ${a.message}` : ""}`)
  return lines
}

function text(report: TestReport, cwd: string, verbose: boolean): string {
  const lines: string[] = []
  for (const runbook of report.runbooks) {
    lines.push("", `=== ${shownPath(runbook.path, cwd)} ===`)
    for (const problem of [...runbook.errors, ...runbook.warnings])
      lines.push(...problemLines(problem, cwd).map((line) => `  ${line}`))
    for (const test of runbook.tests) lines.push(...testLines(test, verbose))
  }
  const { passed, failed, skipped, warnings } = report.summary
  const total = report.runbooks.reduce((n, r) => n + r.durationMillis, 0)
  lines.push(
    "",
    `Results: ${passed} passed, ${failed} failed, ${skipped} skipped${warnings > 0 ? `, ${warnings} ${warnings === 1 ? "warning" : "warnings"}` : ""} (total: ${seconds(total)})`,
  )
  if (report.fuzzSeed !== undefined)
    lines.push(
      `Fuzz seed: ${report.fuzzSeed} (--fuzz-seed ${report.fuzzSeed} draws the same values)`,
    )
  if (report.failure !== undefined) lines.push(describeFailure(report.failure))
  return lines.join("\n")
}

const ESCAPE = 0x1b

/**
 * `value` without terminal color sequences (escape, `[`, parameters, a
 * letter) or the other control characters XML 1.0 forbids: each but tab,
 * newline and carriage return.
 */
function xmlCharacters(value: string): string {
  let kept = ""
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code === ESCAPE && value[i + 1] === "[") {
      i += 2
      while (i < value.length && !/[A-Za-z]/u.test(value[i]!)) i++
      continue
    }
    if (code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) kept += value[i]
  }
  return kept
}

/** XML text and attribute values: escaped, and with only the characters XML 1.0 allows. */
const xml = (value: string) =>
  xmlCharacters(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;")

function junit(report: TestReport): string {
  const properties =
    report.fuzzSeed === undefined
      ? []
      : [
          `    <properties>\n      <property name="fuzzSeed" value="${xml(report.fuzzSeed)}"/>\n    </properties>`,
        ]
  const suites = report.runbooks.map((runbook) => {
    const className = path.basename(path.dirname(runbook.path))
    const cases = runbook.tests.map((test) => {
      let inner = ""
      if (test.outcome === "failed") {
        // The message names the step or assertion that failed; the failed step's log follows it.
        const details = [
          ...(test.message === undefined ? [] : [test.message]),
          ...test.steps.flatMap((s) => (s.passed || s.log === undefined ? [] : [s.log])),
        ]
        inner = `      <failure message="${xml(test.message ?? "")}" type="TestFailure">${xml(details.join("\n"))}</failure>\n`
      } else if (test.outcome === "skipped") inner = "      <skipped/>\n"
      return `    <testcase name="${xml(test.name)}" classname="${xml(className)}" time="${(test.durationMillis / 1000).toFixed(3)}">\n${inner}    </testcase>`
    })
    const problems = [...runbook.errors, ...runbook.warnings].map((p) => p.message)
    if (problems.length > 0) cases.push(`    <system-err>${xml(problems.join("\n"))}</system-err>`)
    const failures = runbook.tests.filter((t) => t.outcome === "failed").length
    const skipped = runbook.tests.filter((t) => t.outcome === "skipped").length
    return `  <testsuite name="${xml(runbook.path)}" tests="${runbook.tests.length}" failures="${failures}" skipped="${skipped}" time="${(runbook.durationMillis / 1000).toFixed(3)}">\n${[...properties, ...cases].join("\n")}\n  </testsuite>`
  })
  const { passed, failed, skipped } = report.summary
  const time = report.runbooks.reduce((n, r) => n + r.durationMillis, 0)
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="${passed + failed + skipped}" failures="${failed}" skipped="${skipped}" time="${(time / 1000).toFixed(3)}">\n${suites.join("\n")}\n</testsuites>\n`
}

const encode = Schema.encodeSync(TestReport)

/** The report in `format`. */
export function renderTestReport(
  report: TestReport,
  format: TestOutputFormat,
  options: { readonly cwd: string; readonly verbose: boolean },
): string {
  switch (format) {
    case "json":
      return `${JSON.stringify(encode(report), null, 2)}\n`
    case "junit":
      return junit(report)
    case "text":
      return `${text(report, options.cwd, options.verbose)}\n`
    default: {
      const unhandled: never = format
      throw new Error(`Unhandled output format: ${String(unhandled)}`)
    }
  }
}
