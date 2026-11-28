/**
 * Conditional fields: a variable's `x-show-when`.
 *
 * A variable with `x-show-when: { OtherVar: value | [values] }` shows only
 * while every condition holds. A hidden one isn't asked for: it isn't
 * validated, and the block uses its default instead of what was entered
 * before it was hidden. Both the form (web/) and the `runbooks test` CLI use
 * this module, so they agree on which fields count. The renderer bundles it
 * directly, so it must stay free of Node and Electron imports.
 */

import { untouchedValue, type UntouchedValueVariable } from "./untouchedValue.ts"

/** The values each variable a field depends on must have for it to show, by variable name. */
type ShowWhen = Record<string, string[]>

/**
 * The parts of a boilerplate variable this module reads. Typed structurally so
 * the renderer's BoilerplateVariable fits as well.
 */
export interface ShowWhenVariable extends UntouchedValueVariable {
  name: string
  default?: unknown
  showWhen?: Readonly<Record<string, readonly string[]>>
}

/**
 * The value of a hidden variable without a default: what its control shows
 * empty (false for a bool, blank elements for a tuple), else an empty value of
 * its type. Never nothing, as a render fails on a variable that has no value.
 */
export function emptyValue(variable: ShowWhenVariable): unknown {
  const untouched = untouchedValue(variable)
  if (untouched !== undefined) return untouched
  switch (variable.type) {
    case "list":
      return []
    case "map":
      return {}
    case "int":
    case "float":
      return 0
    default:
      return ""
  }
}

/** What a hidden variable's value is: its default, else an empty value. */
const configDefault = (variable: ShowWhenVariable): unknown =>
  variable.default ?? emptyValue(variable)

/** A condition's value as the field's value is compared with it. */
const conditionValue = (value: unknown): string | undefined =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : undefined

/**
 * Parse a variable's `x-show-when`: a mapping of variable names to a value, or
 * a list of values any of which matches. Values are compared as strings, so
 * `Enabled: true` matches a bool that is true. Returns undefined for no
 * conditions, and a problem for a malformed one.
 */
export function parseShowWhen(raw: unknown): { showWhen?: ShowWhen; problem?: string } {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { problem: "x-show-when must map variable names to values" }
  }
  const showWhen: Record<string, string[]> = {}
  for (const [name, accepted] of Object.entries(raw)) {
    const list: unknown[] = Array.isArray(accepted) ? accepted : [accepted]
    const values = list.map(conditionValue)
    if (values.length === 0 || values.some((value) => value === undefined)) {
      return {
        problem: `x-show-when gives ${name} a value that isn't a string, number or true/false, or a list of them`,
      }
    }
    showWhen[name] = values as string[]
  }
  return Object.keys(showWhen).length > 0 ? { showWhen } : {}
}

/** Whether a field's value meets a condition. A list (a multi-select) does when any element does. */
function meets(value: unknown, accepted: readonly string[]): boolean {
  if (Array.isArray(value)) return value.some((element) => meets(element, accepted))
  const compared = conditionValue(value)
  return compared !== undefined && accepted.includes(compared)
}

/**
 * The names of the variables `x-show-when` hides, given the form's values.
 * A condition on a variable that is itself hidden sees that variable's
 * default (defaultOf), as the block does. A condition naming a variable the
 * form doesn't have doesn't hide the field, and nor does a cycle: both are
 * configuration errors (showWhenProblems), and a field nobody can see would
 * be lost silently.
 */
export function hiddenVariables<T extends ShowWhenVariable>(
  variables: readonly T[],
  values: Readonly<Record<string, unknown>>,
  defaultOf: (variable: T) => unknown = configDefault,
): Set<string> {
  const byName = new Map(variables.map((variable) => [variable.name, variable]))
  const shown = new Map<string, boolean>()
  const resolving = new Set<string>()

  const isShown = (variable: T): boolean => {
    const known = shown.get(variable.name)
    if (known !== undefined) return known
    if (!variable.showWhen || resolving.has(variable.name)) return true

    resolving.add(variable.name)
    const result = Object.entries(variable.showWhen).every(([name, accepted]) => {
      const other = byName.get(name)
      if (!other) return true
      return meets(isShown(other) ? values[name] : defaultOf(other), accepted)
    })
    resolving.delete(variable.name)
    shown.set(variable.name, result)
    return result
  }

  return new Set(variables.filter((variable) => !isShown(variable)).map((v) => v.name))
}

/** The values with each hidden variable's replaced by its default (defaultOf). */
export function withHiddenDefaults<T extends ShowWhenVariable>(
  variables: readonly T[],
  values: Readonly<Record<string, unknown>>,
  hidden: ReadonlySet<string>,
  defaultOf: (variable: T) => unknown = configDefault,
): Record<string, unknown> {
  if (hidden.size === 0) return { ...values }
  const result: Record<string, unknown> = { ...values }
  for (const variable of variables) {
    if (hidden.has(variable.name)) result[variable.name] = defaultOf(variable)
  }
  return result
}

/**
 * A configuration error in a field's `x-show-when`: the field it is on, the
 * condition at fault (none for a cycle), and what is wrong, naming the field.
 */
export interface ShowWhenProblem {
  readonly variable: string
  readonly condition?: string
  /** A clause, lowercase, with no closing period. */
  readonly message: string
}

/**
 * The configuration errors in the form's `x-show-when` conditions: a
 * condition on a variable the form doesn't have, a value that isn't one of
 * the variable's options, and conditions that depend on each other in a
 * cycle, which is on the first variable in it.
 */
export function showWhenProblems(variables: readonly ShowWhenVariable[]): ShowWhenProblem[] {
  const byName = new Map(variables.map((variable) => [variable.name, variable]))
  const problems: ShowWhenProblem[] = []

  for (const variable of variables) {
    for (const [name, accepted] of Object.entries(variable.showWhen ?? {})) {
      const other = byName.get(name)
      const on = `the \`x-show-when\` of the field "${variable.name}"`
      if (!other) {
        problems.push({
          variable: variable.name,
          condition: name,
          message: `${on} names "${name}", which is no field here`,
        })
        continue
      }
      const options = other.options?.map(String)
      if (!options || options.length === 0) continue
      for (const value of accepted) {
        if (!options.includes(value)) {
          problems.push({
            variable: variable.name,
            condition: name,
            message: `${on} gives "${name}" the value "${value}", which is not one of its options (${options.join(", ")})`,
          })
        }
      }
    }
  }

  // A cycle: a field whose conditions lead back to it
  const done = new Set<string>()
  const path: string[] = []
  const visit = (name: string): void => {
    if (done.has(name)) return
    const start = path.indexOf(name)
    if (start >= 0) {
      const cycle = [...path.slice(start), name]
      problems.push({
        variable: cycle[0]!,
        message: `the \`x-show-when\` conditions of these fields depend on each other in a cycle: ${cycle.join(" → ")}`,
      })
      return
    }
    path.push(name)
    for (const other of Object.keys(byName.get(name)?.showWhen ?? {})) {
      if (byName.has(other)) visit(other)
    }
    path.pop()
    done.add(name)
  }
  for (const variable of variables) visit(variable.name)

  return problems
}
