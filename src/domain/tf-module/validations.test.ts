import { describe, it, expect } from "bun:test"
import { failedCheck, failedCount, hclStringLiteral, interpretValidations } from "./validations.ts"

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
  it("reads length() on a list or map as a count of its items", () => {
    const validations = [
      {
        condition: "length(var.owners) >= 1 && length(var.owners) <= 5",
        errorMessage: "One to five owners.",
      },
      { condition: "length(var.owners) > 0", errorMessage: "At least one." },
      {
        condition: 'alltrue([for o in var.owners : can(regex("@", o))])',
        errorMessage: "Emails.",
      },
    ]
    for (const kind of ["list", "map"] as const) {
      const result = interpretValidations("owners", validations, kind)
      expect(result.checks).toEqual([
        { kind: "count", min: 1, max: 5, message: "One to five owners." },
        { kind: "count", min: 1, message: "At least one." },
      ])
      expect(result.constraints).toEqual(["Emails."])
    }
    expect(interpretValidations("owners", validations, "string").checks).toEqual([
      { kind: "length", min: 1, max: 5, message: "One to five owners." },
      { kind: "notEmpty", message: "At least one." },
    ])
  })

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

describe("failedCount", () => {
  it("gives the first count check a collection's size fails", () => {
    const checks = [
      { kind: "count" as const, min: 1, message: "At least one." },
      { kind: "count" as const, min: 1, max: 2, message: "One or two." },
    ]
    expect(failedCount(0, checks)).toBe("At least one.")
    expect(failedCount(3, checks)).toBe("One or two.")
    expect(failedCount(2, checks)).toBeUndefined()
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
