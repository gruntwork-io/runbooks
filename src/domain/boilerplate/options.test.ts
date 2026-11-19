import { describe, it, expect } from "bun:test"
import {
  optionFields,
  optionItems,
  optionMembershipError,
  parseOptionsReference,
  parseOutputOptions,
  type OptionsReference,
} from "./options.ts"

const reference: OptionsReference = {
  expression: "{{ fromJson .outputs.list_regions.regions }}",
  blockId: "list_regions",
  outputName: "regions",
}

describe("parseOptionsReference", () => {
  it.each([
    ["{{ fromJson .outputs.list_regions.regions }}", "list_regions", "regions"],
    ["{{ .outputs.list_regions.regions }}", "list_regions", "regions"],
    ["{{- fromJson .outputs.list-regions.regions -}}", "list-regions", "regions"],
    ["  {{fromJson .outputs.list_regions.regions}}\n", "list_regions", "regions"],
  ])("reads %j", (expression, blockId, outputName) => {
    expect(parseOptionsReference(expression)).toEqual({
      expression: expression.trim(),
      blockId,
      outputName,
    })
  })

  it.each([
    "eastus",
    "{{ .inputs.Regions }}",
    "{{ fromJson .outputs.list_regions }}",
    "{{ fromJson .outputs.a.regions }}{{ fromJson .outputs.b.regions }}",
    "regions: {{ fromJson .outputs.list_regions.regions }}",
    "{{ toJson .outputs.list_regions.regions }}",
  ])("rejects %j", (expression) => {
    expect(parseOptionsReference(expression)).toBeUndefined()
  })
})

describe("parseOutputOptions", () => {
  it("reads a JSON array of strings", () => {
    expect(parseOutputOptions(reference, '["eastus","westus"]')).toEqual({
      ok: true,
      items: [
        { value: "eastus", label: "eastus" },
        { value: "westus", label: "westus" },
      ],
    })
  })

  it("reads { value, label } objects, alone or mixed with strings", () => {
    expect(
      parseOutputOptions(
        reference,
        '[{"value":"eastus","label":"East US"},{"value":"westus"},"centralus"]',
      ),
    ).toEqual({
      ok: true,
      items: [
        { value: "eastus", label: "East US" },
        { value: "westus", label: "westus" },
        { value: "centralus", label: "centralus" },
      ],
    })
  })

  it("reads an empty array as no options", () => {
    expect(parseOutputOptions(reference, "[]")).toEqual({ ok: true, items: [] })
  })

  it("names the block and output when the output is missing", () => {
    expect(parseOutputOptions(reference, undefined)).toEqual({
      ok: false,
      error:
        'The options come from output "regions" of block "list_regions", which hasn\'t been produced.',
    })
  })

  it.each([
    ["eastus", "but it isn't valid JSON"],
    ['{"eastus": "East US"}', "but it is an object without a string value"],
    ['"eastus"', "but it is a string"],
    ["42", "but it is a number"],
    ["null", "but it is null"],
    ['["eastus", 1]', "but entry 2 is a number"],
    ['["eastus", ["westus"]]', "but entry 2 is an array"],
    ['[{"label": "East US"}]', "but entry 1 is an object without a string value"],
    ['[{"value": "eastus", "label": 1}]', "but entry 1 is an object without a string value"],
  ])("rejects %j", (output, reason) => {
    const result = parseOutputOptions(reference, output)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('output "regions" of block "list_regions"')
    expect(result.error).toContain(
      'which must be a JSON array of strings or { "value", "label" } objects',
    )
    expect(result.error).toContain(reason)
  })
})

describe("optionFields and optionItems", () => {
  it("keeps plain strings as values only", () => {
    const fields = optionFields([
      { value: "dev", label: "dev" },
      { value: "prod", label: "prod" },
    ])
    expect(fields).toEqual({ options: ["dev", "prod"] })
    expect(optionItems(fields)).toEqual([
      { value: "dev", label: "dev" },
      { value: "prod", label: "prod" },
    ])
  })

  it("keeps the labels by value when any differs", () => {
    const fields = optionFields([
      { value: "eastus", label: "East US" },
      { value: "westus", label: "westus" },
    ])
    expect(fields).toEqual({
      options: ["eastus", "westus"],
      optionLabels: { eastus: "East US", westus: "westus" },
    })
    expect(optionItems(fields)[0]).toEqual({ value: "eastus", label: "East US" })
  })
})

describe("optionMembershipError", () => {
  const enumVariable = {
    type: "enum",
    optionsFrom: reference,
    options: ["eastus", "westus"],
  }
  const listVariable = { ...enumVariable, type: "list" }

  it("accepts a value that is one of the options", () => {
    expect(optionMembershipError(enumVariable, "eastus")).toBeUndefined()
    expect(optionMembershipError(listVariable, ["eastus", "westus"])).toBeUndefined()
  })

  it("rejects a value that isn't", () => {
    expect(optionMembershipError(enumVariable, "northeurope")).toBe(
      '"northeurope" isn\'t one of the options.',
    )
    expect(optionMembershipError(listVariable, ["eastus", "northeurope"])).toBe(
      '"northeurope" isn\'t one of the options.',
    )
    expect(optionMembershipError(listVariable, ["a", "b"])).toBe(
      '"a", "b" aren\'t among the options.',
    )
  })

  it("leaves empty and linked values alone", () => {
    expect(optionMembershipError(enumVariable, "")).toBeUndefined()
    expect(optionMembershipError(enumVariable, undefined)).toBeUndefined()
    expect(optionMembershipError(enumVariable, "{{ .outputs.pick.region }}")).toBeUndefined()
  })

  it("checks only options that came from an output, once read", () => {
    expect(optionMembershipError({ type: "enum", options: ["dev"] }, "prod")).toBeUndefined()
    expect(optionMembershipError({ type: "enum", optionsFrom: reference }, "prod")).toBeUndefined()
  })
})
