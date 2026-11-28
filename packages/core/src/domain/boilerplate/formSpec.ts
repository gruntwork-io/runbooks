/**
 * The form a boilerplate config gives: the variables of a `boilerplate.yml`
 * as a `FormSpec`, read from the data its YAML holds. A form block reads its
 * fields through it, from a file its `path` names or from the YAML inside
 * it, and a Template's variables will be read through it too.
 *
 * Each setting is read here, once. Each way a setting can be malformed is a
 * problem at the path of what is wrong in the data, so that whoever holds
 * the YAML can give the line, and each problem names the field it is on. A
 * problem is a configuration error, and the form is not made: today's app
 * warned about some of these and ignored the setting, and passed others
 * through (the human's ruling of 2026-11-27, H2, made the rule for every
 * setting).
 *
 * What the docs say the form takes leniently, it still takes: a missing or
 * unknown type, in any case, is `string`, and an unknown validation is
 * `custom`, never checked. A config with no `variables` is a form with no
 * fields, as a template's may be.
 */
import { Result, Schema } from "effect"
import type { RunbookTexts } from "@runbooks/blocks-core/contract"
import {
  type Field,
  FieldType,
  FieldValue,
  type FormSpec,
  MAX_VALUE_DEPTH,
  type Validation,
  ValidationKind,
} from "@runbooks/blocks-core/form"
import { nearest } from "../../document/nearest.ts"
import { nodeAt, parseYaml, yamlData } from "../../document/yamlData.ts"
import { optionFields, optionItemsOf, parseOptionsReference } from "./options.ts"
import { parseShowWhen, showWhenProblems } from "./showWhen.ts"

/** What is wrong in a boilerplate config, and where in its data. */
export interface ConfigProblem {
  /** The path in the config's data of what is wrong: `["variables", 2, "order"]`. */
  readonly path: ReadonlyArray<PropertyKey>
  /** A clause, lowercase, with no closing period. */
  readonly message: string
}

/** A config's form, and each problem in it. With a problem, the form is not one to make. */
export interface ConfigRead {
  readonly spec: FormSpec
  readonly problems: ReadonlyArray<ConfigProblem>
}

type Path = ReadonlyArray<PropertyKey>
type Raw = { readonly [key: string]: unknown }

const isMap = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isAbsent = (value: unknown): value is null | undefined =>
  value === undefined || value === null

const FIELD_TYPES: ReadonlySet<string> = new Set(FieldType.literals)
const VALIDATION_KINDS: ReadonlySet<string> = new Set(ValidationKind.literals)
const decodeValue = Schema.decodeUnknownResult(FieldValue)

/** Notes a problem at a path. */
type Report = (path: Path, message: string) => void

/** A type as boilerplate spells it, in any case. Missing or unknown, it is text, as the docs say. */
function typeOf(raw: unknown): FieldType {
  const lower = typeof raw === "string" ? raw.toLowerCase() : ""
  return FIELD_TYPES.has(lower) ? (lower as FieldType) : "string"
}

/** A setting that is text: a number or true/false is taken as its text; a list or map is a problem. */
function textOf(raw: unknown, at: Path, what: string, report: Report): string | undefined {
  if (isAbsent(raw)) return undefined
  if (typeof raw === "string") return raw
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw)
  report(at, `${what} must be text`)
  return undefined
}

/** A yes/no setting: absent is no; anything but true or false is a problem. */
function flagOf(raw: unknown, at: Path, what: string, report: Report): boolean {
  if (isAbsent(raw) || raw === false) return false
  if (raw === true) return true
  report(at, `${what} must be true or false`)
  return false
}

/** A field's name: text, a number or true/false taken as its text. None for an empty one, or a list or map. */
function nameOf(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw === "" ? undefined : raw
  return typeof raw === "number" || typeof raw === "boolean" ? String(raw) : undefined
}

/**
 * The form a boilerplate config's data gives, and each problem in it. The
 * fields are in the form's order: by `order`, lowest first, the fields of
 * one order in the config's order. The sections are in the order of their
 * first field, each folded as `x-sections` says.
 */
export function readBoilerplateForm(data: unknown): ConfigRead {
  const problems: ConfigProblem[] = []
  const report: Report = (at, message) => problems.push({ path: at, message })
  if (!isAbsent(data) && !isMap(data))
    report([], "a boilerplate config must be a map of its settings, such as `variables`")
  const listed = isMap(data) ? data["variables"] : undefined
  if (!isAbsent(listed) && !Array.isArray(listed))
    report(["variables"], "`variables` must be a list of variables, each with a `name`")
  const variables: ReadonlyArray<unknown> = Array.isArray(listed) ? listed : []
  const read: Array<{ readonly field: Field; readonly order: number }> = []
  const indexOf = new Map<string, number>()
  variables.forEach((raw, index) => {
    const name = isMap(raw) ? nameOf(raw["name"]) : undefined
    if (!isMap(raw) || name === undefined) {
      report(["variables", index], "each variable in `variables` needs a `name`, its text")
      return
    }
    if (indexOf.has(name))
      report(
        ["variables", index, "name"],
        `two fields are named "${name}": each field needs a name of its own`,
      )
    else indexOf.set(name, index)
    read.push(fieldOf(raw, name, ["variables", index], report))
  })
  // A stable sort: the fields of one order keep the config's order.
  const fields = [...read].sort((a, b) => a.order - b.order).map(({ field }) => field)
  for (const { variable, condition, message } of showWhenProblems(fields))
    report(
      [
        "variables",
        indexOf.get(variable) ?? 0,
        "x-show-when",
        ...(condition === undefined ? [] : [condition]),
      ],
      message,
    )
  const folded = foldedOf(isMap(data) ? data["x-sections"] : undefined, fields, report)
  const sections = [...new Set(fields.flatMap((field) => field.section ?? []))].map((name) => ({
    name,
    collapsed: folded.get(name) ?? false,
  }))
  return { spec: { fields, sections }, problems }
}

/**
 * One variable's field, and its `order`. Its settings are read in the order
 * below, so its problems are in that order too.
 */
function fieldOf(
  raw: Raw,
  name: string,
  at: Path,
  report: Report,
): { readonly field: Field; readonly order: number } {
  const of = (key: string) => [...at, key]
  const text = (key: string) =>
    textOf(raw[key], of(key), `the \`${key}\` of the field "${name}"`, report)
  const flag = (key: string) =>
    flagOf(raw[key], of(key), `\`${key}\` on the field "${name}"`, report)
  const type = typeOf(raw["type"])
  const order = orderOf(raw["order"], of("order"), name, report)
  const description = text("description")
  const value = defaultOf(raw["default"], of("default"), name, report)
  // An enum's `options`; a list's `x-options`, which makes it a multi-select.
  const options =
    type === "enum"
      ? optionsOf(raw["options"], of("options"), name, true, report)
      : type === "list"
        ? optionsOf(raw["x-options"], of("x-options"), name, false, report)
        : {}
  optionsPlaced(raw, type, name, of, report)
  const { validations, required } = validationsOf(
    raw["validations"],
    of("validations"),
    name,
    report,
  )
  const sensitive = flag("sensitive")
  const schema = schemaOf(raw["x-schema"], of("x-schema"), name, report)
  const label = text("x-schema-instance-label")
  const section = text("x-section")
  const locked = flag("x-locked")
  const hidden = flag("x-hidden")
  const showWhen = parseShowWhen(raw["x-show-when"])
  if (showWhen.problem !== undefined)
    report(of("x-show-when"), `on the field "${name}", ${showWhen.problem}`)
  const field: Field = {
    name,
    type,
    description: description ?? "",
    ...value,
    required,
    ...options,
    validations,
    sensitive,
    ...(schema === undefined ? {} : { schema }),
    ...(label === undefined || label === "" ? {} : { schemaInstanceLabel: label }),
    ...(section === undefined || section === "" ? {} : { section }),
    locked,
    hidden,
    ...(showWhen.showWhen === undefined ? {} : { showWhen: showWhen.showWhen }),
  }
  return { field, order }
}

/**
 * Options only where the type takes them, as Boilerplate has it: `options`
 * on an enum, which needs some, and `x-options` on a list. Elsewhere they
 * would do nothing.
 */
function optionsPlaced(
  raw: Raw,
  type: FieldType,
  name: string,
  of: (key: string) => Path,
  report: Report,
): void {
  if (type === "enum") {
    const written = raw["options"]
    if (isAbsent(written) || (Array.isArray(written) && written.length === 0))
      report(
        of("options"),
        `the enum field "${name}" needs \`options\`: a list of at least one, or a block's output that holds one`,
      )
  } else if (!isAbsent(raw["options"]))
    report(
      of("options"),
      `\`options\` is only for an enum field, and "${name}" has the type ${type}${type === "list" ? ": a list's choices are its `x-options`" : ""}`,
    )
  if (type !== "list" && !isAbsent(raw["x-options"]))
    report(
      of("x-options"),
      `\`x-options\` is only for a list field, and "${name}" has the type ${type}`,
    )
}

/** Boilerplate's key for the order it asks for variables in. Without one, a field's order is 0. */
function orderOf(raw: unknown, at: Path, name: string, report: Report): number {
  if (isAbsent(raw)) return 0
  if (typeof raw === "number" && Number.isInteger(raw)) return raw
  report(at, `the \`order\` of the field "${name}" must be a whole number, such as 2`)
  return 0
}

function defaultOf(
  raw: unknown,
  at: Path,
  name: string,
  report: Report,
): { readonly default?: FieldValue } {
  if (isAbsent(raw)) return {}
  const value = decodeValue(raw)
  if (Result.isSuccess(value)) return { default: value.success }
  report(
    at,
    `the default of the field "${name}" must be text, a number, true or false, or a list or map of them, nested at most ${MAX_VALUE_DEPTH} levels deep`,
  )
  return {}
}

/**
 * The options of an enum (`scalars`: a number or true/false is taken as its
 * text) or a list: written in the YAML, or a block's output that holds them.
 * A list of none leaves a list a list, not a multi-select.
 */
function optionsOf(
  raw: unknown,
  at: Path,
  name: string,
  scalars: boolean,
  report: Report,
): Pick<Field, "options" | "optionLabels" | "optionsFrom"> {
  if (isAbsent(raw)) return {}
  const key = String(at.at(-1))
  if (Array.isArray(raw)) {
    const { items, invalid } = optionItemsOf(raw, scalars)
    for (const index of invalid)
      report(
        [...at, index],
        `each of the \`${key}\` of the field "${name}" must be text, or a map with a \`value\` and a \`label\``,
      )
    return items.length === 0 && !scalars ? {} : optionFields(items)
  }
  const reference = typeof raw === "string" ? parseOptionsReference(raw) : undefined
  if (reference !== undefined)
    return { optionsFrom: { block: reference.blockId, output: reference.outputName } }
  report(
    at,
    `the \`${key}\` of the field "${name}" must be a list, or a block's output that holds one, such as "{{ fromJson .outputs.<block_id>.<output_name> }}"`,
  )
  return {}
}

/**
 * Each validation: a name (`- required`) or a map with a `type`, in any
 * case, its message its `description` or `message`, its arguments its
 * `args`, or else its `regex`, `min` and `max`. A name it doesn't know, a
 * name with arguments (`length(1,5)`) among them, is `custom`: never checked.
 * A length without two numeric bounds, or a regex without a pattern that
 * compiles, is a problem: the validator would skip it.
 */
function validationsOf(
  raw: unknown,
  at: Path,
  name: string,
  report: Report,
): { readonly validations: ReadonlyArray<Validation>; readonly required: boolean } {
  if (isAbsent(raw)) return { validations: [], required: false }
  if (!Array.isArray(raw)) {
    report(at, `the \`validations\` of the field "${name}" must be a list`)
    return { validations: [], required: false }
  }
  const validations = raw.flatMap((entry: unknown, index): Validation[] => {
    const written = typeof entry === "string" ? { type: entry } : isMap(entry) ? entry : undefined
    const type =
      written !== undefined && typeof written["type"] === "string"
        ? written["type"].toLowerCase()
        : ""
    if (written === undefined || type === "") {
      report(
        [...at, index],
        `each validation of the field "${name}" must be a name, such as required, or a map with a \`type\``,
      )
      return []
    }
    const kind = VALIDATION_KINDS.has(type) ? (type as ValidationKind) : "custom"
    const message = [written["description"], written["message"]].find(
      (text): text is string => typeof text === "string" && text !== "",
    )
    const args = Array.isArray(written["args"])
      ? written["args"]
      : [written["regex"], written["min"], written["max"]].filter((arg) => arg !== undefined)
    const unusable = argumentsProblem(kind, args)
    if (unusable !== undefined) {
      report([...at, index], `the ${kind} validation of the field "${name}" ${unusable}`)
      return []
    }
    return [
      {
        kind,
        ...(message === undefined ? {} : { message }),
        ...(args.length === 0 ? {} : { args }),
      },
    ]
  })
  return { validations, required: validations.some(({ kind }) => kind === "required") }
}

/**
 * Why a validation's arguments can't be used, as the validator reads them
 * (`validators.ts`): a length's two bounds, a regex's pattern. The
 * validator skips a rule it can't use, so the field would take any value.
 */
function argumentsProblem(kind: ValidationKind, args: ReadonlyArray<unknown>): string | undefined {
  switch (kind) {
    case "length": {
      const bounds = args.slice(0, 2).map(Number)
      return bounds.length === 2 && bounds.every(Number.isFinite)
        ? undefined
        : "needs two numbers, its least and greatest length, such as { type: length, min: 1, max: 20 }"
    }
    case "regex": {
      if (args.length === 0) return "needs a pattern, such as { type: regex, regex: ^[a-z]+$ }"
      try {
        new RegExp(String(args[0]))
        return undefined
      } catch {
        return "has a pattern that isn't a valid regular expression"
      }
    }
    // These take no arguments; a custom one is never checked.
    case "required":
    case "email":
    case "url":
    case "alpha":
    case "digit":
    case "alphanumeric":
    case "semver":
    case "countrycode2":
    case "custom":
      return undefined
  }
}

/** A map's or a tuple's entry schema: each key's type, a type it doesn't know being text. */
function schemaOf(
  raw: unknown,
  at: Path,
  name: string,
  report: Report,
): Field["schema"] | undefined {
  if (isAbsent(raw)) return undefined
  if (!isMap(raw)) {
    report(
      at,
      `the \`x-schema\` of the field "${name}" must map each key to its type, such as { email: string }`,
    )
    return undefined
  }
  const entries = Object.entries(raw)
  return entries.length === 0
    ? undefined
    : Object.fromEntries(entries.map(([key, type]) => [key, typeOf(type)]))
}

/**
 * Whether each section `x-sections` names starts folded. Naming a section
 * no field is in is a problem; a section named twice takes its last
 * settings, as today.
 */
function foldedOf(
  raw: unknown,
  fields: ReadonlyArray<Field>,
  report: Report,
): ReadonlyMap<string, boolean> {
  const folded = new Map<string, boolean>()
  if (isAbsent(raw)) return folded
  if (!Array.isArray(raw)) {
    report(["x-sections"], "`x-sections` must be a list of sections, each with a `name`")
    return folded
  }
  const named = new Set(fields.flatMap((field) => field.section ?? []))
  raw.forEach((entry: unknown, index) => {
    const name = isMap(entry) ? entry["name"] : undefined
    if (!isMap(entry) || typeof name !== "string" || name === "") {
      report(["x-sections", index], "each section in `x-sections` needs a `name`, its text")
      return
    }
    if (!named.has(name))
      report(
        ["x-sections", index, "name"],
        `\`x-sections\` names the section "${name}", which no field is in`,
      )
    folded.set(
      name,
      flagOf(
        entry["collapsed"],
        ["x-sections", index, "collapsed"],
        `\`collapsed\` on the section "${name}"`,
        report,
      ),
    )
  })
  return folded
}

/**
 * `spec` with each prefilled value as its field's default: what the field
 * starts with, what its Reset puts back, and the value of a locked or hidden
 * field.
 */
export function withPrefilled(
  spec: FormSpec,
  prefilled: Readonly<Record<string, FieldValue>> | undefined,
): FormSpec {
  if (prefilled === undefined) return spec
  return {
    ...spec,
    fields: spec.fields.map((field) =>
      Object.hasOwn(prefilled, field.name) ? { ...field, default: prefilled[field.name]! } : field,
    ),
  }
}

/** Each prefilled value for a field `spec` lacks, with the name it is nearest, if one is near. */
export function prefilledProblems(
  spec: FormSpec,
  prefilled: Readonly<Record<string, FieldValue>> | undefined,
): ReadonlyArray<ConfigProblem> {
  const names = spec.fields.map((field) => field.name)
  return Object.keys(prefilled ?? {}).flatMap((key) => {
    if (names.includes(key)) return []
    const near = nearest(key, names)
    return [
      {
        path: ["prefilledVariables", key],
        message: `"${key}" is no field of the form${near === undefined ? "" : ` (did you mean "${near}"?)`}`,
      },
    ]
  })
}

/**
 * `name` in the folder `folder`, as `path.posix.join` gives it, which keys
 * each file of a folder a block names (`RunbookTexts`). Written out, as
 * every client loads a block, and no client but the main process has
 * `node:path`.
 */
export function joinedPath(folder: string, name: string): string {
  const absolute = folder.startsWith("/")
  const parts: string[] = []
  for (const part of `${folder}/${name}`.split("/")) {
    if (part === "" || part === ".") continue
    if (part !== "..") parts.push(part)
    else if (parts.length > 0 && parts.at(-1) !== "..") parts.pop()
    // Above the root of an absolute path is the root.
    else if (!absolute) parts.push(part)
  }
  const joined = parts.join("/")
  return absolute ? `/${joined}` : joined === "" ? "." : joined
}

/** The names a folder's boilerplate config may have, in the order they are looked for. */
export const BOILERPLATE_FILES = ["boilerplate.yml", "boilerplate.yaml"] as const

/**
 * The boilerplate config a block's `path` names, among the files the block
 * read when the runbook opened: the file itself, or else the folder's
 * `boilerplate.yml`, then its `boilerplate.yaml`. None when it has neither.
 */
export function boilerplateFileIn(
  files: RunbookTexts,
  named: string,
): { readonly file: string; readonly text: string } | undefined {
  const own = files.get(named)
  if (own !== undefined) return { file: named, text: own }
  for (const name of BOILERPLATE_FILES) {
    const file = joinedPath(named, name)
    const text = files.get(file)
    if (text !== undefined) return { file, text }
  }
  return undefined
}

/**
 * The form a boilerplate file gives, or each problem in it, each saying the
 * file and the line, and quoting no value or default: a sensitive field's
 * default may be beside the mistake.
 */
export function readBoilerplateFile(
  file: string,
  text: string,
): Result.Result<FormSpec, ReadonlyArray<string>> {
  const { doc, lines, problems } = parseYaml(text)
  if (problems.length > 0)
    return Result.fail(
      problems.map(
        ({ line, column, reason }) =>
          `${file} isn't valid YAML at line ${line}, column ${column}: ${reason}.`,
      ),
    )
  const data = yamlData(doc)
  if (Result.isFailure(data))
    return Result.fail([
      `${file} can't be read at line ${lines.linePos(data.failure.offset).line}: ${data.failure.message}`,
    ])
  const read = readBoilerplateForm(data.success)
  if (read.problems.length === 0) return Result.succeed(read.spec)
  return Result.fail(
    read.problems.map(({ path: at, message }) => {
      const { line } = lines.linePos(nodeAt(doc.contents, at)?.range?.[0] ?? 0)
      return `${file}, line ${line}: ${message}.`
    }),
  )
}
