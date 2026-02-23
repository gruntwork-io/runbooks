// ============================================================================
// Config parsing - Ported from config/config.go and variables/*.go
// ============================================================================

import * as fs from 'fs'
import * as path from 'path'
import YAML from 'yaml'
import type {
  BoilerplateConfig,
  BoilerplateType,
  Variable,
  Dependency,
  Hook,
  Hooks,
  SkipFile,
  Engine,
  TemplateEngineType,
  ValidationRule,
  ValidationType,
} from '../../../shared/types'

const BOILERPLATE_CONFIG_FILE = 'boilerplate.yml'

const VALID_TYPES: BoilerplateType[] = ['string', 'int', 'float', 'bool', 'list', 'map', 'enum']
const VALID_ENGINES: TemplateEngineType[] = ['go-template', 'jsonnet']

// ============================================================================
// Config Loading
// ============================================================================

/**
 * Load a boilerplate.yml config from a template folder.
 * Ported from config.LoadBoilerplateConfig
 */
export function loadBoilerplateConfig(templateFolder: string): BoilerplateConfig {
  const configPath = path.join(templateFolder, BOILERPLATE_CONFIG_FILE)

  if (!fs.existsSync(configPath)) {
    throw new Error(
      `No boilerplate.yml found in "${templateFolder}". ` +
      `Please select a folder containing a boilerplate.yml configuration file.`
    )
  }

  const contents = fs.readFileSync(configPath, 'utf-8')
  return parseBoilerplateConfig(contents)
}

/**
 * Parse raw YAML contents into a BoilerplateConfig.
 * Ported from config.ParseBoilerplateConfig
 */
export function parseBoilerplateConfig(yamlContents: string): BoilerplateConfig {
  const fields = YAML.parse(yamlContents) || {}

  const requiredVersion = unmarshalString(fields, 'required_version')
  const variables = unmarshalVariables(fields)
  const dependencies = unmarshalDependencies(fields)
  const hooks = unmarshalHooks(fields)
  const partials = unmarshalListOfStrings(fields, 'partials')
  const skipFiles = unmarshalSkipFiles(fields)
  const engines = unmarshalEngines(fields)

  return {
    requiredVersion: requiredVersion ?? undefined,
    variables,
    dependencies,
    hooks,
    partials,
    skipFiles,
    engines,
  }
}

// ============================================================================
// Variable Unmarshaling - from variables/variables.go
// ============================================================================

function unmarshalVariables(fields: Record<string, unknown>): Variable[] {
  const rawVars = fields['variables']
  if (!rawVars || !Array.isArray(rawVars)) return []

  return rawVars.map((raw, index) => unmarshalVariable(raw as Record<string, unknown>, index))
}

function unmarshalVariable(fields: Record<string, unknown>, index: number): Variable {
  const name = requireString(fields, 'name', `variable[${index}]`)
  const type = unmarshalType(fields, name)
  const description = unmarshalString(fields, 'description') ?? ''
  const reference = unmarshalString(fields, 'reference') ?? undefined
  const order = typeof fields['order'] === 'number' ? fields['order'] : 0
  const options = unmarshalOptions(fields, name, type)
  const validations = unmarshalValidations(fields)
  const defaultValue = fields['default']

  return {
    name,
    description,
    type,
    default: defaultValue,
    reference,
    options,
    order,
    validations,
  }
}

function unmarshalType(fields: Record<string, unknown>, context: string): BoilerplateType {
  const typeStr = unmarshalString(fields, 'type')
  if (!typeStr) return 'string' // default

  if (!VALID_TYPES.includes(typeStr as BoilerplateType)) {
    throw new Error(`Invalid type "${typeStr}" for variable "${context}". Must be one of: ${VALID_TYPES.join(', ')}`)
  }

  return typeStr as BoilerplateType
}

function unmarshalOptions(
  fields: Record<string, unknown>,
  context: string,
  type: BoilerplateType
): string[] | undefined {
  const options = fields['options']
  if (!options) {
    if (type === 'enum') {
      throw new Error(`Variable "${context}" is of type enum but has no options defined`)
    }
    return undefined
  }

  if (!Array.isArray(options)) {
    throw new Error(`Options for variable "${context}" must be a list`)
  }

  return options.map(String)
}

// ============================================================================
// Validation Unmarshaling - from variables/yaml_helpers.go
// ============================================================================

function unmarshalValidations(fields: Record<string, unknown>): ValidationRule[] {
  const raw = fields['validations']
  if (!raw) return []

  // Validations can be a string (single rule) or a list
  if (typeof raw === 'string') {
    return parseValidationString(raw)
  }

  if (Array.isArray(raw)) {
    return raw.flatMap((r) => {
      if (typeof r === 'string') return parseValidationString(r)
      return []
    })
  }

  return []
}

function parseValidationString(ruleStr: string): ValidationRule[] {
  const rules: ValidationRule[] = []

  // Handle comma-separated rules
  const parts = ruleStr.split(',').map((s) => s.trim())

  for (const part of parts) {
    // Handle length-min-max pattern
    const lengthMatch = part.match(/^length-(\d+)-(\d+)$/)
    if (lengthMatch) {
      rules.push({
        type: 'length',
        message: `Must be between ${lengthMatch[1]} and ${lengthMatch[2]} characters`,
        args: [parseInt(lengthMatch[1]), parseInt(lengthMatch[2])],
      })
      continue
    }

    const validTypes: ValidationType[] = [
      'required',
      'email',
      'url',
      'alpha',
      'digit',
      'alphanumeric',
      'countrycode2',
      'semver',
    ]

    if (validTypes.includes(part as ValidationType)) {
      rules.push({
        type: part as ValidationType,
        message: getDefaultValidationMessage(part as ValidationType),
      })
    }
  }

  return rules
}

function getDefaultValidationMessage(type: ValidationType): string {
  switch (type) {
    case 'required':
      return 'This field is required'
    case 'email':
      return 'Must be a valid email address'
    case 'url':
      return 'Must be a valid URL'
    case 'alpha':
      return 'Must contain only letters'
    case 'digit':
      return 'Must contain only digits'
    case 'alphanumeric':
      return 'Must contain only letters and digits'
    case 'countrycode2':
      return 'Must be a valid ISO 3166 Alpha-2 country code'
    case 'semver':
      return 'Must be a valid semantic version'
    case 'length':
      return 'Invalid length'
    default:
      return 'Invalid value'
  }
}

// ============================================================================
// Dependency Unmarshaling - from variables/dependencies.go
// ============================================================================

function unmarshalDependencies(fields: Record<string, unknown>): Dependency[] {
  const rawDeps = fields['dependencies']
  if (!rawDeps || !Array.isArray(rawDeps)) return []

  const names = new Set<string>()
  return rawDeps.map((raw, index) => {
    const dep = unmarshalDependency(raw as Record<string, unknown>, index)
    if (names.has(dep.name)) {
      throw new Error(`Duplicate dependency name: ${dep.name}`)
    }
    names.add(dep.name)
    return dep
  })
}

function unmarshalDependency(fields: Record<string, unknown>, index: number): Dependency {
  const name = requireString(fields, 'name', `dependency[${index}]`)
  const templateUrl = requireString(fields, 'template-url', name)
  const outputFolder = requireString(fields, 'output-folder', name)
  const skip = unmarshalString(fields, 'skip') ?? undefined
  const dontInheritVariables = Boolean(fields['dont-inherit-variables'])
  const variables = unmarshalVariables(fields)
  const varFiles = unmarshalListOfStrings(fields, 'var_files')
  const forEach = unmarshalListOfStrings(fields, 'for_each')
  const forEachReference = unmarshalString(fields, 'for_each_reference') ?? undefined

  return {
    name,
    templateUrl,
    outputFolder,
    skip,
    dontInheritVariables,
    variables,
    varFiles,
    forEach,
    forEachReference,
  }
}

// ============================================================================
// Hook Unmarshaling - from variables/hooks.go
// ============================================================================

function unmarshalHooks(fields: Record<string, unknown>): Hooks {
  const hookFields = fields['hooks'] as Record<string, unknown> | undefined
  if (!hookFields) return { before: [], after: [] }

  return {
    before: unmarshalHookList(hookFields, 'before'),
    after: unmarshalHookList(hookFields, 'after'),
  }
}

function unmarshalHookList(fields: Record<string, unknown>, hookName: string): Hook[] {
  const rawHooks = fields[hookName]
  if (!rawHooks || !Array.isArray(rawHooks)) return []

  return rawHooks.map((raw) => unmarshalHook(raw as Record<string, unknown>, hookName))
}

function unmarshalHook(fields: Record<string, unknown>, hookName: string): Hook {
  const command = requireString(fields, 'command', hookName)
  const args = unmarshalListOfStrings(fields, 'args')
  const env = unmarshalMapOfStrings(fields, 'env')
  const workingDir = unmarshalString(fields, 'dir') ?? undefined
  const skip = unmarshalString(fields, 'skip') ?? undefined

  return { command, args, env, skip, workingDir }
}

// ============================================================================
// SkipFile Unmarshaling - from variables/skip_files.go
// ============================================================================

function unmarshalSkipFiles(fields: Record<string, unknown>): SkipFile[] {
  const rawSkipFiles = fields['skip_files']
  if (!rawSkipFiles || !Array.isArray(rawSkipFiles)) return []

  return rawSkipFiles.map((raw) => unmarshalSkipFile(raw as Record<string, unknown>))
}

function unmarshalSkipFile(fields: Record<string, unknown>): SkipFile {
  const pathVal = unmarshalString(fields, 'path') ?? ''
  const notPath = unmarshalString(fields, 'not_path') ?? ''
  const ifVal = unmarshalString(fields, 'if') ?? undefined

  if ((!pathVal && !notPath) || (pathVal && notPath)) {
    throw new Error('skip_files entry must have exactly one of "path" or "not_path"')
  }

  return { path: pathVal, notPath, if: ifVal }
}

// ============================================================================
// Engine Unmarshaling - from variables/engines.go
// ============================================================================

function unmarshalEngines(fields: Record<string, unknown>): Engine[] {
  const rawEngines = fields['engines']
  if (!rawEngines || !Array.isArray(rawEngines)) return []

  return rawEngines.map((raw) => unmarshalEngine(raw as Record<string, unknown>))
}

function unmarshalEngine(fields: Record<string, unknown>): Engine {
  const enginePath = requireString(fields, 'path', 'engine')
  const templateEngine = requireString(fields, 'template_engine', enginePath)

  if (!VALID_ENGINES.includes(templateEngine as TemplateEngineType)) {
    throw new Error(
      `"${templateEngine}" is not a valid template engine. Must be one of: ${VALID_ENGINES.join(', ')}`
    )
  }

  return { path: enginePath, templateEngine: templateEngine as TemplateEngineType }
}

// ============================================================================
// YAML Helper Functions - from variables/yaml_helpers.go
// ============================================================================

function unmarshalString(fields: Record<string, unknown>, fieldName: string): string | null {
  const val = fields[fieldName]
  if (val === undefined || val === null) return null
  return String(val)
}

function requireString(fields: Record<string, unknown>, fieldName: string, context: string): string {
  const val = unmarshalString(fields, fieldName)
  if (val === null || val === '') {
    throw new Error(`Missing required field "${fieldName}" in ${context}`)
  }
  return val
}

function unmarshalListOfStrings(fields: Record<string, unknown>, fieldName: string): string[] {
  const val = fields[fieldName]
  if (!val || !Array.isArray(val)) return []
  return val.map(String)
}

function unmarshalMapOfStrings(fields: Record<string, unknown>, fieldName: string): Record<string, string> {
  const val = fields[fieldName]
  if (!val || typeof val !== 'object' || Array.isArray(val)) return {}

  const result: Record<string, string> = {}
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
    result[k] = String(v)
  }
  return result
}
