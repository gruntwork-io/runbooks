import { describe, it, expect } from "bun:test"
import { parsePrerequisitesSpec, type PrerequisiteTool, type PrerequisitesSpec } from "./spec.ts"
import {
  checkLog,
  checkTool,
  describeResult,
  evaluateTool,
  foundInstead,
  prerequisitesOutputs,
  prerequisitesStatus,
  resultsFromOutputs,
  statusExitCode,
  summarize,
  unmetRequirements,
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
    const results = [
      evaluateTool(GIT, "/g", null),
      evaluateTool(TOFU, "/t", "1.8"),
      evaluateTool(GH, "/gh", "2.40.1"),
    ]
    expect(prerequisitesStatus(SPEC, results)).toBe("success")
  })

  it("warns when only an optional tool isn't found", () => {
    const results = [
      evaluateTool(GIT, "/g", null),
      evaluateTool(TOFU, "/t", "1.8"),
      evaluateTool(GH, null, null),
    ]
    expect(prerequisitesStatus(SPEC, results)).toBe("warn")
  })

  it("fails when a required tool isn't found, at the right version", () => {
    const tooOld = [
      evaluateTool(GIT, "/g", null),
      evaluateTool(TOFU, "/t", "1.0"),
      evaluateTool(GH, "/gh", null),
    ]
    expect(prerequisitesStatus(SPEC, tooOld)).toBe("fail")
    const missing = [
      evaluateTool(GIT, null, null),
      evaluateTool(TOFU, "/t", "1.8"),
      evaluateTool(GH, null, null),
    ]
    expect(prerequisitesStatus(SPEC, missing)).toBe("fail")
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
    const one = parse("tools:\n  - git\n")
    expect(summarize(one, [evaluateTool(one.tools[0]!, "/g", null)])).toEqual({
      level: "INFO",
      text: "git is installed.",
    })
    const git = evaluateTool(GIT, "/g", null)
    const tofu = evaluateTool(TOFU, "/t", "1.8")
    expect(summarize(SPEC, [git, tofu, evaluateTool(GH, "/gh", null)])).toEqual({
      level: "INFO",
      text: "All 3 tools are installed.",
    })
    expect(summarize(SPEC, [git, tofu, evaluateTool(GH, null, null)])).toEqual({
      level: "WARN",
      text: "The required tools are installed. Optional tools to install or update: gh.",
    })
    expect(
      summarize(SPEC, [git, evaluateTool(TOFU, "/t", "1.0"), evaluateTool(GH, null, null)]),
    ).toEqual({
      level: "ERROR",
      text: "Tools to install or update: tofu, gh (optional).",
    })
  })
})

describe("an anyOf list", () => {
  const LISTS = parse(`
tools:
  - git
  - anyOf:
      - gh
      - name: glab
        version: ">= 1.40"
    description: Opens the pull or merge request.
  - anyOf: [tofu, terraform]
    optional: true
`)
  const [L_GIT, L_GH, L_GLAB, L_TOFU, L_TERRAFORM] = LISTS.tools as [
    PrerequisiteTool,
    PrerequisiteTool,
    PrerequisiteTool,
    PrerequisiteTool,
    PrerequisiteTool,
  ]
  const results = (
    gh: string | null,
    glab: [string | null, string | null],
    tofu: string | null,
    terraform: string | null,
  ) => [
    evaluateTool(L_GIT, "/g", null),
    evaluateTool(L_GH, gh, null),
    evaluateTool(L_GLAB, ...glab),
    evaluateTool(L_TOFU, tofu, null),
    evaluateTool(L_TERRAFORM, terraform, null),
  ]

  it("is met by any one of its tools, and counts as one tool", () => {
    const glabMissing = results("/gh", [null, null], null, "/tf")
    expect(prerequisitesStatus(LISTS, glabMissing)).toBe("success")
    expect(unmetRequirements(LISTS, glabMissing)).toEqual([])
    expect(summarize(LISTS, glabMissing)).toEqual({
      level: "INFO",
      text: "All 3 tools are installed.",
    })

    const ghMissing = results(null, ["/glab", "1.46.1"], "/tofu", null)
    expect(prerequisitesStatus(LISTS, ghMissing)).toBe("success")
  })

  it("fails when it's required and none of its tools is found, and warns when it's optional", () => {
    const glabTooOld = results(null, ["/glab", "1.30.0"], "/tofu", null)
    expect(prerequisitesStatus(LISTS, glabTooOld)).toBe("fail")
    expect(unmetRequirements(LISTS, glabTooOld)).toEqual([LISTS.requirements[1]!])
    expect(summarize(LISTS, glabTooOld)).toEqual({
      level: "ERROR",
      text: "Tools to install or update: gh or glab.",
    })

    const noTofu = results("/gh", [null, null], null, null)
    expect(prerequisitesStatus(LISTS, noTofu)).toBe("warn")
    expect(summarize(LISTS, noTofu)).toEqual({
      level: "WARN",
      text: "The required tools are installed. Optional tools to install or update: tofu or terraform.",
    })

    expect(summarize(LISTS, results(null, [null, null], null, null))).toEqual({
      level: "ERROR",
      text: "Tools to install or update: gh or glab, tofu or terraform (optional).",
    })
  })

  it("logs a tool another of its list stands in for as information", () => {
    const checked = [
      checkTool(L_GIT, "/g", null),
      checkTool(L_GH, "/gh", null),
      checkTool(L_GLAB, "/glab", { output: "glab: no version here", exitCode: 0 }),
      checkTool(L_TOFU, null, null),
      checkTool(L_TERRAFORM, null, null),
    ]
    const all = checked.map(({ result }) => result)
    expect(foundInstead(LISTS, all[2]!, all)).toBe(L_GH)
    expect(foundInstead(LISTS, all[1]!, all)).toBeNull()
    expect(foundInstead(LISTS, all[3]!, all)).toBeNull()

    expect(checkLog(LISTS, checked)).toEqual([
      { level: "INFO", text: "git: found at /g" },
      { level: "INFO", text: "gh: found at /gh" },
      {
        level: "INFO",
        text: 'glab at /glab: "glab --version" printed no version number to check against >= 1.40. gh is installed instead.',
      },
      { level: "INFO", text: '"glab --version" printed: glab: no version here' },
      { level: "WARN", text: "tofu: not found on PATH. This tool is optional." },
      { level: "WARN", text: "terraform: not found on PATH. This tool is optional." },
      {
        level: "WARN",
        text: "The required tools are installed. Optional tools to install or update: tofu or terraform.",
      },
    ])
  })

  it("publishes each of its tools' outputs", () => {
    expect(prerequisitesOutputs(results("/gh", ["/glab", "1.46.1"], null, null))).toEqual({
      git_path: "/g",
      gh_path: "/gh",
      glab_path: "/glab",
      glab_version: "1.46.1",
      tofu_path: "",
      terraform_path: "",
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
