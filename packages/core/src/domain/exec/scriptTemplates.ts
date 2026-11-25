/**
 * Finding `{{ .inputs.X }}` and `{{ .outputs.B.K }}` in a script body.
 *
 * Runbooks still renders them into the script's source before it runs, but a
 * block's `env` prop passes the same values as data (see blockEnv.ts), so the
 * app and the test CLI point authors to it. Shared by both, so it's free of
 * Node and Effect.
 */
import { templateReferences } from "../../document/templateReferences.ts"

/** How many references the warning names before it counts the rest. */
const MAX_NAMED = 4

/**
 * Why a script shouldn't reference inputs and outputs in its body, naming
 * the references, or null when it has none. Only references inside `{{ }}`
 * count, so `$VAR` and Go-template text meant for another tool, such as
 * `{{.Names}}`, don't.
 */
export function scriptTemplateWarning(script: string): string | null {
  const found = templateReferences(script)
  if (found.length === 0) return null

  const refs = [
    ...new Set(
      found.map((ref) =>
        ref._tag === "Input"
          ? `{{ .inputs.${ref.path} }}`
          : `{{ .outputs.${ref.block}.${ref.key} }}`,
      ),
    ),
  ]
  const named = refs.length > MAX_NAMED ? refs.slice(0, MAX_NAMED - 1) : refs
  const rest = refs.length - named.length
  const list =
    rest > 0
      ? `${named.join(", ")} and ${rest} more`
      : named.length === 1
        ? named[0]
        : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`

  let warning = `This script inserts ${list} into its source. Pass values in the block's env prop instead, so they reach the script as data.`
  if (found.some((ref) => ref._tag === "Output")) {
    warning +=
      " An output can hold text from outside the runbook, which the shell would run as code."
  }
  return warning
}
