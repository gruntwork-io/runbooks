/**
 * Boilerplate variable validation.
 *
 * Enforces the `validations:` rules that parseBoilerplateConfig produces. Both
 * the Inputs form (web/) and the `runbooks test` CLI use this module, so a value
 * the form rejects also fails a runbook test. The renderer bundles it directly,
 * so it must stay free of Node and Electron imports.
 */

import { compileGoRegex } from "./goRegex.ts"
import { optionMembershipError, type OptionFields } from "./options.ts"

/**
 * A validation rule in the shape parseBoilerplateConfig emits. Typed
 * structurally so the renderer's enum-typed ValidationRule fits as well.
 */
export interface ValidationRuleLike {
  type: string
  message?: string
  args?: readonly unknown[]
}

/** The parts of a boilerplate variable that validateVariableValue reads. */
export interface ValidatableVariable extends OptionFields {
  name: string
  type?: string
  required?: boolean
  validations?: readonly ValidationRuleLike[]
}

/**
 * Validates an email address
 * Uses a reasonable regex that catches most invalid emails without being overly strict
 */
export const isValidEmail = (value: string): boolean => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  return emailRegex.test(value)
}

/**
 * Validates a URL
 * Accepts http and https protocols
 */
export const isValidUrl = (value: string): boolean => {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

/**
 * Validates that a string contains only letters (a-z, A-Z)
 */
export const isAlpha = (value: string): boolean => {
  return /^[a-zA-Z]+$/.test(value)
}

/**
 * Validates that a string contains only digits (0-9)
 */
export const isDigit = (value: string): boolean => {
  return /^[0-9]+$/.test(value)
}

/**
 * Validates that a string contains only letters and numbers
 */
export const isAlphanumeric = (value: string): boolean => {
  return /^[a-zA-Z0-9]+$/.test(value)
}

/**
 * Validates a semantic version string (e.g., 1.2.3, v1.2.3, 1.0.0-alpha, 2.1.0+build)
 * Follows semver spec: https://semver.org/
 * Optionally allows a "v" prefix (common in git tags)
 */
export const isSemver = (value: string): boolean => {
  // Semver regex from https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string
  // Modified to allow optional "v" or "V" prefix
  const semverRegex =
    /^[vV]?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/
  return semverRegex.test(value)
}

/**
 * Whether a length is within a `length(min, max)` rule's bounds, as Boilerplate
 * checks them: a bound of 0 or less sets no limit.
 */
const isWithinLength = (length: number, min: number, max: number): boolean =>
  !(min > 0 && length < min) && !(max > 0 && length > max)

/**
 * A string's length as Boilerplate counts it for `length(min, max)`: in UTF-8
 * bytes, so `é` counts as 2.
 */
const byteLength = (value: string): number => new TextEncoder().encode(value).length

/**
 * Validates string length is within specified range, counted as Boilerplate counts it
 * @param value - The string to validate
 * @param min - Minimum length (inclusive; 0 or less for none)
 * @param max - Maximum length (inclusive; 0 or less for none)
 */
export const isValidLength = (value: string, min: number, max: number): boolean =>
  isWithinLength(byteLength(value), min, max)

/**
 * The message for a value outside a `length(min, max)` rule's bounds, such as
 * "Must be 1 to 64 characters long" or, for a list, "Must have 1 to 3 items".
 */
const lengthMessage = (min: number, max: number, unit: "character" | "item" | "entry"): string => {
  const count = (n: number) => `${n} ${n === 1 ? unit : unit === "entry" ? "entries" : `${unit}s`}`
  const bounds =
    min > 0 && max > 0
      ? min === max
        ? `exactly ${count(min)}`
        : `${min} to ${count(max)}`
      : max > 0
        ? `at most ${count(max)}`
        : `at least ${count(min)}`
  return unit === "character" ? `Must be ${bounds} long` : `Must have ${bounds}`
}

/** A `length` rule's bounds, or undefined if its args aren't two numbers or set no limit. */
const lengthBounds = (rule: ValidationRuleLike): { min: number; max: number } | undefined => {
  if (!rule.args || rule.args.length < 2) return undefined
  const min = Number(rule.args[0])
  const max = Number(rule.args[1])
  if (Number.isNaN(min) || Number.isNaN(max) || (min <= 0 && max <= 0)) return undefined
  return { min, max }
}

/**
 * Applies a `length` or `regex` rule to a list or map, as Boilerplate does:
 * `length` counts a list's items or a map's entries; a `regex` rule only
 * checks strings.
 */
const applyCollectionRule = (
  value: readonly unknown[] | object,
  rule: ValidationRuleLike,
): string | undefined => {
  const bounds = rule.type === "length" ? lengthBounds(rule) : undefined
  if (!bounds) return undefined
  const isList = Array.isArray(value)
  const size = isList ? value.length : Object.keys(value).length
  if (size === 0 || isWithinLength(size, bounds.min, bounds.max)) return undefined
  return rule.message || lengthMessage(bounds.min, bounds.max, isList ? "item" : "entry")
}

/**
 * Validates a two-letter country code (ISO 3166-1 alpha-2)
 * This is a simplified check - just validates format, not actual country codes
 */
export const isCountryCode2 = (value: string): boolean => {
  return /^[A-Z]{2}$/.test(value.toUpperCase())
}

/**
 * Applies a single validation rule to a value
 * @param value - The string value to validate
 * @param rule - The validation rule to apply
 * @returns Error message if validation fails, undefined if passes
 */
export const applyValidationRule = (
  value: string,
  rule: ValidationRuleLike,
): string | undefined => {
  // Skip validation for empty values (required check handles that separately)
  if (value === "" || value === undefined || value === null) {
    return undefined
  }

  const stringValue = String(value)

  switch (rule.type) {
    case "email":
      if (!isValidEmail(stringValue)) {
        return rule.message || "Must be a valid email address"
      }
      break

    case "url":
      if (!isValidUrl(stringValue)) {
        return rule.message || "Must be a valid URL"
      }
      break

    case "alpha":
      if (!isAlpha(stringValue)) {
        return rule.message || "Must contain only letters"
      }
      break

    case "digit":
      if (!isDigit(stringValue)) {
        return rule.message || "Must contain only numbers"
      }
      break

    case "alphanumeric":
      if (!isAlphanumeric(stringValue)) {
        return rule.message || "Must contain only letters and numbers"
      }
      break

    case "semver":
      if (!isSemver(stringValue)) {
        return rule.message || "Must be a valid semantic version (e.g., 1.2.3)"
      }
      break

    case "length": {
      const bounds = lengthBounds(rule)
      if (bounds && !isValidLength(stringValue, bounds.min, bounds.max)) {
        return rule.message || lengthMessage(bounds.min, bounds.max, "character")
      }
      break
    }

    case "countrycode2":
      if (!isCountryCode2(stringValue)) {
        return rule.message || "Must be a valid two-letter country code"
      }
      break

    case "regex":
      if (rule.args && rule.args.length >= 1) {
        const pattern = String(rule.args[0])
        // parseBoilerplateConfig rejects a pattern that doesn't compile, so one here is skipped
        const compiled = compileGoRegex(pattern)
        if ("regex" in compiled && !compiled.regex.test(stringValue)) {
          return rule.message || `Must match ${pattern}`
        }
      }
      break

    case "required":
      // Required is handled separately in validateVariableValue
      break

    case "custom":
      // Custom validations would need special handling
      // For now, we just skip them
      break
  }

  return undefined
}

/**
 * Validates a value against a variable's definition: the required check
 * first, then, for options that come from a block's output, that the value is
 * one of them, then each validation rule against the value's string form.
 * @param variable - The variable definition (required flag and rules)
 * @param value - The value to validate
 * @param label - How the required message names the variable (defaults to its name)
 * @returns The first error message, or undefined if the value is valid
 */
export const validateVariableValue = (
  variable: ValidatableVariable,
  value: unknown,
  label: string = variable.name,
): string | undefined => {
  // Required field validation (checked first)
  if (variable.required) {
    const isBlank = (v: unknown) => v === "" || v === undefined || v === null
    const isEmpty =
      isBlank(value) ||
      // For arrays (list/tuple), check if empty or all elements are empty. A
      // tuple's bool element starts as false (what its select shows), so false
      // next to blank elements doesn't fill it (['', false]). A tuple of only
      // bools ([false, false]) holds a complete value, and a scalar false is a value.
      (Array.isArray(value) &&
        (value.length === 0 ||
          (value.some(isBlank) && value.every((v) => isBlank(v) || v === false)))) ||
      // For objects (map), check if no keys
      (typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.keys(value).length === 0)
    if (isEmpty) {
      return `${label} is required`
    }
  }

  // Options that come from a block's output, once read (see optionMembershipError)
  const membershipError = optionMembershipError(variable, value)
  if (membershipError) return membershipError

  const stringValue = stringForm(value)
  const isCollection = typeof value === "object" && value !== null

  // Apply additional validation rules from the variable definition
  for (const rule of variable.validations ?? []) {
    const error =
      isCollection && (rule.type === "length" || rule.type === "regex")
        ? applyCollectionRule(value, rule)
        : applyValidationRule(stringValue, rule)
    if (error) {
      return error
    }
  }

  return undefined
}

/**
 * The string the validation rules check: empty for a missing value, a list
 * joined with commas (as `String()` joins it), a map as JSON rather than
 * "[object Object]".
 */
function stringForm(value: unknown): string {
  if (value === undefined || value === null) return ""
  if (Array.isArray(value)) return value.join(",")
  if (typeof value === "object") return JSON.stringify(value)
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value)
  }
  return ""
}
