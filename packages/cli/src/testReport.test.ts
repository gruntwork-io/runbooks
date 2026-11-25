import { describe, expect, it } from "bun:test"
import type { TestReport } from "./contract.ts"
import { renderTestReport } from "./testReport.ts"

const report = (log: string, name: string): TestReport => ({
  version: 1,
  outcome: "failed",
  runbooks: [
    {
      path: "/work/rb/runbook.mdx",
      durationMillis: 1500,
      errors: [],
      warnings: [],
      tests: [
        {
          name,
          outcome: "failed",
          durationMillis: 1500,
          message: "deploy: Expected success, got fail",
          steps: [
            {
              block: "deploy",
              expected: "success",
              actual: "fail",
              passed: false,
              exitCode: 1,
              durationMillis: 1500,
              outputs: {},
              log,
              assertions: [],
            },
          ],
          assertions: [],
        },
      ],
    },
  ],
  summary: { runbooks: 1, passed: 0, failed: 1, skipped: 0, warnings: 0 },
})

describe("the junit report", () => {
  it("escapes markup and drops color sequences and the control characters XML forbids", () => {
    const xml = renderTestReport(
      report('\u001b[31mred\u001b[0m <b> & "q"\u0007\ttab', `a "quoted" <name>`),
      "junit",
      { cwd: "/work", verbose: false },
    )
    expect(xml).toContain(
      '<testcase name="a &quot;quoted&quot; &lt;name&gt;" classname="rb" time="1.500">',
    )
    expect(xml).toContain("red &lt;b&gt; &amp; &quot;q&quot;\ttab</failure>")
    expect(xml).not.toContain("\u001b")
    expect(xml).not.toContain("\u0007")
  })
})

describe("the text report", () => {
  it("names each runbook by its path from the working directory, with the failed step's log", () => {
    const text = renderTestReport(report("one\ntwo", "deploys"), "text", {
      cwd: "/work",
      verbose: false,
    })
    expect(text).toBe(
      [
        "",
        "=== rb/runbook.mdx ===",
        "  ✗ deploys (1.50s)",
        "    Error: deploy: Expected success, got fail",
        "    ✗ deploy: fail (expected success, exit 1, 1.50s)",
        "      | one",
        "      | two",
        "",
        "Results: 0 passed, 1 failed, 0 skipped (total: 1.50s)",
        "",
      ].join("\n"),
    )
  })
})
