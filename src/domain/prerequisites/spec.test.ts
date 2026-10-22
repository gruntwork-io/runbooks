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

  it("reads each tool as a requirement of its own", () => {
    const spec = parse("tools:\n  - git\n  - name: gh\n    optional: true\n")
    expect(spec.requirements).toEqual([
      { tools: [spec.tools[0]!], optional: false },
      { tools: [spec.tools[1]!], optional: true },
    ])
  })

  describe("an anyOf list", () => {
    it("is one requirement, whose tools are checked with the others", () => {
      const spec = parse(`
tools:
  - git
  - anyOf:
      - gh
      - name: glab
        version: ">= 1.40"
        install: "[Install the GitLab CLI](https://gitlab.com/gitlab-org/cli)"
    description: Opens the pull or merge request.
`)
      expect(spec.tools.map((tool) => tool.name)).toEqual(["git", "gh", "glab"])
      const [, ghOrGlab] = spec.requirements
      expect(ghOrGlab).toEqual({
        tools: [spec.tools[1]!, spec.tools[2]!],
        description: "Opens the pull or merge request.",
        optional: false,
      })
      expect(spec.tools[2]).toMatchObject({
        name: "glab",
        version: ">= 1.40",
        versionArgs: DEFAULT_VERSION_ARGS,
        install: "[Install the GitLab CLI](https://gitlab.com/gitlab-org/cli)",
        optional: false,
        outputKey: "glab",
      })
    })

    it("makes its tools optional when it is", () => {
      const spec = parse("tools:\n  - anyOf: [tofu, terraform]\n    optional: true\n")
      expect(spec.requirements[0]!.optional).toBe(true)
      expect(spec.tools.map((tool) => tool.optional)).toEqual([true, true])
    })

    it("needs two or more tools, and only its own keys", () => {
      for (const anyOf of ["[gh]", "gh", "[]"]) {
        expect(errorFor(`tools:\n  - anyOf: ${anyOf}\n`)).toBe(
          "Tool 1: `anyOf` must be a list of two or more tools, any one of which will do.",
        )
      }
      expect(
        errorFor("tools:\n  - git\n  - anyOf: [gh, glab]\n    install: brew install gh\n"),
      ).toBe(
        'Tool 2 has an unknown key "install". An `anyOf` list can have anyOf, description, optional, and the other keys go on its tools.',
      )
      expect(errorFor("tools:\n  - name: gh\n    anyOf: [gh, glab]\n")).toBe(
        "Tool 1 has both a `name` and an `anyOf` list. Give each tool in the list its own name.",
      )
      expect(errorFor("tools:\n  - anyOf: [gh, glab]\n    optional: maybe\n")).toBe(
        "Tool 1: `optional` must be true or false.",
      )
      expect(errorFor("tools:\n  - anyOf: [gh, glab]\n    description: [a, list]\n")).toBe(
        "Tool 1: `description` must be text.",
      )
    })

    it("refuses an optional tool in it, a nested list, and a tool without a name", () => {
      expect(
        errorFor("tools:\n  - anyOf:\n      - gh\n      - name: glab\n        optional: true\n"),
      ).toBe(
        '"glab": set `optional` on its `anyOf` list, which is optional or required as a whole.',
      )
      expect(errorFor("tools:\n  - anyOf:\n      - gh\n      - anyOf: [glab, tea]\n")).toBe(
        "Tool 1's `anyOf` item 2 is an `anyOf` list. They can't be nested.",
      )
      expect(errorFor("tools:\n  - anyOf:\n      - gh\n      - version: '1'\n")).toBe(
        "Tool 1's `anyOf` item 2 needs a `name`: the command to look for on PATH.",
      )
    })

    it("refuses a tool that's also listed elsewhere", () => {
      expect(errorFor("tools:\n  - gh\n  - anyOf: [gh, glab]\n")).toBe('"gh" is listed twice.')
      expect(errorFor("tools:\n  - anyOf: [glab, glab]\n")).toBe('"glab" is listed twice.')
    })
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
