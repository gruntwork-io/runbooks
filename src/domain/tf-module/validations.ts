/**
 * Reads a variable's validation blocks the way a form can use them.
 *
 * A form can check the idioms modules use most as the user types: a fixed set
 * of values, a regex, a length range, and not empty. Any other condition only
 * OpenTofu can evaluate, so the form shows its error message as a rule to
 * follow instead of guessing at it.
 */
import type { TfModuleCheck } from "./types.ts"

/** A validation block as a variable declares it. */
export interface TfValidation {
  /** The condition's source text, such as `contains(["a", "b"], var.x)`. */
  readonly condition: string
  readonly errorMessage: string
}

/** What a variable's validation blocks mean for a form. */
export interface InterpretedValidations {
  /** The values a `contains([...], var.name)` validation allows. */
  readonly allowedValues?: readonly string[]
  readonly checks: readonly TfModuleCheck[]
  readonly constraints: readonly string[]
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * The value of an HCL quoted string literal, such as `"^[a-z]\\d$"`. Its
 * escapes are JSON's. A literal with a template sequence in it isn't a
 * constant, so it has no value here.
 */
export function hclStringLiteral(literal: string): string | undefined {
  if (/(^|[^$])\$\{|(^|[^%])%\{/.test(literal)) return undefined
  try {
    const value: unknown = JSON.parse(literal.replaceAll("$${", "${").replaceAll("%%{", "%{"))
    return typeof value === "string" ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether a pattern OpenTofu accepts also compiles here. OpenTofu uses RE2,
 * whose syntax JavaScript mostly shares; a pattern that doesn't compile is
 * left for OpenTofu to check.
 */
function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern, "u")
    return true
  } catch {
    return false
  }
}

export function interpretValidations(
  name: string,
  validations: readonly TfValidation[],
): InterpretedValidations {
  const v = String.raw`var\.${escapeRegExp(name)}`
  const contains = new RegExp(String.raw`^contains\(\s*\[([^\]]*)\]\s*,\s*${v}\s*\)$`)
  const regex = new RegExp(String.raw`^can\(\s*regex\(\s*("(?:[^"\\]|\\.)*")\s*,\s*${v}\s*\)\s*\)$`)
  const length = new RegExp(
    String.raw`^length\(\s*${v}\s*\)\s*>=\s*(\d+)\s*&&\s*length\(\s*${v}\s*\)\s*<=\s*(\d+)$`,
  )
  const notEmpty = new RegExp(
    String.raw`^(?:${v}\s*!=\s*""|length\(\s*${v}\s*\)\s*>\s*0|trimspace\(\s*${v}\s*\)\s*!=\s*"")$`,
  )

  let allowedValues: string[] | undefined
  const checks: TfModuleCheck[] = []
  const constraints: string[] = []
  for (const { condition, errorMessage: message } of validations) {
    const cond = condition.trim()

    const containsMatch = contains.exec(cond)
    if (containsMatch) {
      const items = containsMatch[1]!
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
      const values = items.map(hclStringLiteral)
      if (values.length > 0 && values.every((value) => value !== undefined)) {
        allowedValues = values as string[]
        continue
      }
    }

    const regexMatch = regex.exec(cond)
    const pattern = regexMatch ? hclStringLiteral(regexMatch[1]!) : undefined
    if (pattern !== undefined && compiles(pattern)) {
      checks.push({ kind: "regex", pattern, message })
      continue
    }

    const lengthMatch = length.exec(cond)
    if (lengthMatch) {
      checks.push({
        kind: "length",
        min: Number(lengthMatch[1]),
        max: Number(lengthMatch[2]),
        message,
      })
      continue
    }

    if (notEmpty.test(cond)) {
      checks.push({ kind: "notEmpty", message })
      continue
    }

    if (message) constraints.push(message)
  }
  return { ...(allowedValues ? { allowedValues } : {}), checks, constraints }
}

/** The first check a value fails, as its message, or undefined when it passes them all. */
export function failedCheck(value: string, checks: readonly TfModuleCheck[]): string | undefined {
  for (const check of checks) {
    switch (check.kind) {
      case "regex":
        if (!new RegExp(check.pattern, "u").test(value)) return check.message
        break
      case "length":
        if (value.length < check.min || value.length > check.max) return check.message
        break
      case "notEmpty":
        if (value === "") return check.message
        break
    }
  }
  return undefined
}
