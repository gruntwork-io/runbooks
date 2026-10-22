import { describe, it, expect } from "bun:test"
import { parsePrerequisitesSpec, type PrerequisitesSpec } from "./spec.ts"
import {
  describeResult,
  evaluateTool,
  prerequisitesOutputs,
  prerequisitesStatus,
  resultsFromOutputs,
  statusExitCode,
  summarize,
  versionCommand,
  type ToolResult,
} from "./results.ts"

const SPEC = parse(`
tools:
  - git
  - name: tofu
    version: ">= 1.6"
  - name: gh
    versionArgs: [--version]
    optional: true
`)
const [GIT, TOFU, GH] = SPEC.tools as [
  PrerequisitesSpec["tools"][number],
  PrerequisitesSpec["tools"][number],
  PrerequisitesSpec["tools"][number],
]

function parse(yaml: string): PrerequisitesSpec {
  const parsed = parsePrerequisitesSpec(yaml)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.spec
}

describe("evaluateTool", () => {
  it("finds a tool on PATH without a constraint whatever its version", () => {
    expect(evaluateTool(GIT, "/usr/bin/git", null)).toEqual({
      tool: GIT,
      status: "found",
      path: "/usr/bin/git",
      version: null,
    })
  })

  it("reports a tool that isn't on PATH as missing", () => {
    expect(evaluateTool(TOFU, null, null).status).toBe("missing")
  })

  it("checks the version of a tool with a constraint", () => {
    expect(evaluateTool(TOFU, "/bin/tofu", "1.8.2").status).toBe("found")
    expect(evaluateTool(TOFU, "/bin/tofu", "1.5.0")).toEqual({
      tool: TOFU,
      status: "wrong_version",
      path: "/bin/tofu",
      version: "1.5.0",
    })
    expect(evaluateTool(TOFU, "/bin/tofu", null).status).toBe("unknown_version")
  })
})

describe("prerequisitesStatus", () => {
  it("succeeds when every tool is found", () => {
    const results = [evaluateTool(GIT, "/g", null), evaluateTool(GH, "/gh", "2.40.1")]
    expect(prerequisitesStatus(results)).toBe("success")
  })

  it("warns when only an optional tool isn't found", () => {
    const results = [evaluateTool(GIT, "/g", null), evaluateTool(GH, null, null)]
    expect(prerequisitesStatus(results)).toBe("warn")
  })

  it("fails when a required tool isn't found, at the right version", () => {
    expect(prerequisitesStatus([evaluateTool(TOFU, "/t", "1.0")])).toBe("fail")
    expect(prerequisitesStatus([evaluateTool(GIT, null, null), evaluateTool(GH, null, null)])).toBe(
      "fail",
    )
  })

  it("maps to a script's exit codes", () => {
    expect([statusExitCode("success"), statusExitCode("warn"), statusExitCode("fail")]).toEqual([
      0, 2, 1,
    ])
  })
})

describe("prerequisitesOutputs", () => {
  it("publishes every tool's path, and the versions it read", () => {
    const results = [
      evaluateTool(GIT, "/usr/bin/git", null),
      evaluateTool(TOFU, "/bin/tofu", null),
      evaluateTool(GH, null, null),
    ]
    expect(prerequisitesOutputs(results)).toEqual({
      git_path: "/usr/bin/git",
      tofu_path: "/bin/tofu",
      tofu_version: "",
      gh_path: "",
    })
  })
})

describe("resultsFromOutputs", () => {
  it("works out the results a run's outputs came from", () => {
    const results: ToolResult[] = [
      evaluateTool(GIT, "/usr/bin/git", null),
      evaluateTool(TOFU, "/bin/tofu", "1.5.0"),
      evaluateTool(GH, null, null),
    ]
    expect(resultsFromOutputs(SPEC, prerequisitesOutputs(results))).toEqual(results)
  })

  it("has no result for a tool the run didn't check", () => {
    expect(resultsFromOutputs(SPEC, { git_path: "/usr/bin/git" })).toEqual([
      evaluateTool(GIT, "/usr/bin/git", null),
      null,
      null,
    ])
  })
})

describe("describeResult", () => {
  it("says where a found tool is, at what version, against what constraint", () => {
    expect(describeResult(evaluateTool(GIT, "/usr/bin/git", null))).toEqual({
      level: "INFO",
      text: "git: found at /usr/bin/git",
    })
    expect(describeResult(evaluateTool(TOFU, "/bin/tofu", "1.8.2"))).toEqual({
      level: "INFO",
      text: "tofu 1.8.2 (needs >= 1.6): found at /bin/tofu",
    })
  })

  it("logs a required tool's problem as an error and an optional one's as a warning", () => {
    expect(describeResult(evaluateTool(TOFU, null, null))).toEqual({
      level: "ERROR",
      text: "tofu: not found on PATH.",
    })
    expect(describeResult(evaluateTool(GH, null, null))).toEqual({
      level: "WARN",
      text: "gh: not found on PATH. This tool is optional.",
    })
    expect(describeResult(evaluateTool(TOFU, "/bin/tofu", "1.5.0"))).toEqual({
      level: "ERROR",
      text: "tofu 1.5.0 at /bin/tofu doesn't meet the version requirement >= 1.6.",
    })
    expect(describeResult(evaluateTool(TOFU, "/bin/tofu", null))).toEqual({
      level: "ERROR",
      text: 'tofu at /bin/tofu: "tofu --version" printed no version number to check against >= 1.6.',
    })
  })
})

describe("summarize", () => {
  it("sums up the run", () => {
    expect(summarize([evaluateTool(GIT, "/g", null)])).toEqual({
      level: "INFO",
      text: "git is installed.",
    })
    expect(summarize([evaluateTool(GIT, "/g", null), evaluateTool(TOFU, "/t", "1.8")])).toEqual({
      level: "INFO",
      text: "All 2 tools are installed.",
    })
    expect(summarize([evaluateTool(GIT, "/g", null), evaluateTool(GH, null, null)])).toEqual({
      level: "WARN",
      text: "The required tools are installed. Optional tools to install or update: gh.",
    })
    expect(summarize([evaluateTool(TOFU, "/t", "1.0"), evaluateTool(GH, null, null)])).toEqual({
      level: "ERROR",
      text: "Tools to install or update: tofu, gh (optional).",
    })
  })
})

describe("versionCommand", () => {
  it("is the command as it would be typed", () => {
    expect(versionCommand(TOFU)).toBe("tofu --version")
    expect(versionCommand(GIT)).toBe("git")
    const [tool] = parse(
      `tools:\n  - name: tool\n    versionArgs: ["--format", "{{ .Version }}", "it's", ""]\n`,
    ).tools
    expect(versionCommand(tool!)).toBe(`tool --format '{{ .Version }}' 'it'\\''s' ''`)
  })
})
