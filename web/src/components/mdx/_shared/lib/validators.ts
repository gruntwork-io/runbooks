import type { ValidationRule } from '@/types/boilerplateVariable'
import { BoilerplateValidationType } from '@/types/boilerplateVariable'

/**
 * Validation helper functions for boilerplate form fields.
 * These implement the validation rules defined in BoilerplateValidationType.
 */

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
    return url.protocol === 'http:' || url.protocol === 'https:'
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
export const applyValidationRule = (value: string, rule: ValidationRule): string | undefined => {
  // Skip validation for empty values (required check handles that separately)
  if (value === '' || value === undefined || value === null) {
    return undefined
  }

  const stringValue = String(value)

  switch (rule.type) {
    case BoilerplateValidationType.Email:
      if (!isValidEmail(stringValue)) {
        return rule.message || 'Must be a valid email address'
      }
      break

    case BoilerplateValidationType.URL:
      if (!isValidUrl(stringValue)) {
        return rule.message || 'Must be a valid URL'
      }
      break

    case BoilerplateValidationType.Alpha:
      if (!isAlpha(stringValue)) {
        return rule.message || 'Must contain only letters'
      }
      break

    case BoilerplateValidationType.Digit:
      if (!isDigit(stringValue)) {
        return rule.message || 'Must contain only numbers'
      }
      break

    case BoilerplateValidationType.Alphanumeric:
      if (!isAlphanumeric(stringValue)) {
        return rule.message || 'Must contain only letters and numbers'
      }
      break

    case BoilerplateValidationType.Semver:
      if (!isSemver(stringValue)) {
        return rule.message || 'Must be a valid semantic version (e.g., 1.2.3)'
      }
      break

    case BoilerplateValidationType.Length:
      if (rule.args && rule.args.length >= 2) {
        const min = Number(rule.args[0])
        const max = Number(rule.args[1])
        if (!isValidLength(stringValue, min, max)) {
          return rule.message || `Must be between ${min} and ${max} characters`
        }
      }
      break

    case BoilerplateValidationType.CountryCode2:
      if (!isCountryCode2(stringValue)) {
        return rule.message || 'Must be a valid two-letter country code'
      }
      break

    case BoilerplateValidationType.Required:
      // Required is handled separately in getFieldError
      break

    case BoilerplateValidationType.Custom:
      // Custom validations would need special handling
      // For now, we just skip them on the frontend
      break
  }

  return undefined
}

