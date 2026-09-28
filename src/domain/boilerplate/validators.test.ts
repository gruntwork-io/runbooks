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
    const variable = { name: "port", validations: [{ type: "digit" }, { type: "length", args: [2, 4] }] }
    expect(validateVariableValue(variable, 8080)).toBeUndefined()
    expect(validateVariableValue(variable, 80800)).toBe("Must be between 2 and 4 characters")
  })

  it("ignores custom rules", () => {
    expect(validateVariableValue({ name: "x", validations: [{ type: "custom" }] }, "anything")).toBeUndefined()
  })

  it("enforces the rules parseBoilerplateConfig produces", () => {
    const config = Effect.runSync(parseBoilerplateConfig(`
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
`))
    const [code, version] = config.variables
    expect(validateVariableValue(code, "")).toBe("code is required")
    expect(validateVariableValue(code, "abc")).toBe("Must match pattern: ^[A-Z]{3}$")
    expect(validateVariableValue(code, "ABC")).toBeUndefined()
    expect(validateVariableValue(version, "1.2")).toBe("Must be a valid semantic version (e.g., 1.2.3)")
    expect(validateVariableValue(version, "v1.2.3")).toBeUndefined()
  })
})
