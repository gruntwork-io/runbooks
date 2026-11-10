/**
 * Builds a TfModuleSpec from a module's files: the inputs variables.tf
 * declares, presented the way the module's runbook_block.yml says.
 *
 * variables.tf owns each input's name, type, default and validation, so a
 * runbook_block.yml entry for an input variables.tf doesn't declare is an error:
 * the form would otherwise drift from the module without anyone noticing.
 */
import { Effect } from "effect"
import YAML from "yaml"
import { TfModuleError } from "../../errors/index.ts"
import { errorMessage } from "../../errors/message.ts"
import { loadGoWasm } from "../../layers/goWasmGlobal.ts"
import type {
  TfModuleInputKind,
  TfModuleLookup,
  TfModuleOption,
  TfModuleOutput,
  TfModulePreset,
  TfModuleProvider,
  TfModuleShortcut,
  TfModuleSpec,
  TfModuleVariable,
  TfModulePullRequest,
} from "./types.ts"
import { interpretValidations, type TfValidation } from "./validations.ts"
import { rowTemplateError, templateFields } from "./rowTemplate.ts"
import { isRemoteSource } from "../../remote-source.ts"

/** The name of the metadata file at a module's root. */
export const METADATA_FILE = "runbook_block.yml"

/** The runbook_block.yml format versions this build reads. */
const METADATA_VERSIONS = new Set([0])

/** One HCL file of the module, by name. */
export interface ModuleFile {
  readonly name: string
  readonly content: string
}

/** HCL as HashiCorp's own parser converts it to JSON. */
type HclJson = Record<string, unknown>

type Hcl2Json = typeof import("@cdktf/hcl2json")
let hcl2json: Promise<Hcl2Json> | undefined

/**
 * HashiCorp's HCL library, loaded on first use. The package starts its Go
 * runtime as soon as it's imported, so the import waits its turn with the
 * process's other Go runtimes, and a first parse waits for that runtime to start.
 */
function hclParser(): Promise<Hcl2Json> {
  hcl2json ??= loadGoWasm(async () => {
    const parser = await import("@cdktf/hcl2json")
    await parser.parse("runbooks-probe.tf", "")
    return parser
  }).catch((err: unknown) => {
    hcl2json = undefined
    throw err
  })
  return hcl2json
}

/** Parses one HCL file with HashiCorp's HCL library, compiled to WebAssembly. */
export const parseHcl = (file: ModuleFile) =>
  Effect.tryPromise({
    try: async () => (await hclParser()).parse(file.name, file.content) as Promise<HclJson>,
    catch: (cause) =>
      new TfModuleError({
        message: `Couldn't parse ${file.name}: ${errorMessage(cause)}`,
        cause,
      }),
  })

// ---------------------------------------------------------------------------
// variables.tf
// ---------------------------------------------------------------------------

/** An input as variables.tf declares it. */
export interface TfVariable {
  readonly name: string
  readonly tfType: string
  readonly description: string
  readonly hasDefault: boolean
  readonly default?: unknown
  readonly sensitive: boolean
  readonly validations: readonly TfValidation[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The single body of an HCL block, which the JSON form wraps in a one-element array. */
const blockBody = (value: unknown): Record<string, unknown> | undefined => {
  const first = Array.isArray(value) ? value[0] : value
  return isRecord(first) ? first : undefined
}

/** An HCL expression's source text: the JSON form writes it as `${...}`. */
const expressionText = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined
  const match = /^\$\{([\s\S]*)\}$/.exec(value)
  return match ? match[1]!.trim() : value
}

/**
 * The order the files declare their variables in. The JSON form keys
 * variables by name, which loses it, and a form should follow the module.
 */
function declarationOrder(files: readonly ModuleFile[]): Map<string, number> {
  const order = new Map<string, number>()
  for (const file of files) {
    for (const match of file.content.matchAll(/^\s*variable\s+"([^"]+)"/gm)) {
      if (!order.has(match[1]!)) order.set(match[1]!, order.size)
    }
  }
  return order
}

/** The inputs the parsed files declare, in declaration order. */
export function tfVariables(
  parsed: readonly HclJson[],
  files: readonly ModuleFile[],
): TfVariable[] {
  const variables: TfVariable[] = []
  for (const json of parsed) {
    if (!isRecord(json.variable)) continue
    for (const [name, value] of Object.entries(json.variable)) {
      const body = blockBody(value) ?? {}
      const hasDefault = Object.hasOwn(body, "default")
      const validations = (Array.isArray(body.validation) ? body.validation : [])
        .filter(isRecord)
        .map((validation) => ({
          condition: expressionText(validation.condition) ?? "",
          errorMessage:
            typeof validation.error_message === "string" ? validation.error_message : "",
        }))
      variables.push({
        name,
        tfType: expressionText(body.type) ?? "any",
        description: typeof body.description === "string" ? body.description : "",
        hasDefault,
        ...(hasDefault ? { default: body.default } : {}),
        sensitive: body.sensitive === true,
        validations,
      })
    }
  }
  const order = declarationOrder(files)
  const position = (name: string) => order.get(name) ?? Number.MAX_SAFE_INTEGER
  return variables.sort((a, b) => position(a.name) - position(b.name))
}

/** The providers the files' `terraform { required_providers { ... } }` blocks name. */
export function requiredProviders(parsed: readonly HclJson[]): TfModuleProvider[] {
  const providers: TfModuleProvider[] = []
  for (const json of parsed) {
    const terraform = Array.isArray(json.terraform) ? json.terraform : []
    for (const block of terraform) {
      if (!isRecord(block)) continue
      const required = blockBody(block.required_providers)
      for (const [name, value] of Object.entries(required ?? {})) {
        const entry = isRecord(value) ? value : {}
        providers.push({
          name,
          ...(typeof entry.source === "string" ? { source: entry.source } : {}),
          ...(typeof entry.version === "string" ? { version: entry.version } : {}),
        })
      }
    }
  }
  return providers
}

/** The form control a variables.tf type needs. */
export function inputKind(tfType: string): TfModuleInputKind {
  const type = tfType.replace(/\s+/g, "")
  if (type === "string") return "string"
  if (type === "number") return "number"
  if (type === "bool") return "bool"
  if (/^(list|set)\((string|number)\)$/.test(type)) return "list"
  if (/^map\((string|number|bool)\)$/.test(type)) return "map"
  return "json"
}

// ---------------------------------------------------------------------------
// runbook_block.yml
// ---------------------------------------------------------------------------

/** Turns a name such as `display_name` into a label, `Display name`. */
export function labelFromName(name: string): string {
  const words = name.replace(/[_-]+/g, " ").trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Collects what's wrong with runbook_block.yml as the entries are read. */
class Problems {
  readonly errors: string[] = []
  readonly warnings: string[] = []
  unknownKeys(where: string, value: Record<string, unknown>, known: readonly string[]): void {
    for (const key of Object.keys(value)) {
      if (!known.includes(key))
        this.warnings.push(`${where}: Runbooks doesn't know the key "${key}".`)
    }
  }
}

const optionalString = (value: unknown, where: string, problems: Problems): string | undefined => {
  if (value === undefined || value === null) return undefined
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  problems.errors.push(`${where} must be text.`)
  return undefined
}

/**
 * Options as runbook_block.yml writes them: a map from each value to its label and
 * description, or a list of values.
 */
function readOptions(
  raw: unknown,
  where: string,
  problems: Problems,
): TfModuleOption[] | undefined {
  if (raw === undefined) return undefined
  if (Array.isArray(raw)) {
    return raw.map((value) => ({ value: String(value), label: String(value) }))
  }
  if (!isRecord(raw)) {
    problems.errors.push(`${where} must be a map from each value to its label and description.`)
    return undefined
  }
  return Object.entries(raw).map(([value, entry]) => {
    if (typeof entry === "string") return { value, label: entry }
    const fields = isRecord(entry) ? entry : {}
    problems.unknownKeys(`${where}.${value}`, fields, ["label", "description"])
    const label = optionalString(fields.label, `${where}.${value}.label`, problems)
    const description = optionalString(
      fields.description,
      `${where}.${value}.description`,
      problems,
    )
    return { value, label: label ?? value, ...(description ? { description } : {}) }
  })
}

function readLookup(raw: unknown, where: string, problems: Problems): TfModuleLookup | undefined {
  if (raw === undefined) return undefined
  if (!isRecord(raw) || typeof raw.from !== "string" || raw.from === "") {
    problems.errors.push(`${where} needs "from", the name of a lookup such as google.people.`)
    return undefined
  }
  problems.unknownKeys(where, raw, ["from", "label", "value", "sets"])
  const label = optionalString(raw.label, `${where}.label`, problems)
  const value = optionalString(raw.value, `${where}.value`, problems)
  let sets: Record<string, string> | undefined
  if (raw.sets !== undefined) {
    if (isRecord(raw.sets) && Object.values(raw.sets).every((v) => typeof v === "string")) {
      sets = raw.sets as Record<string, string>
    } else {
      problems.errors.push(`${where}.sets must map input names to templates.`)
    }
  }
  for (const [key, template] of [["label", label], ...Object.entries(sets ?? {})]) {
    const error = template === undefined ? undefined : rowTemplateError(template)
    if (error) problems.errors.push(`${where} ${key}: ${error}`)
  }
  return {
    from: raw.from,
    ...(label ? { label } : {}),
    ...(value ? { value } : {}),
    ...(sets ? { sets } : {}),
  }
}

/** A presets file: a map from each preset's name to its label, description and settings. */
export function parsePresets(content: string, where: string): TfModulePreset[] {
  const problems = new Problems()
  let raw: unknown
  try {
    raw = YAML.parse(content)
  } catch (cause) {
    throw new TfModuleError({
      message: `${where} isn't valid YAML: ${errorMessage(cause)}`,
      cause,
    })
  }
  if (!isRecord(raw)) {
    throw new TfModuleError({
      message: `${where} must be a map from each preset's name to its settings.`,
    })
  }
  const presets = Object.entries(raw).map(([name, entry]) => {
    const fields = isRecord(entry) ? entry : {}
    if (!isRecord(fields.settings)) {
      problems.errors.push(
        `${where}: preset "${name}" needs settings, a map of the values it sets.`,
      )
    }
    const label = optionalString(fields.label, `${where}: ${name}.label`, problems)
    const description = optionalString(
      fields.description,
      `${where}: ${name}.description`,
      problems,
    )
    return {
      name,
      label: label ?? labelFromName(name),
      ...(description ? { description } : {}),
      settings: isRecord(fields.settings) ? fields.settings : {},
    }
  })
  if (problems.errors.length > 0) throw new TfModuleError({ message: problems.errors.join(" ") })
  return presets
}

/** What runbook_block.yml says about the module, before it's checked against variables.tf. */
export interface ModuleMetadata {
  readonly title?: string
  readonly description?: string
  /** The logo's path in the module, or an https: URL. */
  readonly logo?: string
  /** Where code in a repository finds the module, such as a Git URL at a tag. */
  readonly source?: string
  readonly variables: Readonly<Record<string, VariableMetadata>>
  readonly outputs: Readonly<Record<string, OutputMetadata>>
  readonly pullRequest?: TfModulePullRequest
  /** The Google APIs the module's resources call. */
  readonly googleApis: readonly string[]
  readonly warnings: readonly string[]
}

export interface OutputMetadata {
  readonly label?: string
  readonly description?: string
  /** The text of a link to the output's value, which must be an https: URL. */
  readonly link?: string
}

export interface VariableMetadata {
  readonly label?: string
  readonly description?: string
  readonly primary?: boolean
  readonly options?: readonly TfModuleOption[]
  readonly lookup?: TfModuleLookup
  readonly shortcut?: TfModuleShortcut
  /** The presets file's path in the module. */
  readonly presets?: string
  /** A template over the form's values that ends the input's value, such as `@{{ .domain }}`. */
  readonly suffix?: string
}

/** Reads runbook_block.yml. Fails on anything that would make the form wrong. */
export function parseMetadata(content: string | undefined): ModuleMetadata {
  if (content === undefined) return { variables: {}, outputs: {}, googleApis: [], warnings: [] }
  let raw: unknown
  try {
    raw = YAML.parse(content)
  } catch (cause) {
    throw new TfModuleError({
      message: `${METADATA_FILE} isn't valid YAML: ${errorMessage(cause)}`,
      cause,
    })
  }
  if (raw === null || raw === undefined) {
    return { variables: {}, outputs: {}, googleApis: [], warnings: [] }
  }
  if (!isRecord(raw)) throw new TfModuleError({ message: `${METADATA_FILE} must be a map.` })

  const problems = new Problems()
  problems.unknownKeys(METADATA_FILE, raw, [
    "version",
    "source",
    "block",
    "variables",
    "outputs",
    "pullRequest",
    "requires",
  ])
  if (raw.version !== undefined && !METADATA_VERSIONS.has(raw.version as number)) {
    throw new TfModuleError({
      message: `${METADATA_FILE} is version ${JSON.stringify(raw.version)}, which this version of Runbooks can't read. Update Runbooks.`,
    })
  }

  const block = isRecord(raw.block) ? raw.block : {}
  problems.unknownKeys("block", block, ["title", "description", "logo"])
  const title = optionalString(block.title, "block.title", problems)
  const description = optionalString(block.description, "block.description", problems)
  const logo = optionalString(block.logo, "block.logo", problems)

  const source = optionalString(raw.source, "source", problems)
  if (source !== undefined && !isRemoteSource(source)) {
    problems.errors.push(
      `source must be a URL a repository's code can fetch the module from, such as git::https://github.com/acme/catalog//modules/group?ref=v1.0.0, not "${source}".`,
    )
  } else if (source !== undefined && !/[?&]ref=/.test(source)) {
    problems.warnings.push(
      "source has no ?ref=, so code in a repository follows the module's default branch. Pin it to a tag.",
    )
  }

  const variables: Record<string, VariableMetadata> = {}
  const rawVariables = raw.variables ?? {}
  if (!isRecord(rawVariables)) {
    problems.errors.push("variables must be a map from each input's name to how to present it.")
  } else {
    for (const [name, entry] of Object.entries(rawVariables)) {
      const where = `variables.${name}`
      const fields = isRecord(entry) ? entry : {}
      problems.unknownKeys(where, fields, [
        "label",
        "description",
        "primary",
        "options",
        "lookup",
        "presets",
        "suffix",
        "shortcut",
      ])
      if (fields.primary !== undefined && typeof fields.primary !== "boolean") {
        problems.errors.push(`${where}.primary must be true or false.`)
      }
      const label = optionalString(fields.label, `${where}.label`, problems)
      const varDescription = optionalString(fields.description, `${where}.description`, problems)
      const options = readOptions(fields.options, `${where}.options`, problems)
      const lookup = readLookup(fields.lookup, `${where}.lookup`, problems)
      const shortcutLookup = readLookup(fields.shortcut, `${where}.shortcut`, problems)
      if (shortcutLookup?.sets) problems.errors.push(`${where}.shortcut can't have "sets".`)
      const shortcut = shortcutLookup && {
        from: shortcutLookup.from,
        ...(shortcutLookup.label ? { label: shortcutLookup.label } : {}),
        ...(shortcutLookup.value ? { value: shortcutLookup.value } : {}),
      }
      const presets = optionalString(fields.presets, `${where}.presets`, problems)
      const suffix = optionalString(fields.suffix, `${where}.suffix`, problems)
      const suffixError = suffix === undefined ? undefined : rowTemplateError(suffix)
      if (suffixError) problems.errors.push(`${where}.suffix: ${suffixError}`)
      variables[name] = {
        ...(label ? { label } : {}),
        ...(varDescription ? { description: varDescription } : {}),
        ...(fields.primary === true ? { primary: true } : {}),
        ...(options ? { options } : {}),
        ...(lookup ? { lookup } : {}),
        ...(shortcut ? { shortcut } : {}),
        ...(presets ? { presets } : {}),
        ...(suffix ? { suffix } : {}),
      }
    }
  }

  const outputs: Record<string, OutputMetadata> = {}
  const rawOutputs = raw.outputs ?? {}
  if (!isRecord(rawOutputs)) {
    problems.errors.push("outputs must be a map from each output's name to how to present it.")
  } else {
    for (const [name, entry] of Object.entries(rawOutputs)) {
      const where = `outputs.${name}`
      const fields = isRecord(entry) ? entry : {}
      problems.unknownKeys(where, fields, ["label", "description", "link"])
      const label = optionalString(fields.label, `${where}.label`, problems)
      const outDescription = optionalString(fields.description, `${where}.description`, problems)
      const link = optionalString(fields.link, `${where}.link`, problems)
      outputs[name] = {
        ...(label ? { label } : {}),
        ...(outDescription ? { description: outDescription } : {}),
        ...(link ? { link } : {}),
      }
    }
  }

  const rawPullRequest = isRecord(raw.pullRequest) ? raw.pullRequest : {}
  problems.unknownKeys("pullRequest", rawPullRequest, ["title", "description"])
  const pullRequest: TfModulePullRequest = {}
  for (const key of ["title", "description"] as const) {
    const template = optionalString(rawPullRequest[key], `pullRequest.${key}`, problems)
    const templateError = template === undefined ? undefined : rowTemplateError(template)
    if (templateError) problems.errors.push(`pullRequest.${key}: ${templateError}`)
    if (template) Object.assign(pullRequest, { [key]: template })
  }

  const googleApis = readGoogleApis(raw.requires, problems)

  if (problems.errors.length > 0) {
    throw new TfModuleError({ message: `${METADATA_FILE}: ${problems.errors.join(" ")}` })
  }
  return {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(logo ? { logo } : {}),
    ...(source ? { source } : {}),
    variables,
    outputs,
    ...(Object.keys(pullRequest).length > 0 ? { pullRequest } : {}),
    googleApis,
    warnings: problems.warnings,
  }
}

/** A Google API's service name, such as cloudidentity.googleapis.com. */
const GOOGLE_SERVICE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*\.googleapis\.com$/

/** `requires.google.apis`: the Google APIs the module's resources call. */
function readGoogleApis(rawRequires: unknown, problems: Problems): string[] {
  if (rawRequires === undefined) return []
  if (!isRecord(rawRequires)) {
    problems.errors.push("requires must be a map, such as requires: { google: { apis: [...] } }.")
    return []
  }
  problems.unknownKeys("requires", rawRequires, ["google"])
  const google = rawRequires.google ?? {}
  if (!isRecord(google)) {
    problems.errors.push("requires.google must be a map with apis.")
    return []
  }
  problems.unknownKeys("requires.google", google, ["apis"])
  const apis = google.apis ?? []
  if (!Array.isArray(apis)) {
    problems.errors.push("requires.google.apis must be a list of service names.")
    return []
  }
  const services: string[] = []
  for (const api of apis) {
    if (typeof api !== "string" || !GOOGLE_SERVICE.test(api)) {
      problems.errors.push(
        `requires.google.apis lists ${JSON.stringify(api)}, which isn't a Google API's service name, such as cloudidentity.googleapis.com.`,
      )
    } else if (!services.includes(api)) {
      services.push(api)
    }
  }
  return services
}

// ---------------------------------------------------------------------------
// The spec
// ---------------------------------------------------------------------------

/** The text of a README's first level-one heading, the module's own name for itself. */
export function readmeTitle(readme: string | undefined): string | undefined {
  const match = readme ? /^#[ \t]+(.+?)[ \t#]*$/m.exec(readme) : null
  return match ? match[1] : undefined
}

/** An output as outputs.tf declares it. */
export interface TfOutput {
  readonly name: string
  readonly description: string
  readonly sensitive: boolean
}

/** The outputs the parsed files declare, in declaration order. */
export function tfOutputs(parsed: readonly HclJson[], files: readonly ModuleFile[]): TfOutput[] {
  const order = new Map<string, number>()
  for (const file of files) {
    for (const match of file.content.matchAll(/^\s*output\s+"([^"]+)"/gm)) {
      if (!order.has(match[1]!)) order.set(match[1]!, order.size)
    }
  }
  const position = (name: string) => order.get(name) ?? Number.MAX_SAFE_INTEGER
  return parsed
    .flatMap((json) => (isRecord(json.output) ? Object.entries(json.output) : []))
    .map(([name, value]) => {
      const body = blockBody(value) ?? {}
      return {
        name,
        description: typeof body.description === "string" ? body.description : "",
        sensitive: body.sensitive === true,
      }
    })
    .sort((a, b) => position(a.name) - position(b.name))
}

export interface BuildSpecInput {
  /** The module's folder name, the title when neither runbook_block.yml nor the README gives one. */
  readonly moduleName: string
  /** The title the module's README gives, the title when runbook_block.yml gives none. */
  readonly readmeTitle?: string
  readonly outputs: readonly TfOutput[]
  readonly variables: readonly TfVariable[]
  readonly providers: readonly TfModuleProvider[]
  readonly metadata: ModuleMetadata
  /** The presets each presets file in runbook_block.yml holds, by its path. */
  readonly presets: Readonly<Record<string, readonly TfModulePreset[]>>
  /** The logo runbook_block.yml names, already read into a URL. */
  readonly logo?: string
}

/** Joins variables.tf and runbook_block.yml into the spec the form draws. */
export function buildSpec(input: BuildSpecInput): TfModuleSpec {
  const declared = new Set(input.variables.map((variable) => variable.name))
  const unknown = Object.keys(input.metadata.variables).filter((name) => !declared.has(name))
  if (unknown.length > 0) {
    throw new TfModuleError({
      message: `${METADATA_FILE} describes ${unknown.map((name) => `"${name}"`).join(", ")}, which variables.tf doesn't declare.`,
    })
  }

  for (const [name, meta] of Object.entries(input.metadata.variables)) {
    const missing = Object.keys(meta.lookup?.sets ?? {}).filter((target) => !declared.has(target))
    if (missing.length > 0) {
      throw new TfModuleError({
        message: `${METADATA_FILE}: variables.${name}.lookup.sets fills ${missing.map((target) => `"${target}"`).join(", ")}, which variables.tf doesn't declare.`,
      })
    }
  }

  const outputs = new Set(input.outputs.map((output) => output.name))
  const unknownOutputs = Object.keys(input.metadata.outputs).filter((name) => !outputs.has(name))
  if (unknownOutputs.length > 0) {
    throw new TfModuleError({
      message: `${METADATA_FILE} describes the outputs ${unknownOutputs.map((name) => `"${name}"`).join(", ")}, which the module doesn't declare.`,
    })
  }

  for (const [name, meta] of Object.entries(input.metadata.variables)) {
    if (!meta.suffix) continue
    const missing = templateFields(meta.suffix).filter((field) => !declared.has(field))
    if (missing.length > 0) {
      throw new TfModuleError({
        message: `${METADATA_FILE}: variables.${name}.suffix reads ${missing.map((field) => `"${field}"`).join(", ")}, which variables.tf doesn't declare.`,
      })
    }
    if (inputKind(input.variables.find((v) => v.name === name)!.tfType) !== "string") {
      throw new TfModuleError({
        message: `${METADATA_FILE}: variables.${name}.suffix needs a string input.`,
      })
    }
  }

  for (const [key, template] of Object.entries(input.metadata.pullRequest ?? {})) {
    const missing = templateFields(template).filter((field) => !declared.has(field))
    if (missing.length > 0) {
      throw new TfModuleError({
        message: `${METADATA_FILE}: pullRequest.${key} reads ${missing.map((field) => `"${field}"`).join(", ")}, which variables.tf doesn't declare.`,
      })
    }
  }

  // A module whose runbook_block.yml picks no primary inputs shows the ones it
  // can't do without first.
  const anyPrimary = Object.values(input.metadata.variables).some((meta) => meta.primary)

  // runbook_block.yml orders the inputs it lists, since it says how to present
  // them; the rest follow in the order variables.tf declares them.
  const listed = Object.keys(input.metadata.variables)
  const rank = (name: string) => {
    const index = listed.indexOf(name)
    return index === -1 ? listed.length : index
  }
  const ordered = [...input.variables].sort((a, b) => rank(a.name) - rank(b.name))

  const variables = ordered.map((variable): TfModuleVariable => {
    const meta = input.metadata.variables[variable.name] ?? {}
    const { allowedValues, checks, constraints } = interpretValidations(
      variable.name,
      variable.validations,
    )
    const derived = allowedValues?.map((value) => ({ value, label: value }))
    const options = meta.options ?? derived
    const presets = meta.presets ? input.presets[meta.presets] : undefined
    return {
      name: variable.name,
      label: meta.label ?? labelFromName(variable.name),
      description: meta.description ?? variable.description,
      tfType: variable.tfType,
      kind: inputKind(variable.tfType),
      hasDefault: variable.hasDefault,
      ...(variable.hasDefault ? { default: variable.default } : {}),
      sensitive: variable.sensitive,
      primary: anyPrimary ? meta.primary === true : !variable.hasDefault,
      ...(options ? { options } : {}),
      // A validation that limits the values means nothing else would apply.
      ...(options && allowedValues ? { optionsOnly: true } : {}),
      ...(meta.lookup ? { lookup: meta.lookup } : {}),
      ...(meta.shortcut ? { shortcut: meta.shortcut } : {}),
      ...(presets ? { presets } : {}),
      ...(meta.suffix ? { suffix: meta.suffix } : {}),
      ...(checks.length > 0 ? { checks } : {}),
      ...(constraints.length > 0 ? { constraints } : {}),
    }
  })

  return {
    title: input.metadata.title ?? input.readmeTitle ?? labelFromName(input.moduleName),
    ...(input.metadata.description ? { description: input.metadata.description } : {}),
    providers: input.providers,
    ...(input.logo ? { logo: input.logo } : {}),
    ...(input.metadata.source ? { source: input.metadata.source } : {}),
    outputs: input.outputs.map((output): TfModuleOutput => {
      const meta = input.metadata.outputs[output.name] ?? {}
      return {
        name: output.name,
        label: meta.label ?? labelFromName(output.name),
        description: meta.description ?? output.description,
        sensitive: output.sensitive,
        ...(meta.link ? { link: meta.link } : {}),
      }
    }),
    variables,
    ...(input.metadata.pullRequest ? { pullRequest: input.metadata.pullRequest } : {}),
    googleApis: input.metadata.googleApis,
    warnings: input.metadata.warnings,
  }
}
