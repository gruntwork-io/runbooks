/**
 * Boilerplate variable validation.
 *
 * Enforces the `validations:` rules that parseBoilerplateConfig produces. Both
 * the Inputs form (web/) and the `runbooks test` CLI use this module, so a value
 * the form rejects also fails a runbook test. The renderer bundles it directly,
 * so it must stay free of Node and Electron imports.
 */

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
export interface ValidatableVariable {
  name: string
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
  const semverRegex = /^[vV]?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/
  return semverRegex.test(value)
}

/**
 * Validates string length is within specified range
 * @param value - The string to validate
 * @param min - Minimum length (inclusive)
 * @param max - Maximum length (inclusive)
 */
export const isValidLength = (value: string, min: number, max: number): boolean => {
  return value.length >= min && value.length <= max
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
export const applyValidationRule = (value: string, rule: ValidationRuleLike): string | undefined => {
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

    case "length":
      if (rule.args && rule.args.length >= 2) {
        const min = Number(rule.args[0])
        const max = Number(rule.args[1])
        if (!isValidLength(stringValue, min, max)) {
          return rule.message || `Must be between ${min} and ${max} characters`
        }
      }
      break

    case "countrycode2":
      if (!isCountryCode2(stringValue)) {
        return rule.message || "Must be a valid two-letter country code"
      }
      break

    case "regex":
      if (rule.args && rule.args.length >= 1) {
        const pattern = String(rule.args[0])
        try {
          const regex = new RegExp(pattern)
          if (!regex.test(stringValue)) {
            return rule.message || `Must match pattern: ${pattern}`
          }
        } catch {
          // Invalid regex pattern — skip validation
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
 * first, then each validation rule against the value's string form.
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
    const isEmpty = value === undefined || value === null || value === ""
      // For arrays (list/tuple), check if empty or all elements are empty
      || (Array.isArray(value) && value.every(v => v === "" || v === undefined || v === null))
      // For objects (map), check if no keys
      || (typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0)
    if (isEmpty) {
      return `${label} is required`
    }
  }

  const stringValue = value === undefined || value === null ? "" : String(value)

  // Apply additional validation rules from the variable definition
  for (const rule of variable.validations ?? []) {
    const error = applyValidationRule(stringValue, rule)
    if (error) {
      return error
    }
  }

  return undefined
}
