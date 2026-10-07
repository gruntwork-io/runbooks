/**
 * Boilerplate config parsing.
 *
 * Parses boilerplate.yml directly using the `yaml` npm package.
 */

import { Chunk, Effect, Stream } from "effect"
import YAML from "yaml"

import { BoilerplateConfigError } from "../../errors/index.js"
import { errorMessage } from "../../errors/message.ts"
import { FileSystem } from "../../services/FileSystem.js"
import { BATCH_IO_CONCURRENCY } from "../files/manifest.ts"
import { scanGuardedCode } from "./outputGuards.ts"
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
  options?: string[]
  sensitive?: boolean
  validations?: (RawValidation | string)[]
  // Runbooks x-extensions (ignored by Boilerplate itself)
  "x-schema"?: Record<string, string>
  "x-schema-instance-label"?: string
  "x-section"?: string
  // Enumerates the allowed values for a `list` variable so the form renders a multi-select picker. Boilerplate
  // forbids `options` on a non-enum type, so this rides the x-extension seam instead and the Go tool ignores it.
  "x-options"?: string[]
}

interface RawSkipFile {
  path?: unknown
  if?: unknown
}

interface RawConfig {
  variables?: RawVariable[]
  skip_files?: unknown
}

// ---------------------------------------------------------------------------
// Block ID normalisation (keep in sync with Go normalizeBlockID)
// ---------------------------------------------------------------------------

function normalizeBlockID(id: string): string {
  return id.replaceAll("-", "_")
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

function extractValidations(rawValidations: (RawValidation | string)[] | undefined): {
  validations: ValidationRule[]
  isRequired: boolean
} {
  if (!rawValidations || rawValidations.length === 0) {
    return { validations: [], isRequired: false }
  }

  let isRequired = false
  const validations: ValidationRule[] = []

  for (const rv of rawValidations) {
    // Accept the YAML shorthand form (`- required`) alongside the long form
    // (`- type: required`). The upstream gruntwork-io/boilerplate library
    // supports both; the Go parser on main inherited that via delegation.
    const normalized: RawValidation = typeof rv === "string" ? { type: rv } : rv

    const typeName = normalized.type ?? ""
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

    validations.push({
      type: mapped,
      message: normalized.description ?? normalized.message ?? "",
      args,
    })
  }

  return { validations, isRequired }
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
// Section grouping
// ---------------------------------------------------------------------------

function buildSections(rawVars: RawVariable[]): Section[] {
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

  return sectionOrder.map((name) => ({
    name,
    variables: sectionVars.get(name) ?? [],
  }))
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
    let raw: RawConfig
    try {
      raw = YAML.parse(yamlContent) as RawConfig
    } catch (err) {
      return yield* new BoilerplateConfigError({
        message: `Failed to parse boilerplate YAML: ${errorMessage(err)}`,
        cause: err,
      })
    }

    if (!raw || !raw.variables) {
      return {
        variables: [],
        sections: [],
        outputDependencies: [],
        skipFiles: raw ? parseSkipFiles(raw.skip_files) : [],
      } satisfies BoilerplateConfig
    }

    const rawVars = raw.variables
    const variables: BoilerplateVariable[] = []

    for (const rv of rawVars) {
      if (!rv.name) continue

      const varType = coerceVarType(rv.type)
      const { validations, isRequired } = extractValidations(rv.validations)

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

      if (varType === "enum" && rv.options) {
        variable.options = rv.options
      }

      // A `list` carrying x-options is the multi-select signal: the enumerated values constrain the picker. The
      // membership guarantee is UI-only — Boilerplate still treats the value as a plain list (no Go-side validation).
      // YAML.parse is untyped, so filter to strings rather than trusting the declared `string[]` shape.
      const xOptions = rv["x-options"]
      if (varType === "list" && Array.isArray(xOptions)) {
        const stringOptions = xOptions.filter((o): o is string => typeof o === "string")
        if (stringOptions.length > 0) {
          variable.options = stringOptions
        }
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

      variables.push(variable)
    }

    const sections = buildSections(rawVars)
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
 * An `.outputs.X.Y` reference. Keep in sync with the frontend extractor in
 * web/src/lib/extractTemplateDependencies.ts.
 */
const OUTPUT_DEP_REGEX = /\.outputs\.([a-zA-Z0-9_-]+)\.(\w+)/g

/**
 * Extract `.outputs.blockId.outputName` references from template content.
 * Returns deduplicated dependencies found inside `{{ }}` template blocks.
 *
 * An output is optional when every reference to it sits behind a `hasKey`
 * guard (see scanGuardedCode): the block still has to run, but the Generate
 * gate no longer waits for that output to exist.
 */
export function extractOutputDependencies(content: string): OutputDependency[] {
  const dependencies = new Map<string, OutputDependency>()

  for (const { code, guarded } of scanGuardedCode(content)) {
    for (const [, originalBlockId, outputName] of code.matchAll(OUTPUT_DEP_REGEX)) {
      if (!originalBlockId || !outputName) continue
      const fullPath = `outputs.${normalizeBlockID(originalBlockId)}.${outputName}`
      const optional = guarded.has(fullPath)

      const existing = dependencies.get(fullPath)
      if (existing) {
        // One unguarded reference makes the output required.
        if (!optional) delete existing.optional
        continue
      }
      dependencies.set(fullPath, {
        blockId: originalBlockId,
        outputName,
        fullPath,
        ...(optional ? { optional: true } : {}),
      })
    }
  }

  return [...dependencies.values()]
}

/** Most files {@link collectOutputDependencies} reads from one template directory. */
const MAX_SCANNED_TEMPLATE_FILES = 2000

/** Largest file, in bytes, that {@link collectOutputDependencies} reads. */
const MAX_SCANNED_TEMPLATE_FILE_BYTES = 1024 * 1024

/**
 * Collects the output dependencies of every file under `templateDir`,
 * subdirectories included, deduplicated by full path.
 *
 * Reads at most {@link MAX_SCANNED_TEMPLATE_FILES} files and skips any larger
 * than {@link MAX_SCANNED_TEMPLATE_FILE_BYTES}, so a reference past either
 * limit is not reported. A file that cannot be read is skipped.
 */
export function collectOutputDependencies(templateDir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem

    const files = yield* fs.walk(templateDir).pipe(
      Stream.filter((entry) => entry.isFile && entry.size <= MAX_SCANNED_TEMPLATE_FILE_BYTES),
      Stream.take(MAX_SCANNED_TEMPLATE_FILES),
      Stream.runCollect,
    )

    const contents = yield* Effect.forEach(
      Chunk.toReadonlyArray(files),
      (entry) => Effect.either(fs.readFile(entry.path)),
      { concurrency: BATCH_IO_CONCURRENCY },
    )

    return mergeOutputDependencies(
      ...contents.map((content) =>
        content._tag === "Right" ? extractOutputDependencies(content.right) : [],
      ),
    )
  })
}

/**
 * Merges dependency lists into one, deduplicated by full path. An output stays
 * optional only when every reference to it across the lists is optional.
 */
export function mergeOutputDependencies(...lists: OutputDependency[][]): OutputDependency[] {
  const byFullPath = new Map<string, OutputDependency>()
  for (const dep of lists.flat()) {
    const existing = byFullPath.get(dep.fullPath)
    if (!existing) {
      byFullPath.set(dep.fullPath, { ...dep })
      continue
    }
    if (!dep.optional) delete existing.optional
  }
  return [...byFullPath.values()]
}
