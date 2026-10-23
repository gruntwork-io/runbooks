/**
 * Finding `{{ .inputs.X }}` and `{{ .outputs.B.K }}` in a script body.
 *
 * Runbooks still renders them into the script's source before it runs, but a
 * block's `env` prop passes the same values as data (see blockEnv.ts), so the
 * app and the test CLI point authors to it. Shared by both, so it's free of
 * Node and Effect.
 */
import { extractTemplateDependenciesFromString } from "../boilerplate/templateDependencies.ts"

/** How many references the warning names before it counts the rest. */
const MAX_NAMED = 4

/**
 * Why a script shouldn't reference inputs and outputs in its body, naming
 * the references, or null when it has none. Only references inside `{{ }}`
 * count, so `$VAR` and Go-template text meant for another tool, such as
 * `{{.Names}}`, don't.
 */
export function scriptTemplateWarning(script: string): string | null {
  const deps = extractTemplateDependenciesFromString(script)
  if (deps.length === 0) return null

  const refs = deps.map((dep) =>
    dep.type === "input" ? `{{ .inputs.${dep.name} }}` : `{{ .${dep.fullPath} }}`,
  )
  const named = refs.length > MAX_NAMED ? refs.slice(0, MAX_NAMED - 1) : refs
  const rest = refs.length - named.length
  const list =
    rest > 0
      ? `${named.join(", ")} and ${rest} more`
      : named.length === 1
        ? named[0]
        : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`

  let warning = `This script inserts ${list} into its source. Pass values in the block's env prop instead, so they reach the script as data.`
  if (deps.some((dep) => dep.type === "output")) {
    warning +=
      " An output can hold text from outside the runbook, which the shell would run as code."
  }
  return warning
}
