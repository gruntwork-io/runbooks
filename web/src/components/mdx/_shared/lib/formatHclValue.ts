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

/**
 * Builds a map of variable name → HCL-formatted string value.
 * Used to populate _module.hcl_inputs for template iteration.
 */
export function buildHclInputsMap(
  formData: Record<string, unknown>,
  variableTypes: Map<string, BoilerplateVariableType>
): Record<string, string> {
  const hclInputs: Record<string, string> = {}
  for (const [name, value] of Object.entries(formData)) {
    const type = variableTypes.get(name) ?? BoilerplateVariableType.String
    hclInputs[name] = formatHclValue(value, type)
  }
  return hclInputs
}
