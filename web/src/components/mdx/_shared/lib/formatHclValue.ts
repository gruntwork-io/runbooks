import type { BoilerplateConfig } from '@/types/boilerplateConfig'
import { BoilerplateVariableType } from '@/types/boilerplateVariable'

/**
 * Formats a value as an HCL literal string based on its boilerplate variable type.
 * Used by TfModule to build the _module.hcl_inputs map so templates can iterate
 * over variables with proper HCL formatting without needing a custom template function.
 *
 * - string/enum → "value" (JSON-quoted)
 * - bool → true/false
 * - int/float → numeric literal
 * - list/map → JSON encoding (valid HCL for value expressions)
 */
export function formatHclValue(value: unknown, type: BoilerplateVariableType): string {
  switch (type) {
    case BoilerplateVariableType.Bool:
      return value === true || value === 'true' ? 'true' : 'false'

    case BoilerplateVariableType.Int:
    case BoilerplateVariableType.Float:
      if (typeof value === 'number') return String(value)
      if (typeof value === 'string' && value !== '') {
        const num = Number(value)
        if (!isNaN(num)) return String(num)
      }
      return '0'

    case BoilerplateVariableType.List:
    case BoilerplateVariableType.Map:
      if (typeof value === 'string') {
        // Already a JSON string from the form
        try {
          JSON.parse(value)
          return value
        } catch {
          return JSON.stringify(value)
        }
      }
      return JSON.stringify(value)

    case BoilerplateVariableType.String:
    case BoilerplateVariableType.Enum:
    default:
      return JSON.stringify(String(value ?? ''))
  }
}

import type { BoilerplateVariable } from '@/types/boilerplateVariable'

/** Pre-builds a name→variable lookup map to avoid O(n) scans per variable. */
function buildVarLookup(config: BoilerplateConfig | null): Map<string, BoilerplateVariable> {
  return new Map(config?.variables.map(v => [v.name, v]) ?? [])
}

/**
 * Core implementation: builds a map of variable name → HCL-formatted string value.
 * When skipDefaults is true, excludes variables whose current value matches their
 * declared default (useful for idiomatic Terragrunt configs).
 */
function buildHclInputsCore(
  formData: Record<string, unknown>,
  config: BoilerplateConfig | null,
  skipDefaults: boolean
): Record<string, string> {
  const varMap = buildVarLookup(config)
  const hclInputs: Record<string, string> = {}

  for (const [name, value] of Object.entries(formData)) {
    const varDef = varMap.get(name)
    const type = varDef?.type ?? BoilerplateVariableType.String
    const hclValue = formatHclValue(value, type)

    if (skipDefaults && varDef != null && !varDef.required) {
      const hclDefault = formatHclValue(varDef.default, type)
      if (hclValue === hclDefault) continue
    }

    hclInputs[name] = hclValue
  }
  return hclInputs
}

/**
 * Builds a map of variable name → HCL-formatted string value, excluding variables
 * whose current value matches their declared default. Required variables (no default)
 * are always included. This is useful for idiomatic Terragrunt where you only declare
 * variables that differ from module defaults.
 */
export function buildNonDefaultHclInputsMap(
  formData: Record<string, unknown>,
  config: BoilerplateConfig | null
): Record<string, string> {
  return buildHclInputsCore(formData, config, true)
}

/**
 * Builds a map of variable name → HCL-formatted string value.
 * Used to populate _module.hcl_inputs for template iteration.
 * Accepts a BoilerplateConfig to look up variable types.
 */
export function buildHclInputsMap(
  formData: Record<string, unknown>,
  config: BoilerplateConfig | null
): Record<string, string> {
  return buildHclInputsCore(formData, config, false)
}
