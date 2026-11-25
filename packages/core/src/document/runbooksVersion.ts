/**
 * Whether this version of Runbooks can use a runbook whose front matter
 * names the versions it needs, as in `runbooks: ">= 0.28"`, in the syntax of
 * a <Prerequisites> tool's version. Ported from src/runbooks-version.ts.
 */
import {
  compareVersions,
  extractVersion,
  parseConstraint,
  parseVersion,
  satisfiesConstraint,
} from "../domain/prerequisites/version.ts"

/** The front matter key that names the versions of Runbooks a runbook needs. */
export const REQUIREMENT_KEY = "runbooks"

/** The operators of a condition that sets a minimum version, which `~>` and `=` do too. */
const MINIMUMS: ReadonlySet<string> = new Set(["=", ">", ">=", "~>"])

/**
 * Why Runbooks `appVersion` cannot use a runbook whose front matter's
 * `runbooks:` is `requirement`: it requires other versions, or cannot be
 * read. Undefined when `appVersion` meets it.
 */
export function versionProblem(requirement: unknown, appVersion: string): string | undefined {
  if (typeof requirement === "number") {
    return `Quote the version of Runbooks in the front matter, as in ${REQUIREMENT_KEY}: ">= 0.28". YAML reads an unquoted 0.30 as the number 0.3.`
  }
  if (typeof requirement !== "string") {
    return `\`${REQUIREMENT_KEY}\` in the front matter must be text, such as ${REQUIREMENT_KEY}: ">= 0.28".`
  }
  const parsed = parseConstraint(requirement)
  if (!parsed.ok) {
    return `\`${REQUIREMENT_KEY}\` in the front matter isn't a version of Runbooks: ${parsed.error}.`
  }

  // A version that isn't numbers, which no release has, meets any requirement.
  const current = parseVersion(extractVersion(appVersion) ?? "")
  if (!current || satisfiesConstraint(current, parsed.constraint)) return undefined

  const needed = `This runbook needs Runbooks ${requirement.trim()}, and this is Runbooks ${appVersion}.`
  // A later version can meet a minimum this one is short of, but not a maximum.
  const tooOld = parsed.constraint.conditions.some(
    (condition) =>
      MINIMUMS.has(condition.operator) &&
      compareVersions(current, condition.version) <= 0 &&
      !satisfiesConstraint(current, { conditions: [condition] }),
  )
  return tooOld ? `${needed} Update Runbooks to use it.` : needed
}
