import { describe, it, expect, afterEach } from "bun:test"
import { Effect } from "effect"
import * as nodeFs from "node:fs"
import * as nodePath from "node:path"
import * as os from "node:os"
import YAML from "yaml"
import {
  boilerplateCompatibleConfig,
  goFacingTemplateDir,
} from "@runbooks/core/domain/boilerplate/boilerplateCompat"
import { NodeFileSystemLive } from "../../../layers/NodeFileSystem.ts"

describe("boilerplateCompatibleConfig", () => {
  it("leaves a config Boilerplate already accepts alone", () => {
    expect(
      boilerplateCompatibleConfig(
        `
variables:
  - name: env
    type: enum
    options: [dev, prod]
  - name: Regions
    type: list
    x-options: "{{ fromJson .outputs.list_regions.regions }}"
`,
        "/templates/app",
      ),
    ).toBeUndefined()
  })

  it("makes an enum whose options come from an output a string", () => {
    const rewritten = boilerplateCompatibleConfig(
      `
variables:
  # Where to deploy
  - name: Location
    type: enum
    options: "{{ fromJson .outputs.list_regions.regions }}"
    default: eastus
`,
      "/templates/app",
    )
    expect(rewritten).toContain("# Where to deploy")
    expect(YAML.parse(rewritten!)).toEqual({
      variables: [{ name: "Location", type: "string", default: "eastus" }],
    })
  })

  it("replaces labelled options with their values", () => {
    const rewritten = boilerplateCompatibleConfig(
      `
variables:
  - name: Size
    type: enum
    options:
      - value: small
        label: Small (1 vCPU)
      - large
`,
      "/templates/app",
    )
    expect(YAML.parse(rewritten!).variables[0].options).toEqual(["small", "large"])
  })

  it("makes relative local dependency and partial paths absolute, as the copy lives elsewhere", () => {
    const rewritten = boilerplateCompatibleConfig(
      `
variables:
  - name: Location
    type: enum
    options: "{{ .outputs.list_regions.regions }}"
dependencies:
  - name: shared
    template-url: ../shared
    output-folder: .
  - name: remote
    template-url: git@github.com:acme/templates.git//x?ref=v1
    output-folder: .
  - name: https
    template-url: https://github.com/acme/templates//x
    output-folder: .
partials:
  - ../partials/*.html
`,
      "/templates/app",
    )
    const parsed = YAML.parse(rewritten!)
    expect(parsed.dependencies.map((d: { "template-url": string }) => d["template-url"])).toEqual([
      "/templates/shared",
      "git@github.com:acme/templates.git//x?ref=v1",
      "https://github.com/acme/templates//x",
    ])
    expect(parsed.partials).toEqual(["/templates/partials/*.html"])
  })
})

describe("goFacingTemplateDir", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) nodeFs.rmSync(dir, { recursive: true, force: true })
  })

  function template(config: string) {
    const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "compat-template-"))
    dirs.push(dir)
    nodeFs.writeFileSync(nodePath.join(dir, "boilerplate.yml"), config)
    nodeFs.mkdirSync(nodePath.join(dir, "nested"))
    nodeFs.writeFileSync(nodePath.join(dir, "nested", "main.tf"), "region = {{ .Location }}\n")
    return dir
  }

  const run = (dir: string) =>
    Effect.runPromise(goFacingTemplateDir(dir).pipe(Effect.provide(NodeFileSystemLive)))

  it("hands over a template Boilerplate accepts as it is", async () => {
    const dir = template("variables:\n  - name: Location\n    type: string\n")
    expect(await run(dir)).toBe(dir)
  })

  it("copies a template that needs its config rewritten, once per version of its files", async () => {
    const dir = template(
      'variables:\n  - name: Location\n    type: enum\n    options: "{{ fromJson .outputs.list_regions.regions }}"\n',
    )
    const copy = await run(dir)
    dirs.push(copy)
    expect(copy).not.toBe(dir)
    expect(nodeFs.readFileSync(nodePath.join(copy, "nested", "main.tf"), "utf-8")).toBe(
      "region = {{ .Location }}\n",
    )
    expect(
      YAML.parse(nodeFs.readFileSync(nodePath.join(copy, "boilerplate.yml"), "utf-8")),
    ).toEqual({ variables: [{ name: "Location", type: "string" }] })
    // The original is untouched
    expect(nodeFs.readFileSync(nodePath.join(dir, "boilerplate.yml"), "utf-8")).toContain("enum")

    expect(await run(dir)).toBe(copy)

    nodeFs.writeFileSync(nodePath.join(dir, "nested", "main.tf"), "changed\n")
    const next = await run(dir)
    dirs.push(next)
    expect(next).not.toBe(copy)
    expect(nodeFs.existsSync(copy)).toBe(false)
    expect(nodeFs.readFileSync(nodePath.join(next, "nested", "main.tf"), "utf-8")).toBe("changed\n")
  })
})
