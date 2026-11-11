/**
 * The lookups an <Inputs> or <Template> block's boilerplate.yml declares with
 * x- keys: `x-lookups` and `x-include` beside `variables`, and `x-lookup`,
 * `x-prefill` and `x-shortcut` on a variable. They load and check the way a
 * module's runbook_block.yml does, so one engine runs both.
 */
import { Effect } from "effect"
import YAML from "yaml"
import { loadDeclarations } from "../lookups/load.ts"
import { parseInputLookups } from "../lookups/parse.ts"
import type { Definitions, InputLookups, Use } from "../lookups/types.ts"
import { checkDefinitions, usedGroups } from "../lookups/validate.ts"
import { rowTemplateError } from "../tf-module/rowTemplate.ts"

export interface FormLookups {
  /** Every lookup the form can use, from its own file and its includes. */
  readonly definitions: Definitions
  /** How each variable uses lookups, by its name. */
  readonly inputs: Readonly<Record<string, InputLookups>>
  /** The groups the form uses, which the block's `auth` prop binds to auth blocks. */
  readonly groups: readonly string[]
  /** What's wrong with the declarations, each fit to show in place of the block. */
  readonly problems: readonly string[]
}

type Obj = Record<string, unknown>
const isObj = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The variable types each use fits: what a suggestion, a fill or a shortcut can set. */
const FITS: Record<keyof InputLookups, readonly string[]> = {
  lookup: ["string", "list"],
  prefill: ["string"],
  shortcut: ["string", "list"],
}

/** A form's checks run before something acts on what it wrote, which no block does yet. */
const NOT_YET = ["x-checks", "x-preflight"] as const

/**
 * The lookups in `yamlContent`, which came from `file`; includes resolve
 * against it. `label` names the file in messages. Undefined when the file
 * declares none, so a form without lookups carries nothing extra.
 */
export const readFormLookups = (yamlContent: string, file: string, label: string) =>
  Effect.gen(function* () {
    let doc: unknown
    try {
      doc = YAML.parse(yamlContent)
    } catch {
      // The config's own parse reports a file that isn't YAML.
      return undefined
    }
    if (!isObj(doc)) return undefined
    const variables = (Array.isArray(doc.variables) ? doc.variables : []).filter(
      (raw): raw is Obj => isObj(raw) && typeof raw.name === "string" && raw.name !== "",
    )
    const declares =
      ["x-lookups", "x-include", ...NOT_YET].some((key) => doc[key] !== undefined) ||
      variables.some((raw) => Object.keys(FITS).some((key) => raw[`x-${key}`] !== undefined))
    if (!declares) return undefined

    const problems: string[] = []
    for (const key of NOT_YET) {
      if (doc[key] !== undefined) {
        problems.push(
          `${key} isn't supported in boilerplate.yml yet: an <Inputs> or <Template> block runs no checks.`,
        )
      }
    }

    const loaded = yield* loadDeclarations(doc, file, "x-")
    problems.push(...loaded.problems.map((problem) => problem.message))

    const inputs: Record<string, InputLookups> = {}
    const uses: { where: string; use: Use }[] = []
    for (const raw of variables) {
      const name = raw.name as string
      const where = `variables.${name}`
      const parsed = parseInputLookups(raw, where, file, "x-")
      problems.push(...parsed.problems.map((problem) => problem.message))
      const type = typeof raw.type === "string" ? raw.type : "string"
      for (const key of Object.keys(FITS) as (keyof InputLookups)[]) {
        const use = parsed.lookups[key]
        if (!use) continue
        if (!FITS[key].includes(type)) {
          problems.push(
            `${where}.x-${key} needs a ${FITS[key].join(" or ")} variable, and ${name} is ${type}.`,
          )
          continue
        }
        uses.push({ where: `${where}.x-${key}`, use })
      }
      const shortcutLabel = parsed.lookups.shortcut?.label
      const labelError = shortcutLabel ? rowTemplateError(shortcutLabel) : undefined
      if (labelError) problems.push(`${where}.x-shortcut.label: ${labelError}`)
      const { lookup, prefill, shortcut } = parsed.lookups
      if (lookup || prefill || shortcut) {
        inputs[name] = {
          ...(lookup ? { lookup } : {}),
          ...(prefill ? { prefill } : {}),
          ...(shortcut ? { shortcut } : {}),
        }
      }
    }

    problems.push(
      ...checkDefinitions(loaded.definitions, {
        lookups: uses,
        preflight: [],
        inputs: variables.map((raw) => raw.name as string),
        source: file,
      }).map((problem) => problem.message),
    )

    return {
      definitions: loaded.definitions,
      inputs,
      groups: usedGroups(
        loaded.definitions,
        uses.map(({ use }) => use),
        [],
      ),
      problems: problems.map((problem) => `${label}: ${problem}`),
    } satisfies FormLookups
  })
