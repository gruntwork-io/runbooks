import { describe, it, expect } from "bun:test"
import { failedCheck, hclStringLiteral, interpretValidations } from "./validations.ts"

describe("hclStringLiteral", () => {
  it("decodes HCL's escapes", () => {
    expect(hclStringLiteral(String.raw`"^[a-z]\\d$"`)).toBe(String.raw`^[a-z]\d$`)
  })
  it("has no value for a template", () => {
    expect(hclStringLiteral('"${var.x}-y"')).toBeUndefined()
    expect(hclStringLiteral('"$${literal}"')).toBe("${literal}")
  })
})

describe("interpretValidations", () => {
  it("only reads conditions about the variable itself", () => {
    const result = interpretValidations("tier", [
      { condition: 'contains(["a", "b"], var.other)', errorMessage: "Other." },
    ])
    expect(result.allowedValues).toBeUndefined()
    expect(result.constraints).toEqual(["Other."])
  })

  it("leaves a pattern JavaScript can't compile to OpenTofu", () => {
    const result = interpretValidations("x", [
      { condition: 'can(regex("(?P<name>a)", var.x))', errorMessage: "Bad." },
    ])
    expect(result.checks).toEqual([])
    expect(result.constraints).toEqual(["Bad."])
  })

  it("reads a contains() whose values aren't all literals as a rule", () => {
    const result = interpretValidations("x", [
      { condition: "contains(local.allowed, var.x)", errorMessage: "Pick one." },
    ])
    expect(result.allowedValues).toBeUndefined()
    expect(result.constraints).toEqual(["Pick one."])
  })
})

describe("failedCheck", () => {
  const checks = [
    { kind: "notEmpty" as const, message: "Required." },
    { kind: "length" as const, min: 3, max: 5, message: "3 to 5." },
    { kind: "regex" as const, pattern: "^[a-z]+$", message: "Letters." },
  ]
  it("gives the first check a value fails", () => {
    expect(failedCheck("", checks)).toBe("Required.")
    expect(failedCheck("ab", checks)).toBe("3 to 5.")
    expect(failedCheck("ab1", checks)).toBe("Letters.")
    expect(failedCheck("abc", checks)).toBeUndefined()
  })
})
