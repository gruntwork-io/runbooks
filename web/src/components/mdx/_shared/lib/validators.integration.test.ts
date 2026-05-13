import { describe, it, expect } from "vitest"
import { applyValidationRule } from "./validators"
import { BoilerplateValidationType } from "@/types/boilerplateVariable"

describe("applyValidationRule", () => {
  // --- Skipping empty values ---

  it("skips validation for empty string", () => {
    expect(applyValidationRule("", { type: BoilerplateValidationType.Email })).toBeUndefined()
  })

  // --- Email ---

  it("passes valid email", () => {
    expect(applyValidationRule("user@example.com", { type: BoilerplateValidationType.Email })).toBeUndefined()
  })

  it("fails invalid email", () => {
    expect(applyValidationRule("not-an-email", { type: BoilerplateValidationType.Email })).toBeDefined()
  })

  // --- URL ---

  it("passes valid URL", () => {
    expect(applyValidationRule("https://example.com", { type: BoilerplateValidationType.URL })).toBeUndefined()
  })

  it("fails invalid URL", () => {
    expect(applyValidationRule("not a url", { type: BoilerplateValidationType.URL })).toBeDefined()
  })

  // --- Alpha ---

  it("passes alphabetic string", () => {
    expect(applyValidationRule("abcDEF", { type: BoilerplateValidationType.Alpha })).toBeUndefined()
  })

  it("fails string with digits", () => {
    expect(applyValidationRule("abc123", { type: BoilerplateValidationType.Alpha })).toBeDefined()
  })

  // --- Digit ---

  it("passes digit-only string", () => {
    expect(applyValidationRule("12345", { type: BoilerplateValidationType.Digit })).toBeUndefined()
  })

  it("fails string with letters", () => {
    expect(applyValidationRule("123abc", { type: BoilerplateValidationType.Digit })).toBeDefined()
  })

  // --- Alphanumeric ---

  it("passes alphanumeric string", () => {
    expect(applyValidationRule("abc123", { type: BoilerplateValidationType.Alphanumeric })).toBeUndefined()
  })

  it("fails string with special chars", () => {
    expect(applyValidationRule("abc@123", { type: BoilerplateValidationType.Alphanumeric })).toBeDefined()
  })

  // --- Semver ---

  it("passes valid semver", () => {
    expect(applyValidationRule("1.2.3", { type: BoilerplateValidationType.Semver })).toBeUndefined()
  })

  it("fails invalid semver", () => {
    expect(applyValidationRule("1.2", { type: BoilerplateValidationType.Semver })).toBeDefined()
  })

  // --- Length ---

  it("passes within length bounds", () => {
    expect(applyValidationRule("hello", { type: BoilerplateValidationType.Length, args: ["2", "10"] })).toBeUndefined()
  })

  it("fails below min length", () => {
    expect(applyValidationRule("a", { type: BoilerplateValidationType.Length, args: ["2", "10"] })).toBeDefined()
  })

  it("fails above max length", () => {
    expect(applyValidationRule("a".repeat(20), { type: BoilerplateValidationType.Length, args: ["2", "10"] })).toBeDefined()
  })

  it("skips length validation without args", () => {
    expect(applyValidationRule("anything", { type: BoilerplateValidationType.Length })).toBeUndefined()
  })

  // --- Regex ---

  it("passes matching regex", () => {
    expect(applyValidationRule("ABC", { type: BoilerplateValidationType.Regex, args: ["^[A-Z]{3}$"] })).toBeUndefined()
  })

  it("fails non-matching regex", () => {
    expect(applyValidationRule("abc", { type: BoilerplateValidationType.Regex, args: ["^[A-Z]{3}$"] })).toBeDefined()
  })

  it("skips invalid regex pattern without crashing", () => {
    expect(applyValidationRule("test", { type: BoilerplateValidationType.Regex, args: ["[invalid"] })).toBeUndefined()
  })

  // --- Required ---

  it("skips required (handled separately)", () => {
    expect(applyValidationRule("anything", { type: BoilerplateValidationType.Required })).toBeUndefined()
  })

  // --- Custom message ---

  it("uses custom error message when provided", () => {
    const result = applyValidationRule("bad", { type: BoilerplateValidationType.Email, message: "Please enter a valid email" })
    expect(result).toBe("Please enter a valid email")
  })
})
