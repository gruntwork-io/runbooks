/**
 * Tool versions, and the constraints a <Prerequisites> block checks them
 * against, which a runbook's front matter also requires versions of Runbooks
 * with (src/runbooks-version.ts). Shared by the main process, the renderer and
 * the test CLI, so it has no imports.
 *
 * A version is its numbers: 1.29.1 in "v1.29.1-eks-508b6b3". Anything after
 * them, such as a pre-release or build suffix, is ignored, so a vendor's
 * build of a release counts as that release. A missing number counts as 0:
 * 1.6 is 1.6.0.
 *
 * A constraint uses the syntax of OpenTofu's `required_version`: conditions
 * separated by commas, all of which must hold. Each is an operator and a
 * version:
 *
 *   = (or none)  exactly that version
 *   !=           any other version
 *   > >= < <=    a later or earlier version
 *   ~>           that version or a later one that changes only its last
 *                number: ~> 1.6 allows 1.10 but not 2.0, and ~> 1.6.2
 *                allows 1.6.9 but not 1.7.0
 */
/** A version's numbers, most significant first. */
export type Version = readonly number[]

/** Digits with at least one dot, the first of which is taken as a tool's version. */
const VERSION_IN_TEXT = /\d+(?:\.\d+)+/

/**
 * The version in a tool's `--version` output: its first number with a dot in
 * it, such as 1.8.2 in "OpenTofu v1.8.2". Null when there is none.
 */
export function extractVersion(output: string): string | null {
  return VERSION_IN_TEXT.exec(output)?.[0] ?? null
}

/** A version as written in a constraint: numbers separated by dots, optionally after a "v". */
const VERSION_TEXT = /^v?(\d+(?:\.\d+)*)$/

/** The numbers of a version such as "1.6", "v1.6.2" or "1.29.1", or null for anything else. */
export function parseVersion(text: string): Version | null {
  const match = VERSION_TEXT.exec(text.trim())
  if (!match) return null
  return match[1]!.split(".").map(Number)
}

/** Negative when `a` is earlier than `b`, positive when later, 0 when they are the same version. */
export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return Math.sign(diff)
  }
  return 0
}

type Operator = "=" | "!=" | ">" | ">=" | "<" | "<=" | "~>"

interface Condition {
  readonly operator: Operator
  readonly version: Version
}

/** A parsed version constraint. A version meets it when it meets every condition. */
export interface VersionConstraint {
  readonly conditions: readonly Condition[]
}

/** One condition: an optional operator, then the version. */
const CONDITION = /^(~>|>=|<=|!=|=|>|<)?\s*(\S+)$/

/**
 * Parse a constraint such as ">= 1.6, < 2" or "~> 0.67". On failure, `error`
 * quotes the part that couldn't be read.
 */
export function parseConstraint(
  text: string,
): { ok: true; constraint: VersionConstraint } | { ok: false; error: string } {
  const conditions: Condition[] = []
  for (const part of text.split(",")) {
    const condition = part.trim()
    const match = CONDITION.exec(condition)
    const version = match ? parseVersion(match[2]!) : null
    if (!match || !version) {
      return {
        ok: false,
        error:
          condition === ""
            ? `"${text}" has an empty condition`
            : `"${condition}" isn't a version condition such as ">= 1.6" or "~> 1.6"`,
      }
    }
    conditions.push({ operator: (match[1] as Operator | undefined) ?? "=", version })
  }
  return { ok: true, constraint: { conditions } }
}

/** Whether `version` meets every condition of `constraint`. */
export function satisfiesConstraint(version: Version, constraint: VersionConstraint): boolean {
  return constraint.conditions.every(({ operator, version: bound }) => {
    const order = compareVersions(version, bound)
    switch (operator) {
      case "=":
        return order === 0
      case "!=":
        return order !== 0
      case ">":
        return order > 0
      case ">=":
        return order >= 0
      case "<":
        return order < 0
      case "<=":
        return order <= 0
      case "~>":
        // Every number but the last must stay the same: ~> 1.6.2 keeps 1.6.
        return order >= 0 && bound.slice(0, -1).every((n, i) => (version[i] ?? 0) === n)
    }
  })
}
