import { describe, it, expect } from "bun:test"
import { Effect } from "effect"
import { parseBoilerplateConfig } from "./config.ts"
import { validateVariableValue } from "./validators.ts"

describe("validateVariableValue", () => {
  const required = { name: "project_name", required: true, validations: [] }

  it("reports a missing required value using the variable name by default", () => {
    expect(validateVariableValue(required, undefined)).toBe("project_name is required")
    expect(validateVariableValue(required, null)).toBe("project_name is required")
    expect(validateVariableValue(required, "")).toBe("project_name is required")
  })

  it("uses the given label in the required message", () => {
    expect(validateVariableValue(required, "", "Project Name")).toBe("Project Name is required")
  })

  it("treats lists of only empty elements and maps with no keys as empty", () => {
    expect(validateVariableValue(required, [])).toBe("project_name is required")
    expect(validateVariableValue(required, ["", null])).toBe("project_name is required")
    expect(validateVariableValue(required, {})).toBe("project_name is required")
    expect(validateVariableValue(required, ["", "a"])).toBeUndefined()
    expect(validateVariableValue(required, { a: "" })).toBeUndefined()
  })

  // A tuple's bool element starts as false (what its select shows), so a tuple
  // whose other elements are blank has not been filled in. A tuple of only
  // bools holds a complete value from the start, so all-false is filled.
  it("treats a list whose only non-blank elements are false as empty", () => {
    expect(validateVariableValue(required, ["", false])).toBe("project_name is required")
    expect(validateVariableValue(required, ["", true])).toBeUndefined()
    expect(validateVariableValue(required, ["", 0])).toBeUndefined()
    expect(validateVariableValue(required, [false, false])).toBeUndefined()
  })

  it("does not treat false or 0 as empty", () => {
    expect(validateVariableValue(required, false)).toBeUndefined()
    expect(validateVariableValue(required, 0)).toBeUndefined()
  })

  it("checks required before the other rules", () => {
    const variable = { name: "email", required: true, validations: [{ type: "email" }] }
    expect(validateVariableValue(variable, "")).toBe("email is required")
    expect(validateVariableValue(variable, "nope")).toBe("Must be a valid email address")
  })

  it("skips the rules for an empty optional value", () => {
    const variable = { name: "email", validations: [{ type: "email" }] }
    expect(validateVariableValue(variable, "")).toBeUndefined()
    expect(validateVariableValue(variable, undefined)).toBeUndefined()
  })

  it("returns the first failing rule's message", () => {
    const variable = {
      name: "code",
      validations: [
        { type: "alpha", message: "letters only" },
        { type: "length", args: [1, 2], message: "too long" },
      ],
    }
    expect(validateVariableValue(variable, "123")).toBe("letters only")
    expect(validateVariableValue(variable, "abc")).toBe("too long")
    expect(validateVariableValue(variable, "ab")).toBeUndefined()
  })

  it("applies the rules to the value's string form", () => {
    const variable = {
      name: "port",
      validations: [{ type: "digit" }, { type: "length", args: [2, 4] }],
    }
    expect(validateVariableValue(variable, 8080)).toBeUndefined()
    expect(validateVariableValue(variable, 80800)).toBe("Must be 2 to 4 characters long")
  })

  it("says what length a length rule wants", () => {
    const check = (min: number, max: number, value: unknown) =>
      validateVariableValue(
        { name: "x", validations: [{ type: "length", args: [min, max] }] },
        value,
      )
    expect(check(1, 64, "a".repeat(65))).toBe("Must be 1 to 64 characters long")
    expect(check(1, 64, "a".repeat(64))).toBeUndefined()
    expect(check(3, 3, "ab")).toBe("Must be exactly 3 characters long")
    expect(check(0, 256, "a".repeat(257))).toBe("Must be at most 256 characters long")
    expect(check(1, 1, "ab")).toBe("Must be exactly 1 character long")
    // As in Boilerplate, a bound of 0 or less sets no limit
    expect(check(3, 0, "ab")).toBe("Must be at least 3 characters long")
    expect(check(3, 0, "a".repeat(1000))).toBeUndefined()
    expect(check(0, 0, "a".repeat(1000))).toBeUndefined()
  })

  it("counts length in UTF-8 bytes, as Boilerplate does", () => {
    const variable = { name: "x", validations: [{ type: "length", args: [1, 4] }] }
    expect(validateVariableValue(variable, "abcd")).toBeUndefined()
    expect(validateVariableValue(variable, "abcé")).toBe("Must be 1 to 4 characters long")
    expect(validateVariableValue(variable, "😀")).toBeUndefined()
  })

  it("counts a list's items and a map's entries for a length rule, as Boilerplate does", () => {
    const variable = { name: "x", validations: [{ type: "length", args: [1, 2] }] }
    expect(validateVariableValue(variable, ["a", "b"])).toBeUndefined()
    expect(validateVariableValue(variable, ["a", "b", "c"])).toBe("Must have 1 to 2 items")
    expect(validateVariableValue(variable, { a: 1, b: 2, c: 3 })).toBe("Must have 1 to 2 entries")
    expect(validateVariableValue(variable, [])).toBeUndefined()
  })

  it("checks a regex rule against strings only", () => {
    const variable = { name: "x", validations: [{ type: "regex", args: ["^[a-z]+$"] }] }
    expect(validateVariableValue(variable, "Abc")).toBe("Must match ^[a-z]+$")
    expect(validateVariableValue(variable, ["Abc"])).toBeUndefined()
    expect(validateVariableValue(variable, { Abc: "Abc" })).toBeUndefined()
  })

  it("prefers a rule's own message", () => {
    const variable = {
      name: "x",
      validations: [
        { type: "length", args: [3, 24], message: "3 to 24 characters, please" },
        { type: "regex", args: ["^[a-z0-9]+$"], message: "Lowercase letters and digits only" },
      ],
    }
    expect(validateVariableValue(variable, "ab")).toBe("3 to 24 characters, please")
    expect(validateVariableValue(variable, "abc-d")).toBe("Lowercase letters and digits only")
  })

  it("checks length(...) and regex(...) rules as parseBoilerplateConfig parses them", () => {
    const config = Effect.runSync(
      parseBoilerplateConfig(`
variables:
  - name: StorageAccount
    validations:
      - required
      - length(3, 24)
      - regex("^[a-z0-9]+$")
`),
    )
    const variable = config.variables[0]!
    expect(validateVariableValue(variable, "")).toBe("StorageAccount is required")
    expect(validateVariableValue(variable, "ab")).toBe("Must be 3 to 24 characters long")
    expect(validateVariableValue(variable, "My-Account")).toBe("Must match ^[a-z0-9]+$")
    expect(validateVariableValue(variable, "myaccount01")).toBeUndefined()
  })

  it("ignores custom rules", () => {
    expect(
      validateVariableValue({ name: "x", validations: [{ type: "custom" }] }, "anything"),
    ).toBeUndefined()
  })

  it("enforces the rules parseBoilerplateConfig produces", () => {
    const config = Effect.runSync(
      parseBoilerplateConfig(`
variables:
  - name: code
    validations:
      - type: required
        message: Code is required
      - type: regex
        regex: "^[A-Z]{3}$"
      - type: length
        min: 3
        max: 3
  - name: version
    validations:
      - semver
`),
    )
    expect(config.variables).toHaveLength(2)
    const code = config.variables[0]!
    const version = config.variables[1]!
    expect(validateVariableValue(code, "")).toBe("code is required")
    expect(validateVariableValue(code, "abc")).toBe("Must match ^[A-Z]{3}$")
    expect(validateVariableValue(code, "ABC")).toBeUndefined()
    expect(validateVariableValue(version, "1.2")).toBe(
      "Must be a valid semantic version (e.g., 1.2.3)",
    )
    expect(validateVariableValue(version, "v1.2.3")).toBeUndefined()
  })
})

describe("validateVariableValue with options from an output", () => {
  const optionsFrom = {
    expression: "{{ fromJson .outputs.list_regions.regions }}",
    blockId: "list_regions",
    outputName: "regions",
  }

  it("checks the value against the options once they're read", () => {
    const variable = { name: "Location", type: "enum", optionsFrom, options: ["eastus"] }
    expect(validateVariableValue(variable, "eastus")).toBeUndefined()
    expect(validateVariableValue(variable, "westus")).toBe('"westus" isn\'t one of the options.')
  })

  it("doesn't check them before", () => {
    expect(validateVariableValue({ name: "Location", type: "enum", optionsFrom }, "westus")).toBe(
      undefined,
    )
  })

  it("leaves a static list to its control, as before", () => {
    expect(
      validateVariableValue({ name: "env", type: "enum", options: ["dev"] }, "prod"),
    ).toBeUndefined()
  })
})
