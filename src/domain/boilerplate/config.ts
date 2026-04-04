/**
 * Boilerplate config parsing — TypeScript port of api/boilerplate_config.go.
 *
 * Unlike the Go implementation which delegates to gruntwork-io/boilerplate for
 * YAML parsing, this TypeScript version parses the boilerplate.yml directly
 * using the `yaml` npm package. This avoids pulling in heavy Go-specific
 * indirect dependencies while achieving the same result.
 */

import { Effect } from "effect"
import YAML from "yaml"

import { BoilerplateConfigError } from "../../errors/index.js"
import type {
  BoilerplateConfig,
  BoilerplateVariable,
  BoilerplateVarType,
  BoilerplateValidationType,
  ValidationRule,
  Section,
  OutputDependency,
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
  validations?: RawValidation[]
  // Runbooks x-extensions (ignored by Boilerplate itself)
  "x-schema"?: Record<string, string>
  "x-schema-instance-label"?: string
  "x-section"?: string
}

interface RawConfig {
  variables?: RawVariable[]
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

function extractValidations(rawValidations: RawValidation[] | undefined): {
  validations: ValidationRule[]
  isRequired: boolean
} {
  if (!rawValidations || rawValidations.length === 0) {
    return { validations: [], isRequired: false }
  }

  let isRequired = false
  const validations: ValidationRule[] = []

  for (const rv of rawValidations) {
    const typeName = rv.type ?? ""
    const mapped = mapValidationType(typeName)

    if (mapped === "required") {
      isRequired = true
    }

    const args: unknown[] = rv.args ? [...rv.args] : []

    // Pull structured args from shorthand fields when explicit args are absent
    if (args.length === 0) {
      if (rv.regex !== undefined) args.push(rv.regex)
      if (rv.min !== undefined) args.push(rv.min)
      if (rv.max !== undefined) args.push(rv.max)
    }

    validations.push({
      type: mapped,
      message: rv.description ?? rv.message ?? "",
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
// Section grouping (mirrors Go extractSectionGroupings / groupIntoSections)
// ---------------------------------------------------------------------------

function buildSections(
  rawVars: RawVariable[],
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

  return sectionOrder.map((name) => ({
    name,
    variables: sectionVars.get(name) ?? [],
  }))
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
export function parseBoilerplateConfig(yamlContent: string) {
  return Effect.gen(function* () {
    let raw: RawConfig
    try {
      raw = YAML.parse(yamlContent) as RawConfig
    } catch (err) {
      return yield* new BoilerplateConfigError({
        message: `Failed to parse boilerplate YAML: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      })
    }

    if (!raw || !raw.variables) {
      return {
        variables: [],
        sections: [],
        outputDependencies: [],
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

      // Default value
      if (rv.default !== undefined) {
        variable.default = rv.default
      }

      // Enum options
      if (varType === "enum" && rv.options) {
        variable.options = rv.options
      }

      // x-schema
      const schema = rv["x-schema"]
      if (schema && Object.keys(schema).length > 0) {
        variable.schema = schema
      }

      // x-schema-instance-label
      const schemaLabel = rv["x-schema-instance-label"]
      if (schemaLabel) {
        variable.schemaInstanceLabel = schemaLabel
      }

      // x-section
      const section = rv["x-section"]
      if (section) {
        variable.sectionName = section
      }

      variables.push(variable)
    }

    const sections = buildSections(rawVars)

    return {
      variables,
      sections,
      outputDependencies: [],
    } satisfies BoilerplateConfig
  })
}

// ---------------------------------------------------------------------------
// Output dependency extraction
// ---------------------------------------------------------------------------

/**
 * Regex pair for output dependency extraction. Uses a two-pass approach:
 * blockRegex finds all {{ }} template blocks, then depRegex scans within each
 * block for `.outputs.X.Y` references.
 *
 * IMPORTANT: Keep in sync with the Go implementation in
 * api/boilerplate_config.go and the TypeScript frontend in
 * web/src/lib/extractTemplateDependencies.ts.
 */
const OUTPUT_DEP_BLOCK_REGEX = /\{\{-?([\s\S]*?)-?\}\}/g
const OUTPUT_DEP_REGEX = /\.outputs\.([a-zA-Z0-9_-]+)\.(\w+)/g

/**
 * Extract `.outputs.blockId.outputName` references from template content.
 * Returns deduplicated dependencies found inside `{{ }}` template blocks.
 */
export function extractOutputDependencies(content: string): OutputDependency[] {
  const dependencies: OutputDependency[] = []
  const seen = new Set<string>()

  // Reset regex state
  OUTPUT_DEP_BLOCK_REGEX.lastIndex = 0

  let blockMatch: RegExpExecArray | null
  while ((blockMatch = OUTPUT_DEP_BLOCK_REGEX.exec(content)) !== null) {
    if (!blockMatch[1]) continue
    const blockContent = blockMatch[1]

    // Reset inner regex for each block
    OUTPUT_DEP_REGEX.lastIndex = 0

    let depMatch: RegExpExecArray | null
    while ((depMatch = OUTPUT_DEP_REGEX.exec(blockContent)) !== null) {
      if (!depMatch[1] || !depMatch[2]) continue

      const originalBlockId = depMatch[1]
      const normalizedBlockId = normalizeBlockID(originalBlockId)
      const outputName = depMatch[2]
      const fullPath = `outputs.${normalizedBlockId}.${outputName}`

      if (!seen.has(fullPath)) {
        seen.add(fullPath)
        dependencies.push({
          blockId: originalBlockId,
          outputName,
          fullPath,
        })
      }
    }
  }

  return dependencies
}
