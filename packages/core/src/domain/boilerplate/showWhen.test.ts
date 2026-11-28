import { describe, it, expect } from "bun:test"
import {
  emptyValue,
  hiddenVariables,
  parseShowWhen,
  showWhenProblems,
  withHiddenDefaults,
  type ShowWhenVariable,
} from "./showWhen.ts"

describe("parseShowWhen", () => {
  it("reads a value, or a list of values, for each variable, as strings", () => {
    expect(parseShowWhen({ Layout: "caf", Count: 3, Enabled: true })).toEqual({
      showWhen: { Layout: ["caf"], Count: ["3"], Enabled: ["true"] },
    })
    expect(parseShowWhen({ Layout: ["caf", "custom"] })).toEqual({
      showWhen: { Layout: ["caf", "custom"] },
    })
  })

  it("has no conditions when there are none", () => {
    expect(parseShowWhen(undefined)).toEqual({})
    expect(parseShowWhen(null)).toEqual({})
    expect(parseShowWhen({})).toEqual({})
  })

  it("reports a malformed x-show-when", () => {
    expect(parseShowWhen("Layout")).toHaveProperty("problem")
    expect(parseShowWhen(["Layout"])).toHaveProperty("problem")
    expect(parseShowWhen({ Layout: { a: 1 } }).problem).toContain("Layout")
    expect(parseShowWhen({ Layout: [] }).problem).toContain("Layout")
    expect(parseShowWhen({ Layout: null }).problem).toContain("Layout")
  })
})

describe("hiddenVariables", () => {
  const layout: ShowWhenVariable = {
    name: "Layout",
    type: "enum",
    options: ["single", "caf"],
    default: "single",
  }
  const identity: ShowWhenVariable = {
    name: "Identity",
    type: "string",
    showWhen: { Layout: ["caf"] },
  }

  it("hides a field until its condition holds", () => {
    expect([...hiddenVariables([layout, identity], { Layout: "single" })]).toEqual(["Identity"])
    expect(hiddenVariables([layout, identity], { Layout: "caf" }).size).toBe(0)
  })

  it("matches any of a list of values", () => {
    const either = { ...identity, showWhen: { Layout: ["caf", "custom"] } }
    expect(hiddenVariables([layout, either], { Layout: "custom" }).size).toBe(0)
  })

  it("shows a field only while every condition holds", () => {
    const enabled: ShowWhenVariable = { name: "Enabled", type: "bool" }
    const both = { ...identity, showWhen: { Layout: ["caf"], Enabled: ["true"] } }
    const variables = [layout, enabled, both]
    expect(hiddenVariables(variables, { Layout: "caf", Enabled: true }).size).toBe(0)
    expect(hiddenVariables(variables, { Layout: "caf", Enabled: false }).has("Identity")).toBe(true)
    expect(hiddenVariables(variables, { Layout: "single", Enabled: true }).has("Identity")).toBe(
      true,
    )
  })

  it("matches a multi-select when any of its values does", () => {
    const regions: ShowWhenVariable = { name: "Regions", type: "list", options: ["eu", "us"] }
    const euOnly = { ...identity, showWhen: { Regions: ["eu"] } }
    expect(hiddenVariables([regions, euOnly], { Regions: ["us", "eu"] }).size).toBe(0)
    expect(hiddenVariables([regions, euOnly], { Regions: ["us"] }).has("Identity")).toBe(true)
  })

  it("sees a hidden field's default, not its value, in a condition on it", () => {
    const sku: ShowWhenVariable = {
      name: "Firewall",
      type: "bool",
      default: false,
      showWhen: { Layout: ["caf"] },
    }
    const tier = { ...identity, name: "Tier", showWhen: { Firewall: ["true"] } }
    const hidden = hiddenVariables([layout, sku, tier], { Layout: "single", Firewall: true })
    expect([...hidden].sort()).toEqual(["Firewall", "Tier"])
  })

  it("doesn't hide a field for a condition on a variable it doesn't have, or in a cycle", () => {
    const unknown = { ...identity, showWhen: { Missing: ["x"] } }
    expect(hiddenVariables([unknown], {}).size).toBe(0)

    const a: ShowWhenVariable = { name: "A", type: "string", showWhen: { B: ["x"] } }
    const b: ShowWhenVariable = { name: "B", type: "string", showWhen: { A: ["x"] } }
    expect(hiddenVariables([a, b], { A: "x", B: "x" }).size).toBe(0)
  })
})

describe("withHiddenDefaults", () => {
  it("replaces each hidden field's value with its default, or an empty value", () => {
    const variables: ShowWhenVariable[] = [
      { name: "Shown", type: "string" },
      { name: "Sku", type: "enum", options: ["a", "b"], default: "a" },
      { name: "Id", type: "string" },
    ]
    expect(
      withHiddenDefaults(variables, { Shown: "x", Sku: "b", Id: "y" }, new Set(["Sku", "Id"])),
    ).toEqual({ Shown: "x", Sku: "a", Id: "" })
  })
})

describe("emptyValue", () => {
  it("is empty for the variable's type", () => {
    expect(emptyValue({ name: "s", type: "string" })).toBe("")
    expect(emptyValue({ name: "e", type: "enum" })).toBe("")
    expect(emptyValue({ name: "b", type: "bool" })).toBe(false)
    expect(emptyValue({ name: "i", type: "int" })).toBe(0)
    expect(emptyValue({ name: "l", type: "list" })).toEqual([])
    expect(emptyValue({ name: "m", type: "map" })).toEqual({})
    expect(emptyValue({ name: "t", type: "list", schema: { "0": "string", "1": "bool" } })).toEqual(
      ["", false],
    )
  })
})

describe("showWhenProblems", () => {
  const layout: ShowWhenVariable = { name: "Layout", type: "enum", options: ["single", "caf"] }

  it("finds nothing wrong with valid conditions", () => {
    const identity = { name: "Identity", type: "string", showWhen: { Layout: ["caf"] } }
    expect(showWhenProblems([layout, identity])).toEqual([])
  })

  it("reports a condition on a variable the form doesn't have", () => {
    const identity = { name: "Identity", type: "string", showWhen: { Layuot: ["caf"] } }
    expect(showWhenProblems([layout, identity])).toEqual([
      {
        variable: "Identity",
        condition: "Layuot",
        message: 'the `x-show-when` of the field "Identity" names "Layuot", which is no field here',
      },
    ])
  })

  it("reports a value that isn't one of the variable's options", () => {
    const identity = { name: "Identity", type: "string", showWhen: { Layout: ["caf", "CAF"] } }
    expect(showWhenProblems([layout, identity])).toEqual([
      {
        variable: "Identity",
        condition: "Layout",
        message:
          'the `x-show-when` of the field "Identity" gives "Layout" the value "CAF", which is not one of its options (single, caf)',
      },
    ])
  })

  it("reports conditions that depend on each other in a cycle", () => {
    const a: ShowWhenVariable = { name: "A", type: "string", showWhen: { B: ["x"] } }
    const b: ShowWhenVariable = { name: "B", type: "string", showWhen: { A: ["x"] } }
    expect(showWhenProblems([a, b])).toEqual([
      {
        variable: "A",
        message:
          "the `x-show-when` conditions of these fields depend on each other in a cycle: A → B → A",
      },
    ])
  })
})
