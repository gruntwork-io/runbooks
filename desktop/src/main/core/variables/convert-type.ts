// ============================================================================
// Type conversion - Ported from variables/variables.go:ConvertType
// ============================================================================

import type { Variable, BoilerplateType } from '../../../shared/types'

/**
 * Convert a value to the expected type for a variable.
 * Ported from variables.ConvertType
 */
export function convertType(value: unknown, variable: Variable): unknown {
  if (value === null || value === undefined) return null

  const asString = typeof value === 'string' ? value : null

  switch (variable.type) {
    case 'string':
      if (typeof value === 'string') return value
      if (typeof value === 'number') return String(value)
      if (typeof value === 'boolean') return String(value)
      return String(value)

    case 'int':
      if (typeof value === 'number' && Number.isInteger(value)) return value
      if (asString !== null) {
        const parsed = parseInt(asString, 10)
        if (isNaN(parsed)) throw new InvalidVariableValue(variable, value)
        return parsed
      }
      if (typeof value === 'number') return Math.round(value)
      break

    case 'float':
      if (typeof value === 'number') return value
      if (asString !== null) {
        const parsed = parseFloat(asString)
        if (isNaN(parsed)) throw new InvalidVariableValue(variable, value)
        return parsed
      }
      break

    case 'bool':
      if (typeof value === 'boolean') return value
      if (asString !== null) {
        if (asString === 'true' || asString === '1') return true
        if (asString === 'false' || asString === '0') return false
        throw new InvalidVariableValue(variable, value)
      }
      break

    case 'list':
      if (Array.isArray(value)) return value
      if (asString !== null) return parseStringAsList(asString)
      break

    case 'map':
      if (typeof value === 'object' && !Array.isArray(value)) return value
      if (asString !== null) return parseStringAsMap(asString)
      break

    case 'enum':
      if (asString !== null && variable.options) {
        if (variable.options.includes(asString)) return asString
      }
      throw new InvalidVariableValue(variable, value)
  }

  throw new InvalidVariableValue(variable, value)
}

/**
 * Parse a string as a list (JSON or Go format).
 */
function parseStringAsList(str: string): string[] {
  // Try JSON first
  try {
    const parsed = JSON.parse(str)
    if (Array.isArray(parsed)) return parsed.map(String)
  } catch {
    // Not JSON
  }

  // Try Go list format: [value1 value2 value3]
  const match = str.match(/^\[(.*)\]$/)
  if (match) {
    const items = match[1].trim()
    if (items === '') return []
    return items.split(/\s+/)
  }

  throw new Error(`Cannot parse "${str}" as a list`)
}

/**
 * Parse a string as a map (JSON or Go format).
 */
function parseStringAsMap(str: string): Record<string, string> {
  // Try JSON first
  try {
    const parsed = JSON.parse(str)
    if (typeof parsed === 'object' && !Array.isArray(parsed)) {
      const result: Record<string, string> = {}
      for (const [k, v] of Object.entries(parsed)) {
        result[k] = String(v)
      }
      return result
    }
  } catch {
    // Not JSON
  }

  // Try Go map format: map[key1:value1 key2:value2]
  const match = str.match(/^map\[(.*)\]$/)
  if (match) {
    const items = match[1].trim()
    if (items === '') return {}
    const result: Record<string, string> = {}
    for (const pair of items.split(/\s+/)) {
      const colonIdx = pair.lastIndexOf(':')
      if (colonIdx === -1) throw new Error(`Invalid map entry: ${pair}`)
      result[pair.slice(0, colonIdx)] = pair.slice(colonIdx + 1)
    }
    return result
  }

  throw new Error(`Cannot parse "${str}" as a map`)
}

class InvalidVariableValue extends Error {
  constructor(variable: Variable, value: unknown) {
    super(
      `Invalid value "${value}" for variable "${variable.name}" of type "${variable.type}"`
    )
    this.name = 'InvalidVariableValue'
  }
}

/**
 * Convert variables map to proper types based on config.
 */
export function convertVariablesToTypes(
  variables: Record<string, unknown>,
  configVariables: Variable[]
): Record<string, unknown> {
  const varMap = new Map(configVariables.map((v) => [v.name, v]))
  const result = { ...variables }

  for (const [name, value] of Object.entries(result)) {
    const variable = varMap.get(name)
    if (variable && value !== undefined && value !== null) {
      try {
        result[name] = convertType(value, variable)
      } catch {
        // Keep original value if conversion fails
      }
    }
  }

  return result
}
