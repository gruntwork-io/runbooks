/**
 * Whether this version of Runbooks can use a runbook. The renderer and the
 * test CLI both check, with these messages, so they refuse the same runbooks
 * and say the same thing about them:
 * - a runbook whose front matter requires other versions of Runbooks, as in
 *   `runbooks: ">= 0.28"`, in the syntax of a <Prerequisites> tool's version;
 * - a runbook with a block this version doesn't have, which may be a block a
 *   later version added.
 *
 * The renderer imports this module too, so it must not import Node.js modules.
 */
import YAML from "yaml"
import { version as packageVersion } from "../package.json" with { type: "json" }
import {
  compareVersions,
  extractVersion,
  parseConstraint,
  parseVersion,
  satisfiesConstraint,
} from "./domain/prerequisites/version.ts"
import { errorMessage } from "./errors/message.ts"
import { frontMatter } from "./mdx.ts"

/** This version of Runbooks. The test CLI ships with the app, so it's the app's too. */
export const RUNBOOKS_VERSION: string = packageVersion

/** The front matter key that names the versions of Runbooks a runbook needs. */
const REQUIREMENT_KEY = "runbooks"

/** The operators of a condition that sets a minimum version, which `~>` and `=` do too. */
const MINIMUMS: ReadonlySet<string> = new Set(["=", ">", ">=", "~>"])

/**
 * Why `version` of Runbooks can't use the runbook whose source is `content`:
 * its front matter requires other versions, or has a requirement or YAML that
 * can't be read. Null for a runbook without a requirement, or one `version`
 * meets.
 */
export function versionRequirementError(
  content: string,
  version: string = RUNBOOKS_VERSION,
): string | null {
  const yaml = frontMatter(content)
  if (yaml === null) return null

  let fields: unknown
  try {
    fields = YAML.parse(yaml)
  } catch (err) {
    return `The runbook's front matter isn't valid YAML: ${errorMessage(err)}`
  }
  if (typeof fields !== "object" || fields === null || !(REQUIREMENT_KEY in fields)) return null

  const requirement: unknown = (fields as Record<string, unknown>)[REQUIREMENT_KEY]
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
  const current = parseVersion(extractVersion(version) ?? "")
  if (!current || satisfiesConstraint(current, parsed.constraint)) return null

  const needed = `This runbook needs Runbooks ${requirement.trim()}, and this is Runbooks ${version}.`
  // A later version can meet a minimum this one is short of, but not a maximum.
  const tooOld = parsed.constraint.conditions.some(
    (condition) =>
      MINIMUMS.has(condition.operator) &&
      compareVersions(current, condition.version) <= 0 &&
      !satisfiesConstraint(current, { conditions: [condition] }),
  )
  return tooOld ? `${needed} Update Runbooks to use it.` : needed
}

/**
 * The names of the blocks in `names`, a runbook's JSX elements, that aren't
 * in `known`, each once, in the order they come in. As in JSX, a lowercase
 * name is an HTML element, unless it has a dot, as in <ui.Tabs>.
 */
export function unknownBlocks(names: Iterable<string>, known: ReadonlySet<string>): string[] {
  const unknown = new Set<string>()
  for (const name of names) {
    if ((/^[A-Z]/.test(name) || name.includes(".")) && !known.has(name)) unknown.add(name)
  }
  return [...unknown]
}

/**
 * Why `version` of Runbooks can't use a runbook with the blocks `names`,
 * which it doesn't have: a later version may have added them, or they may be
 * typos.
 */
export function unknownBlocksError(
  names: readonly string[],
  version: string = RUNBOOKS_VERSION,
): string {
  const tags = names.map((name) => `<${name}>`)
  const list = tags.length > 1 ? `${tags.slice(0, -1).join(", ")} and ${tags.at(-1)}` : tags[0]
  return tags.length > 1
    ? `This runbook uses ${list}, blocks that Runbooks ${version} doesn't have. If a later version of Runbooks added them, update Runbooks to use this runbook. Otherwise, check their names.`
    : `This runbook uses ${list}, a block that Runbooks ${version} doesn't have. If a later version of Runbooks added it, update Runbooks to use this runbook. Otherwise, check its name.`
}
