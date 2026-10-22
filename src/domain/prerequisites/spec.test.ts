import { describe, it, expect } from "bun:test"
import {
  DEFAULT_VERSION_ARGS,
  extractToolList,
  hasTextOutsideToolList,
  parsePrerequisitesSpec,
  toolOutputKey,
  type PrerequisitesSpec,
} from "./spec.ts"

/** The spec `yaml` parses to, failing the test if it doesn't parse. */
function parse(yaml: string): PrerequisitesSpec {
  const parsed = parsePrerequisitesSpec(yaml)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.spec
}

/** The error `yaml` fails to parse with. */
function errorFor(yaml: string): string {
  const parsed = parsePrerequisitesSpec(yaml)
  if (parsed.ok) throw new Error("expected the spec to be refused")
  return parsed.error
}

describe("parsePrerequisitesSpec", () => {
  it("reads a bare name as a required tool whose version isn't read", () => {
    expect(parse("tools:\n  - git\n").tools).toEqual([
      {
        name: "git",
        description: undefined,
        version: undefined,
        constraint: undefined,
        versionArgs: undefined,
        install: undefined,
        optional: false,
        outputKey: "git",
      },
    ])
  })

  it("reads every field of a tool", () => {
    const [tool] = parse(`
tools:
  - name: kubectl
    description: Talks to the cluster.
    version: ">= 1.28"
    versionArgs: [version, --client]
    install: Run \`brew install kubectl\`.
    optional: true
`).tools
    expect(tool).toMatchObject({
      name: "kubectl",
      description: "Talks to the cluster.",
      version: ">= 1.28",
      constraint: { conditions: [{ operator: ">=", version: [1, 28] }] },
      versionArgs: ["version", "--client"],
      install: "Run `brew install kubectl`.",
      optional: true,
      outputKey: "kubectl",
    })
  })

  it("reads a version with --version when no versionArgs are given", () => {
    const [tool] = parse('tools:\n  - name: tofu\n    version: "~> 1.8"\n').tools
    expect(tool!.versionArgs).toBe(DEFAULT_VERSION_ARGS)
  })

  it("splits versionArgs given as one string on whitespace", () => {
    const [tool] = parse("tools:\n  - name: kubectl\n    versionArgs: version  --client\n").tools
    expect(tool!.versionArgs).toEqual(["version", "--client"])
  })

  it("parses the uniformly indented YAML of an indented code fence", () => {
    expect(parse("    tools:\n      - git\n      - gh\n    ").tools.map((t) => t.name)).toEqual([
      "git",
      "gh",
    ])
  })

  it("passes on the YAML's own error", () => {
    expect(errorFor("tools: [git")).toStartWith("The tool list isn't valid YAML: ")
  })

  it("needs a non-empty `tools:` list and nothing else", () => {
    expect(errorFor("- git\n")).toBe("List the tools under a `tools:` key.")
    expect(errorFor("")).toBe("List the tools under a `tools:` key.")
    expect(errorFor("tools: []\n")).toBe("`tools:` must be a list with at least one tool.")
    expect(errorFor("tools: git\n")).toBe("`tools:` must be a list with at least one tool.")
    expect(errorFor("tools: [git]\ntool: [gh]\n")).toBe(
      'Unknown key "tool": the YAML has only a `tools:` list.',
    )
  })

  it("needs each tool to have a command name", () => {
    expect(errorFor("tools:\n  - 42\n")).toBe("Tool 1 must be a name, or a map with a `name`.")
    expect(errorFor("tools:\n  - git\n  - version: '1'\n")).toBe(
      "Tool 2 needs a `name`: the command to look for on PATH.",
    )
    for (const name of ["/usr/bin/git", "./tofu", "rm -rf", "$(id)", "-v"]) {
      expect(errorFor(`tools:\n  - name: "${name}"\n`)).toContain(`"${name}" isn't a command name`)
    }
  })

  it("refuses a key a tool doesn't have, so a typo isn't ignored", () => {
    expect(errorFor("tools:\n  - name: tofu\n    versions: '>= 1.6'\n")).toBe(
      '"tofu" has an unknown key "versions". A tool can have name, description, version, versionArgs, install, optional.',
    )
  })

  it("refuses fields of the wrong type", () => {
    expect(errorFor("tools:\n  - name: gh\n    optional: yes please\n")).toBe(
      '"gh": `optional` must be true or false.',
    )
    expect(errorFor("tools:\n  - name: gh\n    install: [brew, install, gh]\n")).toBe(
      '"gh": `install` must be text.',
    )
    expect(errorFor("tools:\n  - name: gh\n    versionArgs: [--version, 2]\n")).toBe(
      '"gh": `versionArgs` must be a list of arguments, such as [version, --client].',
    )
  })

  it("refuses an unquoted version, which YAML reads as a number, and a version that isn't text", () => {
    expect(errorFor("tools:\n  - name: tofu\n    version: 1.10\n")).toBe(
      '"tofu": quote the version, as in version: ">= 1.6". YAML reads an unquoted 1.10 as the number 1.1.',
    )
    expect(errorFor("tools:\n  - name: tofu\n    version: { min: '1.6' }\n")).toBe(
      '"tofu": `version` must be text, such as ">= 1.6".',
    )
  })

  it("refuses a version constraint it can't read", () => {
    expect(errorFor("tools:\n  - name: tofu\n    version: latest\n")).toBe(
      `"tofu": "latest" isn't a version condition such as ">= 1.6" or "~> 1.6".`,
    )
  })

  it("refuses a tool listed twice, and two tools whose outputs would collide", () => {
    expect(errorFor("tools:\n  - git\n  - name: git\n")).toBe('"git" is listed twice.')
    expect(errorFor("tools:\n  - docker-compose\n  - docker_compose\n")).toBe(
      '"docker-compose" and "docker_compose" would publish the same outputs (docker_compose_path). List only one of them.',
    )
  })
})

describe("toolOutputKey", () => {
  it("makes an output name from a tool name", () => {
    expect(toolOutputKey("git")).toBe("git")
    expect(toolOutputKey("session-manager-plugin")).toBe("session_manager_plugin")
    expect(toolOutputKey("g++")).toBe("g__")
    expect(toolOutputKey("python3.12")).toBe("python3_12")
    expect(toolOutputKey("7z")).toBe("_7z")
  })
})

describe("extractToolList", () => {
  it("returns the text of the block's code fence, whatever its language", () => {
    expect(extractToolList("\n```yaml\ntools:\n  - git\n```\n")).toBe("tools:\n  - git\n")
    expect(extractToolList("\n```\ntools: [git]\n```\n")).toBe("tools: [git]\n")
  })

  it("reads a longer or tilde fence to its own closing fence, which may be indented", () => {
    expect(extractToolList("\n````yaml\ntools: [git]\n```\nmore\n````\n")).toBe(
      "tools: [git]\n```\nmore\n",
    )
    expect(extractToolList("\n~~~\ntools: [git]\n~~~\n")).toBe("tools: [git]\n")
    expect(extractToolList("\n  ```yaml\n  tools: [git]\n  ```\n")).toBe("  tools: [git]\n")
  })

  it("returns null for a block without a code fence", () => {
    expect(extractToolList("")).toBeNull()
    expect(extractToolList("\ntools:\n  - git\n")).toBeNull()
  })
})

describe("hasTextOutsideToolList", () => {
  it("is false for a block with only its code fence", () => {
    expect(hasTextOutsideToolList("\n```yaml\ntools: [git]\n```\n")).toBe(false)
  })

  it("is true for text before or after the fence, or a block without one", () => {
    expect(hasTextOutsideToolList("\nYou need:\n\n```yaml\ntools: [git]\n```\n")).toBe(true)
    expect(hasTextOutsideToolList("\n```yaml\ntools: [git]\n```\n```\nx\n```\n")).toBe(true)
    expect(hasTextOutsideToolList("\ntools: [git]\n")).toBe(true)
  })
})
