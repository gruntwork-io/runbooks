/** How a <TfModule> block writes its inputs as HCL for a template. */
import { describe, expect, it } from "bun:test"
import { hclString, hclValue, inputsHcl, isDefault, type InputDefault } from "./inputsHcl.ts"
import { alignAttributes } from "./hclFormat.ts"

describe("hclString", () => {
  it("keeps template sequences literal", () => {
    expect(hclString("Costs ${amount}/month")).toBe('"Costs $${amount}/month"')
    expect(hclString('%{ if x }y%{ endif } ${run_cmd("sh")}')).toBe(
      '"%%{ if x }y%%{ endif } $${run_cmd(\\"sh\\")}"',
    )
  })

  it("escapes quotes, backslashes and newlines", () => {
    expect(hclString('a "b" \\ c\nd')).toBe('"a \\"b\\" \\\\ c\\nd"')
  })

  it("leaves a lone $ or % alone", () => {
    expect(hclString("50% of $5")).toBe('"50% of $5"')
  })
})

describe("hclValue", () => {
  it("writes scalars and null", () => {
    expect(hclValue(3)).toBe("3")
    expect(hclValue(true)).toBe("true")
    expect(hclValue(null)).toBe("null")
  })

  it("writes a list of scalars on one line", () => {
    expect(hclValue(["admins", "readers"])).toBe('["admins", "readers"]')
    expect(hclValue([])).toBe("[]")
  })

  it("writes a map one attribute per line, quoting keys that aren't identifiers", () => {
    expect(hclValue({ Owner: "ops", "kubernetes.io/role": "x" }, "  ")).toBe(
      '{\n    Owner = "ops"\n    "kubernetes.io/role" = "x"\n  }',
    )
    expect(hclValue({})).toBe("{}")
  })

  it("writes a list of maps one item per line", () => {
    expect(hclValue([{ group: "admins" }])).toBe('[\n  {\n    group = "admins"\n  },\n]')
  })
})

describe("isDefault", () => {
  const input = (rest: Partial<InputDefault>): InputDefault => ({
    name: "x",
    kind: "string",
    hasDefault: true,
    ...rest,
  })

  it("never counts a required input as at its default", () => {
    expect(isDefault(input({ hasDefault: false }), "")).toBe(false)
  })

  it("counts an empty value as a null default, since a field can't hold null", () => {
    expect(isDefault(input({ default: null }), "")).toBe(true)
    expect(isDefault(input({ kind: "list", default: null }), [])).toBe(true)
    expect(isDefault(input({ default: null }), "ou-ab12-cd34ef56")).toBe(false)
  })

  it("compares maps whatever their key order", () => {
    expect(isDefault(input({ kind: "map", default: { a: 1, b: 2 } }), { b: 2, a: 1 })).toBe(true)
    expect(isDefault(input({ kind: "list", default: ["default"] }), ["default"])).toBe(true)
    expect(isDefault(input({ kind: "list", default: ["default"] }), ["security"])).toBe(false)
  })

  it("counts an empty string as different from a non-empty default", () => {
    expect(isDefault(input({ default: "Admin" }), "")).toBe(false)
  })
})

describe("inputsHcl", () => {
  const inputs: InputDefault[] = [
    { name: "name", kind: "string", hasDefault: false },
    { name: "parent_id", kind: "string", hasDefault: true, default: null },
    {
      name: "role_name",
      kind: "string",
      hasDefault: true,
      default: "OrganizationAccountAccessRole",
    },
    { name: "owners", kind: "list", hasDefault: true, default: [] },
    { name: "tags", kind: "map", hasDefault: true, default: {} },
  ]

  it("sets required inputs and the ones that differ from the default, in the module's order", () => {
    const values = {
      tags: { Team: "ops" },
      owners: ["a@example.com", "b@example.com"],
      role_name: "OrganizationAccountAccessRole",
      parent_id: "",
      name: "dev",
    }
    expect(inputsHcl(values, inputs)).toBe(
      [
        '  name = "dev"',
        '  owners = ["a@example.com", "b@example.com"]',
        "  tags = {",
        '    Team = "ops"',
        "  }",
      ].join("\n"),
    )
  })

  it("is empty when every input is at its default", () => {
    expect(inputsHcl({ parent_id: "" }, inputs)).toBe("")
  })

  it("comes out as hcl fmt lays it out once aligned", () => {
    const body = inputsHcl(
      { name: "dev", owners: ["a"], tags: { Team: "ops", CostCenter: "1" } },
      inputs,
    )
    expect(alignAttributes(`inputs = {\n${body}\n}\n`)).toBe(
      [
        "inputs = {",
        '  name   = "dev"',
        '  owners = ["a"]',
        "  tags = {",
        '    Team       = "ops"',
        '    CostCenter = "1"',
        "  }",
        "}",
        "",
      ].join("\n"),
    )
  })
})
