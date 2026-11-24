/**
 * Boilerplate config parsing.
 *
 * Parses boilerplate.yml directly using the `yaml` npm package.
 */

import { Effect, Stream } from "effect"
import YAML from "yaml"

import { BoilerplateConfigError } from "../../errors/index.js"
import { errorMessage } from "../../errors/message.ts"
import { FileSystem } from "../../services/FileSystem.ts"
import { BATCH_IO_CONCURRENCY } from "../files/manifest.ts"
import { compileGoRegex } from "./goRegex.ts"
import { parseShowWhen } from "./showWhen.ts"
import { extractTemplateDependenciesFromString } from "./templateDependencies.ts"
import {
  optionFields,
  parseOptionsReference,
  staticOptionItems,
  type OptionFields,
} from "./options.ts"
import type {
  BoilerplateConfig,
  BoilerplateVariable,
  BoilerplateVarType,
  BoilerplateValidationType,
  ValidationRule,
  Section,
  OutputDependency,
  SkipFileRule,
} from "../../types.js"

// ---------------------------------------------------------------------------
// Internal raw YAML types
// ---------------------------------------------------------------------------

interface RawValidation {
  type?: string
  description?: string
  message?: string
  args?: unknown[]
  // ozzo-style shortcuts
  regex?: string
  min?: number
  max?: number
}

interface RawVariable {
  name: string
  description?: string
  type?: string
  default?: unknown
  // A list of options (strings or { value, label }), or an output reference that yields one
  options?: unknown
  sensitive?: boolean
  validations?: (RawValidation | string)[]
  // Boilerplate's own key for the order it prompts for variables in, lowest first
  order?: unknown
  // Runbooks x-extensions (ignored by Boilerplate itself)
  "x-schema"?: Record<string, string>
  "x-schema-instance-label"?: string
  "x-section"?: string
  // Enumerates the allowed values for a `list` variable so the form renders a multi-select picker. Boilerplate
  // forbids `options` on a non-enum type, so this rides the x-extension seam instead and the Go tool ignores it.
  // Like `options`, a list or an output reference.
  "x-options"?: unknown
  "x-locked"?: unknown
  "x-hidden"?: unknown
  "x-show-when"?: unknown
}

interface RawSkipFile {
  path?: unknown
  if?: unknown
}

interface RawSectionSettings {
  name?: unknown
  collapsed?: unknown
}

interface RawConfig {
  variables?: RawVariable[]
  skip_files?: unknown
  // Runbooks x-extension: settings for the sections variables name with x-section
  "x-sections"?: unknown
}

/** A yes/no setting: `true` or `false`. Anything else is ignored with a warning. */
function flag(value: unknown, where: string): boolean {
  if (value === undefined || value === false) return false
  if (value === true) return true
  console.warn(`[boilerplate config] ${where} must be true or false; ignoring.`)
  return false
}

// ---------------------------------------------------------------------------
// Validation mapping
// ---------------------------------------------------------------------------

const VALIDATION_TYPE_MAP: Record<string, BoilerplateValidationType> = {
  required: "required",
  url: "url",
  email: "email",
  alpha: "alpha",
  digit: "digit",
  alphanumeric: "alphanumeric",
  countrycode2: "countrycode2",
  semver: "semver",
  length: "length",
  regex: "regex",
}

function mapValidationType(raw: string): BoilerplateValidationType {
  const lower = raw.toLowerCase()
  return VALIDATION_TYPE_MAP[lower] ?? "custom"
}

/** A parsed `length(min, max)` or `regex("pattern")` rule. */
interface ParameterizedRule {
  type: "length" | "regex"
  args: unknown[]
}

const INTEGER = /^[+-]?\d+$/

/**
 * Parses a `length(min, max)` or `regex("pattern")` rule as Boilerplate does:
 * the rule is trimmed and its name is case-sensitive; `min` and `max` are
 * integers, with any spaces around them; the pattern is quoted with backticks
 * (taken as is) or double quotes, inside which only `\"` and `\\` are escapes,
 * so `\d` stays `\d`. Returns undefined for any other rule, and what's wrong
 * for a malformed one.
 */
function parseParameterizedRule(rule: string): ParameterizedRule | { problem: string } | undefined {
  const trimmed = rule.trim()
  const argsOf = (name: string) =>
    trimmed.endsWith(")") ? trimmed.slice(name.length + 1, -1) : undefined

  if (trimmed.startsWith("length(")) {
    const args = argsOf("length")
    const comma = args?.indexOf(",") ?? -1
    if (args === undefined || comma === -1) return { problem: "expected length(min, max)" }
    const min = args.slice(0, comma).trim()
    const max = args.slice(comma + 1).trim()
    if (!INTEGER.test(min)) return { problem: `min "${min}" isn't an integer` }
    if (!INTEGER.test(max)) return { problem: `max "${max}" isn't an integer` }
    if (Number(min) > Number(max)) return { problem: "min is more than max" }
    return { type: "length", args: [Number(min), Number(max)] }
  }

  if (trimmed.startsWith("regex(")) {
    const quoted = argsOf("regex")
    const pattern = quoted === undefined ? undefined : unquoteRegexPattern(quoted)
    if (pattern === undefined) {
      return { problem: 'the pattern must be quoted, as in regex("pattern") or regex(`pattern`)' }
    }
    if (typeof pattern !== "string") return pattern
    return { type: "regex", args: [pattern] }
  }

  return undefined
}

/** Boilerplate's unquoting of a `regex(...)` pattern (see parseParameterizedRule). */
function unquoteRegexPattern(quoted: string): string | { problem: string } | undefined {
  if (quoted.length < 2) return undefined
  const opener = quoted[0]
  const closer = quoted[quoted.length - 1]
  const raw = quoted.slice(1, -1)
  if (opener === "`" && closer === "`") return raw
  if (opener !== '"' || closer !== '"') return undefined

  let pattern = ""
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]!
    const next = raw[index + 1]
    if (char === "\\" && (next === '"' || next === "\\")) {
      pattern += next
      index++
    } else if (char === '"') {
      return {
        problem:
          'the pattern has an unescaped "; write \\" for a literal quote, or quote the pattern with backticks',
      }
    } else {
      pattern += char
    }
  }
  return pattern
}

/** Why a regex rule's pattern can't be checked, if it can't. */
function regexProblem(rule: { type: string; args: unknown[] }): string | undefined {
  const pattern = rule.args[0]
  if (rule.type !== "regex" || typeof pattern !== "string") return undefined
  const compiled = compileGoRegex(pattern)
  return "error" in compiled ? `can't check the pattern ${pattern}: ${compiled.error}` : undefined
}

function extractValidations(
  rawValidations: (RawValidation | string)[] | undefined,
  variableName: string,
): Effect.Effect<{ validations: ValidationRule[]; isRequired: boolean }, BoilerplateConfigError> {
  if (!rawValidations || rawValidations.length === 0) {
    return Effect.succeed({ validations: [], isRequired: false })
  }

  let isRequired = false
  const validations: ValidationRule[] = []

  for (const rv of rawValidations) {
    // Accept the YAML shorthand form (`- required`) alongside the long form
    // (`- type: required`). The upstream gruntwork-io/boilerplate library
    // supports both; the Go parser on main inherited that via delegation.
    const normalized: RawValidation = typeof rv === "string" ? { type: rv } : rv

    const typeName = normalized.type ?? ""
    const message = normalized.description ?? normalized.message ?? ""
    const invalid = (problem: string) =>
      Effect.fail(
        new BoilerplateConfigError({
          message: `variable "${variableName}": validation ${typeName.trim()}: ${problem}.`,
        }),
      )

    // `length(1, 64)` and `regex("^[a-z]+$")`, as a string or as the object form's type
    const parameterized = parseParameterizedRule(typeName)
    if (parameterized && "problem" in parameterized) return invalid(parameterized.problem)
    if (parameterized) {
      const problem = regexProblem(parameterized)
      if (problem) return invalid(problem)
      validations.push({ ...parameterized, message })
      continue
    }

    const mapped = mapValidationType(typeName)

    if (mapped === "required") {
      isRequired = true
    }

    const args: unknown[] = normalized.args ? [...normalized.args] : []

    // Pull structured args from shorthand fields when explicit args are absent
    if (args.length === 0) {
      if (normalized.regex !== undefined) args.push(normalized.regex)
      if (normalized.min !== undefined) args.push(normalized.min)
      if (normalized.max !== undefined) args.push(normalized.max)
    }

    const rule: ValidationRule = { type: mapped, message, args }
    const problem = regexProblem(rule)
    if (problem) return invalid(problem)
    validations.push(rule)
  }

  return Effect.succeed({ validations, isRequired })
}

// ---------------------------------------------------------------------------
// Variable type coercion
// ---------------------------------------------------------------------------

const VALID_VAR_TYPES = new Set<BoilerplateVarType>([
  "string",
  "int",
  "float",
  "bool",
  "list",
  "map",
  "enum",
])

function coerceVarType(raw: string | undefined): BoilerplateVarType {
  if (!raw) return "string"
  const lower = raw.toLowerCase() as BoilerplateVarType
  return VALID_VAR_TYPES.has(lower) ? lower : "string"
}

// ---------------------------------------------------------------------------
// Form order
// ---------------------------------------------------------------------------

/**
 * A variable's `order`, Boilerplate's key for the order it prompts for
 * variables in. A variable without one counts as 0, as it does in
 * Boilerplate. Boilerplate rejects an `order` that isn't an integer, so the
 * form ignores one too, and the render reports it.
 */
function variableOrder(rv: RawVariable): number {
  if (rv.order === undefined) return 0
  if (typeof rv.order === "number" && Number.isInteger(rv.order)) return rv.order
  console.warn(`[boilerplate config] variable "${rv.name}": order must be an integer; ignoring.`)
  return 0
}

/**
 * The variables in the order the form shows them: by `order`, lowest first.
 * The sort is stable, so variables with the same order (as every variable is
 * without one) keep the order the file declares them in.
 */
function inFormOrder(rawVars: RawVariable[]): RawVariable[] {
  return rawVars
    .map((rv) => ({ rv, order: variableOrder(rv) }))
    .sort((a, b) => a.order - b.order)
    .map(({ rv }) => rv)
}

// ---------------------------------------------------------------------------
// Section grouping
// ---------------------------------------------------------------------------

/**
 * Parse the top-level `x-sections:` list: settings for the sections that
 * variables name with `x-section`, as `{ name, collapsed? }` records. Like a
 * `skip_files` entry, a malformed one is dropped with a `console.warn`.
 */
function parseSectionSettings(raw: unknown): Map<string, { collapsed: boolean }> {
  const settings = new Map<string, { collapsed: boolean }>()
  if (raw === undefined || raw === null) return settings
  if (!Array.isArray(raw)) {
    console.warn(`[boilerplate config] x-sections must be a list, got ${typeof raw}; ignoring.`)
    return settings
  }

  for (let idx = 0; idx < raw.length; idx++) {
    const entry = raw[idx] as RawSectionSettings | null | undefined
    if (!entry || typeof entry !== "object" || typeof entry.name !== "string" || !entry.name) {
      console.warn(
        `[boilerplate config] x-sections[${idx}] missing or invalid "name"; dropping entry.`,
      )
      continue
    }
    settings.set(entry.name, {
      collapsed: flag(entry.collapsed, `x-sections[${idx}] "collapsed"`),
    })
  }
  return settings
}

/**
 * Group the variables, in form order, by `x-section`. The unnamed section
 * comes first: it has no heading, so after another section its fields would
 * read as part of that one. Each named section follows in the order of its
 * first variable, with its `x-sections` settings.
 */
function buildSections(
  rawVars: RawVariable[],
  settings: Map<string, { collapsed: boolean }>,
): Section[] {
  const sectionVars = new Map<string, string[]>()
  const sectionOrder: string[] = []
  const seen = new Set<string>()

  for (const v of rawVars) {
    const sectionName = v["x-section"] ?? ""
    if (!sectionVars.has(sectionName)) {
      sectionVars.set(sectionName, [])
    }
    sectionVars.get(sectionName)!.push(v.name)

    if (!seen.has(sectionName)) {
      seen.add(sectionName)
      sectionOrder.push(sectionName)
    }
  }

  // Ensure unnamed section ("") is always first if it exists
  if (seen.has("") && sectionOrder.length > 0 && sectionOrder[0] !== "") {
    const reordered = [""]
    for (const s of sectionOrder) {
      if (s !== "") reordered.push(s)
    }
    sectionOrder.length = 0
    sectionOrder.push(...reordered)
  }

  for (const name of settings.keys()) {
    if (!seen.has(name)) {
      console.warn(
        `[boilerplate config] x-sections names "${name}", but no variable has that x-section; ignoring.`,
      )
    }
  }

  return sectionOrder.map((name) => {
    const section: Section = { name, variables: sectionVars.get(name) ?? [] }
    if (settings.get(name)?.collapsed) section.collapsed = true
    return section
  })
}

// ---------------------------------------------------------------------------
// skip_files parsing
// ---------------------------------------------------------------------------

/**
 * Parse the top-level `skip_files:` block, if any. Each entry is a
 * `{ path, if? }` record; malformed entries are dropped with a
 * `console.warn` rather than throwing so a nonsense config keeps rendering
 * files instead of crashing the whole render.
 */
function parseSkipFiles(raw: unknown): SkipFileRule[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    console.warn(`[boilerplate config] skip_files must be a list, got ${typeof raw}; ignoring.`)
    return []
  }

  const out: SkipFileRule[] = []
  for (let idx = 0; idx < raw.length; idx++) {
    const entry = raw[idx] as RawSkipFile | null | undefined
    if (!entry || typeof entry !== "object") {
      console.warn(`[boilerplate config] skip_files[${idx}] is not an object; dropping entry.`)
      continue
    }
    const pathVal = entry.path
    if (typeof pathVal !== "string" || pathVal.length === 0) {
      console.warn(
        `[boilerplate config] skip_files[${idx}] missing or invalid "path"; dropping entry.`,
      )
      continue
    }
    const rule: SkipFileRule = { path: pathVal }
    if (entry.if !== undefined) {
      if (typeof entry.if !== "string") {
        console.warn(
          `[boilerplate config] skip_files[${idx}] "if" must be a string; ignoring condition.`,
        )
      } else {
        rule.if = entry.if
      }
    }
    out.push(rule)
  }
  return out
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * The option fields of an enum's `options` or a list's `x-options`: a list
 * of strings or `{ value, label }` (an invalid entry is dropped with a
 * warning), or an output reference such as
 * `{{ fromJson .outputs.list_regions.regions }}`, which the form and the test
 * runner read once the block has run. Any other string is a config error: it
 * can't be told from a typo in a reference.
 */
function parseOptions(
  raw: unknown,
  where: string,
  scalars: boolean,
): Effect.Effect<OptionFields, BoilerplateConfigError> {
  if (Array.isArray(raw)) {
    return Effect.succeed(optionFields(staticOptionItems(raw, where, scalars)))
  }
  if (typeof raw === "string") {
    const reference = parseOptionsReference(raw)
    if (reference) return Effect.succeed({ optionsFrom: reference })
  }
  return Effect.fail(
    new BoilerplateConfigError({
      message: `${where} must be a list, or a block output that holds one, such as "{{ fromJson .outputs.<block_id>.<output_name> }}".`,
    }),
  )
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

/**
 * Parse boilerplate.yml YAML content and return a structured
 * `BoilerplateConfig`.
 *
 * This is a pure function wrapped in Effect so callers get typed errors via
 * `BoilerplateConfigError`.
 */
export function parseBoilerplateConfig(
  yamlContent: string,
): Effect.Effect<BoilerplateConfig, BoilerplateConfigError> {
  return Effect.gen(function* () {
    const raw = yield* Effect.try({
      try: () => YAML.parse(yamlContent) as RawConfig,
      catch: (err) =>
        new BoilerplateConfigError({
          message: `Failed to parse boilerplate YAML: ${errorMessage(err)}`,
          cause: err,
        }),
    })

    if (!raw || !Array.isArray(raw.variables)) {
      return {
        variables: [],
        sections: [],
        outputDependencies: [],
        skipFiles: raw ? parseSkipFiles(raw.skip_files) : [],
      } satisfies BoilerplateConfig
    }

    const rawVars = inFormOrder(raw.variables.filter((rv) => rv.name))
    const variables: BoilerplateVariable[] = []

    for (const rv of rawVars) {
      const varType = coerceVarType(rv.type)
      const { validations, isRequired } = yield* extractValidations(rv.validations, rv.name)

      const variable: BoilerplateVariable = {
        name: rv.name,
        description: rv.description ?? "",
        type: varType,
        required: isRequired,
        validations,
        sensitive: rv.sensitive ?? false,
      }

      if (rv.default !== undefined) {
        variable.default = rv.default
      }

      // An enum's `options`, or a list's `x-options` (a list carrying x-options is the multi-select signal). The
      // membership guarantee for a list is UI-only: Boilerplate still treats the value as a plain list.
      if (varType === "enum" && rv.options != null) {
        Object.assign(
          variable,
          yield* parseOptions(rv.options, `variable "${rv.name}": options`, true),
        )
      }
      if (varType === "list" && rv["x-options"] != null) {
        const fields = yield* parseOptions(
          rv["x-options"],
          `variable "${rv.name}": x-options`,
          false,
        )
        // A static list without options stays a freeform list, as it always has.
        if (fields.optionsFrom || (fields.options?.length ?? 0) > 0) Object.assign(variable, fields)
      }

      const schema = rv["x-schema"]
      if (schema && Object.keys(schema).length > 0) {
        variable.schema = schema
      }

      const schemaLabel = rv["x-schema-instance-label"]
      if (schemaLabel) {
        variable.schemaInstanceLabel = schemaLabel
      }

      const section = rv["x-section"]
      if (section) {
        variable.sectionName = section
      }

      // A locked field's value comes from the runbook (its default, or what
      // the block imports through inputsId), not from the person filling in
      // the form. A hidden field is locked too.
      const hidden = flag(rv["x-hidden"], `variable "${rv.name}": x-hidden`)
      if (hidden || flag(rv["x-locked"], `variable "${rv.name}": x-locked`)) {
        variable.locked = true
      }
      if (hidden) {
        variable.hidden = true
      }

      const { showWhen, problem } = parseShowWhen(rv["x-show-when"])
      if (problem) {
        console.warn(`[boilerplate config] variable "${rv.name}": ${problem}; ignoring.`)
      } else if (showWhen) {
        variable.showWhen = showWhen
      }

      variables.push(variable)
    }

    const sections = buildSections(rawVars, parseSectionSettings(raw["x-sections"]))
    const skipFiles = parseSkipFiles(raw.skip_files)

    return {
      variables,
      sections,
      outputDependencies: [],
      skipFiles,
    } satisfies BoilerplateConfig
  })
}

// ---------------------------------------------------------------------------
// Output dependency extraction
// ---------------------------------------------------------------------------

/**
 * The `.outputs.blockId.outputName` references in template content: the
 * output dependencies extractTemplateDependenciesFromString finds.
 *
 * An output is optional when every reference to it sits behind a `hasKey`
 * guard (see scanGuardedCode): the block still has to run, but the Generate
 * gate no longer waits for that output to exist. A guard covers only the
 * content it's in, so pass each file separately: one unguarded reference in
 * any of them makes the output required.
 */
export function extractOutputDependencies(...contents: ReadonlyArray<string>): OutputDependency[] {
  return extractTemplateDependenciesFromString(...contents).flatMap((dep) =>
    dep.type === "output"
      ? [
          {
            blockId: dep.blockId,
            outputName: dep.outputName,
            fullPath: dep.fullPath,
            ...(dep.optional ? { optional: true } : {}),
          },
        ]
      : [],
  )
}

/**
 * Output dependencies of a template on disk: `boilerplateYaml` (variable
 * defaults often read outputs), every file under `templateDir` at any depth,
 * and the file and directory names, which boilerplate renders too.
 *
 * Best-effort: an unreadable file is skipped, and if the directory can't be
 * walked only `boilerplateYaml` is scanned, so the config still loads.
 */
export function extractTemplateOutputDependencies(templateDir: string, boilerplateYaml: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem

    const walked = yield* fs.walk(templateDir).pipe(Stream.runCollect, Effect.result)
    if (walked._tag === "Failure") {
      console.warn(
        `[boilerplate config] can't scan ${templateDir} for output references: ${errorMessage(walked.failure.cause)}`,
      )
      return extractOutputDependencies(boilerplateYaml)
    }

    const entries = walked.success
    // Not filtered with isFile: a symlink is neither, and reading follows it
    // like boilerplate does. A link to a directory fails to read and is skipped.
    const contents = yield* Effect.forEach(
      entries.filter((entry) => !entry.isDirectory),
      (entry) => fs.readFile(entry.path).pipe(Effect.orElseSucceed(() => "")),
      { concurrency: BATCH_IO_CONCURRENCY },
    )

    return extractOutputDependencies(
      boilerplateYaml,
      ...contents,
      ...entries.map((entry) => entry.relativePath),
    )
  })
}
