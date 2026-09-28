import type { BoilerplateVariable } from '@/types/boilerplateVariable'
import { BoilerplateVariableType } from '@/types/boilerplateVariable'

/** A tuple schema's element keys ("0", "1", ...) in element order. */
export function tupleElementKeys(schema: Record<string, string>): string[] {
  return Object.keys(schema).sort((a, b) => Number(a) - Number(b))
}

/** What a tuple element shows before it is set: false for a bool element (its select), '' otherwise. */
export function untouchedTupleElement(elementType: string | undefined): '' | false {
  return elementType === 'bool' ? false : ''
}

/**
 * The value a variable's control shows while the variable has no value, for
 * the types whose control shows one: form state starts from it, so an
 * untouched field never looks filled in while nothing is sent for it.
 *   - bool: false (an unchecked checkbox)
 *   - tuple (a list with a schema, see FormControl): one untouched element per
 *     schema key
 *   - anything else: undefined (its control shows empty)
 */
export function untouchedValue(variable: BoilerplateVariable): unknown {
  if (variable.type === BoilerplateVariableType.Bool) return false
  const { schema, options } = variable
  const isTuple =
    variable.type === BoilerplateVariableType.List &&
    !(options && options.length > 0) &&
    schema !== undefined &&
    Object.keys(schema).length > 0
  if (isTuple) {
    return tupleElementKeys(schema).map(k => untouchedTupleElement(schema[k]))
  }
  return undefined
}
