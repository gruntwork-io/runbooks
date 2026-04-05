import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import { parseBoilerplateConfig, extractOutputDependencies } from "./config.ts"

function parse(yaml: string) {
  return Effect.runPromise(parseBoilerplateConfig(yaml))
}

describe("parseBoilerplateConfig", () => {
  it("returns empty config for null/empty YAML", async () => {
    const result = await parse("")
    expect(result.variables).toEqual([])
    expect(result.sections).toEqual([])
  })

  it("returns empty config for YAML without variables", async () => {
    const result = await parse("foo: bar")
    expect(result.variables).toEqual([])
  })

  it("fails for invalid YAML", async () => {
    await expect(parse("{{invalid")).rejects.toThrow()
  })

  it("parses a simple string variable", async () => {
    const result = await parse(`
variables:
  - name: project_name
    description: "The project name"
`)
    expect(result.variables).toHaveLength(1)
    expect(result.variables[0].name).toBe("project_name")
    expect(result.variables[0].description).toBe("The project name")
    expect(result.variables[0].type).toBe("string")
  })

  it("coerces variable types correctly", async () => {
    const result = await parse(`
variables:
  - name: a
    type: int
  - name: b
    type: float
  - name: c
    type: bool
  - name: d
    type: list
  - name: e
    type: map
  - name: f
    type: enum
    options: ["x", "y"]
`)
    expect(result.variables.map((v) => v.type)).toEqual([
      "int", "float", "bool", "list", "map", "enum",
    ])
  })

  it("falls back to string for unknown type", async () => {
    const result = await parse(`
variables:
  - name: x
    type: foobar
`)
    expect(result.variables[0].type).toBe("string")
  })

  it("preserves default value", async () => {
    const result = await parse(`
variables:
  - name: region
    default: us-east-1
`)
    expect(result.variables[0].default).toBe("us-east-1")
  })

  it("preserves enum options", async () => {
    const result = await parse(`
variables:
  - name: env
    type: enum
    options: ["dev", "staging", "prod"]
`)
    expect(result.variables[0].options).toEqual(["dev", "staging", "prod"])
  })

  it("detects sensitive flag", async () => {
    const result = await parse(`
variables:
  - name: secret
    sensitive: true
`)
    expect(result.variables[0].sensitive).toBe(true)
  })

  it("maps required validation and sets isRequired", async () => {
    const result = await parse(`
variables:
  - name: name
    validations:
      - type: required
`)
    expect(result.variables[0].required).toBe(true)
    expect(result.variables[0].validations).toHaveLength(1)
    expect(result.variables[0].validations[0].type).toBe("required")
  })

  it("maps multiple validation types", async () => {
    const result = await parse(`
variables:
  - name: site
    validations:
      - type: required
      - type: url
        description: "Must be a URL"
`)
    expect(result.variables[0].validations).toHaveLength(2)
    expect(result.variables[0].validations[1].type).toBe("url")
    expect(result.variables[0].validations[1].message).toBe("Must be a URL")
  })

  it("extracts shorthand args (regex, min, max)", async () => {
    const result = await parse(`
variables:
  - name: code
    validations:
      - type: regex
        regex: "^[A-Z]+$"
      - type: length
        min: 1
        max: 10
`)
    expect(result.variables[0].validations[0].args).toEqual(["^[A-Z]+$"])
    expect(result.variables[0].validations[1].args).toEqual([1, 10])
  })

  it("explicit args take precedence over shorthand", async () => {
    const result = await parse(`
variables:
  - name: x
    validations:
      - type: regex
        args: ["^custom$"]
        regex: "^ignored$"
`)
    expect(result.variables[0].validations[0].args).toEqual(["^custom$"])
  })

  it("maps unknown validation type to custom", async () => {
    const result = await parse(`
variables:
  - name: x
    validations:
      - type: special_check
`)
    expect(result.variables[0].validations[0].type).toBe("custom")
  })

  it("preserves x-schema extension", async () => {
    const result = await parse(`
variables:
  - name: vpc
    x-schema:
      type: vpc
      region: us-east-1
`)
    expect(result.variables[0].schema).toEqual({ type: "vpc", region: "us-east-1" })
  })

  it("preserves x-schema-instance-label", async () => {
    const result = await parse(`
variables:
  - name: vpc
    x-schema-instance-label: "VPC Name"
`)
    expect(result.variables[0].schemaInstanceLabel).toBe("VPC Name")
  })

  it("groups variables into sections by x-section", async () => {
    const result = await parse(`
variables:
  - name: a
  - name: b
    x-section: Network
  - name: c
    x-section: Network
  - name: d
    x-section: Compute
`)
    expect(result.sections).toHaveLength(3)
    expect(result.sections[0].name).toBe("")
    expect(result.sections[0].variables).toEqual(["a"])
    expect(result.sections[1].name).toBe("Network")
    expect(result.sections[1].variables).toEqual(["b", "c"])
    expect(result.sections[2].name).toBe("Compute")
    expect(result.sections[2].variables).toEqual(["d"])
  })

  it("ensures unnamed section is always first", async () => {
    const result = await parse(`
variables:
  - name: a
    x-section: First
  - name: b
`)
    expect(result.sections[0].name).toBe("")
    expect(result.sections[1].name).toBe("First")
  })

  it("skips variables without names", async () => {
    const result = await parse(`
variables:
  - description: "no name"
  - name: valid
`)
    expect(result.variables).toHaveLength(1)
    expect(result.variables[0].name).toBe("valid")
  })
})

describe("extractOutputDependencies", () => {
  it("returns empty for content without template blocks", () => {
    expect(extractOutputDependencies("plain text")).toEqual([])
  })

  it("extracts a single output dependency", () => {
    const deps = extractOutputDependencies("{{ .outputs.block1.value }}")
    expect(deps).toHaveLength(1)
    expect(deps[0].blockId).toBe("block1")
    expect(deps[0].outputName).toBe("value")
    expect(deps[0].fullPath).toBe("outputs.block1.value")
  })

  it("extracts multiple dependencies", () => {
    const deps = extractOutputDependencies(
      "{{ .outputs.a.x }} and {{ .outputs.b.y }}",
    )
    expect(deps).toHaveLength(2)
  })

  it("deduplicates identical dependencies", () => {
    const deps = extractOutputDependencies(
      "{{ .outputs.a.x }} {{ .outputs.a.x }}",
    )
    expect(deps).toHaveLength(1)
  })

  it("normalizes block ID hyphens to underscores", () => {
    const deps = extractOutputDependencies("{{ .outputs.my-block.val }}")
    expect(deps[0].blockId).toBe("my-block")
    expect(deps[0].fullPath).toBe("outputs.my_block.val")
  })

  it("handles whitespace-trimming markers", () => {
    const deps = extractOutputDependencies("{{- .outputs.block.val -}}")
    expect(deps).toHaveLength(1)
    expect(deps[0].outputName).toBe("val")
  })

  it("ignores content outside template blocks", () => {
    const deps = extractOutputDependencies("outputs.block.val")
    expect(deps).toEqual([])
  })
})
