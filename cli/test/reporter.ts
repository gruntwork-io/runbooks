/**
 * Test result reporters: human-readable text and JUnit XML.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import type { RunbookTestSuite } from "./config.ts"

// ---------------------------------------------------------------------------
// Reporter interface
// ---------------------------------------------------------------------------

export interface Reporter {
  report(suites: RunbookTestSuite[]): void
}

// ---------------------------------------------------------------------------
// Text reporter
// ---------------------------------------------------------------------------

export class TextReporter implements Reporter {
  constructor(
    private out: NodeJS.WritableStream,
    private verbose: boolean,
  ) {}

  report(suites: RunbookTestSuite[]): void {
    let totalPassed = 0
    let totalFailed = 0
    let totalSkipped = 0
    let totalDuration = 0

    for (const suite of suites) {
      const relPath = relativePath(suite.runbookPath)

      if (this.verbose) {
        this.write(`\n── Summary: ${relPath} ──\n`)
      } else {
        this.write(`\n=== ${relPath} ===\n`)
      }

      for (const result of suite.results) {
        let icon: string
        let color: string
        if (result.status === "failed") {
          icon = "✗"; color = "\x1b[31m"
        } else if (result.status === "skipped") {
          icon = "○"; color = "\x1b[33m"
        } else {
          icon = "✓"; color = "\x1b[32m"
        }
        const reset = "\x1b[0m"

        this.write(`  ${color}${icon}${reset} ${result.testCase} (${formatDuration(result.duration)})\n`)

        if (result.error) {
          this.write(`    ${color}Error: ${result.error}${reset}\n`)
        }

        if (this.verbose) {
          for (const step of result.stepResults) {
            const stepIcon = step.passed ? "✓" : "✗"
            const stepColor = step.passed ? "\x1b[32m" : "\x1b[31m"

            let outputInfo = ""
            if (Object.keys(step.outputs).length > 0) {
              outputInfo = ` [${Object.keys(step.outputs).length} output(s)]`
            }

            this.write(
              `    ${stepColor}${stepIcon}${reset} ${step.block}: ${step.actualStatus}${outputInfo} (${formatDuration(step.duration)})\n`,
            )

            if (step.error && !step.errorDisplayed && step.error !== result.error) {
              this.write(`      Error: ${step.error}\n`)
            }
          }

          for (const ar of result.assertions) {
            const arIcon = ar.passed ? "✓" : "✗"
            const arColor = ar.passed ? "\x1b[32m" : "\x1b[31m"
            const reset = "\x1b[0m"
            this.write(`    ${arColor}${arIcon}${reset} Assertion ${ar.type}\n`)
            if (ar.message) {
              this.write(`      ${ar.message}\n`)
            }
          }
        }
      }

      totalPassed += suite.passed
      totalFailed += suite.failed
      totalSkipped += suite.skipped
      totalDuration += suite.duration
    }

    // Summary
    this.write("\n")
    const summaryColor = totalFailed > 0 ? "\x1b[31m" : "\x1b[32m"
    const reset = "\x1b[0m"
    this.write(
      `${summaryColor}Results: ${totalPassed} passed, ${totalFailed} failed, ${totalSkipped} skipped${reset} (total: ${formatDuration(totalDuration)})\n`,
    )
  }

  private write(s: string): void {
    this.out.write(s)
  }
}

// ---------------------------------------------------------------------------
// JUnit XML reporter
// ---------------------------------------------------------------------------

export class JUnitReporter implements Reporter {
  constructor(private out: NodeJS.WritableStream) {}

  report(suites: RunbookTestSuite[]): void {
    let totalTests = 0
    let totalFailures = 0
    let totalSkipped = 0
    let totalTime = 0

    const suiteXmls: string[] = []

    for (const suite of suites) {
      const cases: string[] = []

      for (const result of suite.results) {
        const className = path.basename(path.dirname(suite.runbookPath))
        const time = (result.duration / 1000).toFixed(3)

        let inner = ""
        if (result.status === "failed") {
          const details: string[] = []
          if (result.error) details.push(result.error)
          for (const step of result.stepResults) {
            if (!step.passed && step.error) {
              details.push(`Block ${step.block}: ${step.error}`)
            }
          }
          for (const ar of result.assertions) {
            if (!ar.passed && ar.message) {
              details.push(`Assertion ${ar.type}: ${ar.message}`)
            }
          }
          inner = `      <failure message="${escapeXml(result.error ?? "")}" type="TestFailure">${escapeXml(details.join("\n"))}</failure>\n`
        } else if (result.status === "skipped") {
          inner = "      <skipped/>\n"
        }

        cases.push(
          `    <testcase name="${escapeXml(result.testCase)}" classname="${escapeXml(className)}" time="${time}">\n${inner}    </testcase>`,
        )
      }

      const suiteTime = (suite.duration / 1000).toFixed(3)
      suiteXmls.push(
        `  <testsuite name="${escapeXml(suite.runbookPath)}" tests="${suite.results.length}" failures="${suite.failed}" skipped="${suite.skipped}" time="${suiteTime}">\n${cases.join("\n")}\n  </testsuite>`,
      )

      totalTests += suite.results.length
      totalFailures += suite.failed
      totalSkipped += suite.skipped
      totalTime += suite.duration
    }

    const totalTimeStr = (totalTime / 1000).toFixed(3)
    this.out.write(`<?xml version="1.0" encoding="UTF-8"?>\n`)
    this.out.write(
      `<testsuites tests="${totalTests}" failures="${totalFailures}" skipped="${totalSkipped}" time="${totalTimeStr}">\n${suiteXmls.join("\n")}\n</testsuites>\n`,
    )
  }
}

// ---------------------------------------------------------------------------
// Write results to file
// ---------------------------------------------------------------------------

export function reportToFile(
  reporter: Reporter,
  suites: RunbookTestSuite[],
  filePath: string,
): void {
  const stream = fs.createWriteStream(filePath)
  if (reporter instanceof TextReporter) {
    new TextReporter(stream, false).report(suites)
  } else if (reporter instanceof JUnitReporter) {
    new JUnitReporter(stream).report(suites)
  }
  stream.end()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativePath(absPath: string): string {
  try {
    const rel = path.relative(process.cwd(), absPath)
    return rel || absPath
  } catch {
    return absPath
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}
