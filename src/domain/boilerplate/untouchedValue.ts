/**
 * The value a boilerplate variable's form control shows before it is set.
 *
 * Both the form (web/) and the `runbooks test` CLI start an unset variable
 * from its default, else from this value, so a runbook that works in the app
 * without touching a field also passes its test. The renderer bundles this
 * module directly, so it must stay free of Node and Electron imports.
 */

/**
 * The parts of a boilerplate variable that untouchedValue reads. Typed
 * structurally so the renderer's enum-typed BoilerplateVariable fits as well.
 */
export interface UntouchedValueVariable {
  type: string
  options?: readonly unknown[]
  schema?: Record<string, string>
}

/** A tuple schema's element keys ("0", "1", ...) in element order. */
export function tupleElementKeys(schema: Record<string, string>): string[] {
  return Object.keys(schema).sort((a, b) => Number(a) - Number(b))
}

/** What a tuple element shows before it is set: false for a bool element (its select), "" otherwise. */
export function untouchedTupleElement(elementType: string | undefined): "" | false {
  return elementType === "bool" ? false : ""
}

/**
 * The value a variable's control shows while the variable has no value, for
 * the types whose control shows one: form state starts from it, so an
 * untouched field never looks filled in while nothing is sent for it.
 *   - bool: false (an unchecked checkbox)
 *   - tuple (a list with a schema and no options, which the form's
 *     FormControl renders as a TupleInput): one untouched element per schema key
 *   - anything else: undefined (its control shows empty)
 */
export function untouchedValue(variable: UntouchedValueVariable): unknown {
  if (variable.type === "bool") return false
  const { schema, options } = variable
  const isTuple =
    variable.type === "list" &&
    !(options && options.length > 0) &&
    schema !== undefined &&
    Object.keys(schema).length > 0
  if (isTuple) {
    return tupleElementKeys(schema).map((k) => untouchedTupleElement(schema[k]))
  }
  return undefined
}
