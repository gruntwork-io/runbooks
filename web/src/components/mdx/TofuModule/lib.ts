/**
 * The values a <TofuModule> form holds, and how they become the inputs the
 * block publishes to the runbook.
 */
import type { BoilerplateConfig } from "@/types/boilerplateConfig"
import { BoilerplateVariableType } from "@/types/boilerplateVariable"
import { failedCheck } from "../../../../../src/domain/tofu-module/validations"
import type {
  TofuModuleInputKind,
  TofuModuleSpec,
  TofuModuleVariable,
} from "../../../../../src/domain/tofu-module/types"

export type FormValues = Record<string, unknown>

/** What a control shows while its input has no value. */
function emptyValue(kind: TofuModuleInputKind): unknown {
  switch (kind) {
    case "list":
      return []
    case "map":
      return {}
    case "bool":
      return false
    case "string":
    case "number":
    case "json":
      return ""
  }
}

/**
 * An input's starting value: its default from variables.tf. A JSON input
 * holds its text while the user edits it.
 */
export function startingValue(variable: TofuModuleVariable): unknown {
  if (variable.kind === "json") {
    return variable.hasDefault && variable.default !== null
      ? JSON.stringify(variable.default, null, 2)
      : ""
  }
  if (!variable.hasDefault || variable.default === null) return emptyValue(variable.kind)
  return variable.default
}

/** A published or saved value as the form holds it: a JSON input holds its text. */
export function formValue(variable: TofuModuleVariable, value: unknown): unknown {
  if (variable.kind !== "json") return value ?? emptyValue(variable.kind)
  if (typeof value === "string") return value
  return value === undefined || value === null ? "" : JSON.stringify(value, null, 2)
}

export function startingValues(spec: TofuModuleSpec): FormValues {
  return Object.fromEntries(spec.variables.map((v) => [v.name, startingValue(v)]))
}

/** Whether a value counts as given, for an input variables.tf requires. */
function isGiven(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false
  if (Array.isArray(value)) return value.length > 0
  return true
}

/** What's wrong with an input's value, or undefined when nothing is. */
export function fieldError(variable: TofuModuleVariable, value: unknown): string | undefined {
  if (!variable.hasDefault && !isGiven(value)) return "Required."
  if (variable.kind === "json" && typeof value === "string" && value.trim() !== "") {
    try {
      JSON.parse(value)
    } catch {
      return "Enter valid JSON."
    }
  }
  if (variable.kind === "number" && value !== "" && Number.isNaN(Number(value)))
    return "Enter a number."
  if (variable.kind === "string" && typeof value === "string" && variable.checks) {
    // An optional input left empty takes its default, which the module accepts.
    if (variable.hasDefault && value === "" && variable.default === "") return undefined
    return failedCheck(value, variable.checks)
  }
  if (variable.kind === "list" && Array.isArray(value) && variable.checks) {
    for (const item of value) {
      const error = failedCheck(String(item), variable.checks)
      if (error) return `${String(item)}: ${error}`
    }
  }
  return undefined
}

export function formErrors(spec: TofuModuleSpec, values: FormValues): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const variable of spec.variables) {
    const error = fieldError(variable, values[variable.name])
    if (error) errors[variable.name] = error
  }
  return errors
}

/** The value the block publishes for an input: JSON text parsed, numbers as numbers. */
export function publishedValue(variable: TofuModuleVariable, value: unknown): unknown {
  if (variable.kind === "json") {
    if (typeof value !== "string" || value.trim() === "") return null
    try {
      return JSON.parse(value)
    } catch {
      return null
    }
  }
  if (variable.kind === "number") return value === "" ? null : Number(value)
  return value
}

export function publishedValues(spec: TofuModuleSpec, values: FormValues): FormValues {
  return Object.fromEntries(spec.variables.map((v) => [v.name, publishedValue(v, values[v.name])]))
}

const BOILERPLATE_TYPES: Record<TofuModuleInputKind, BoilerplateVariableType> = {
  string: BoilerplateVariableType.String,
  number: BoilerplateVariableType.Float,
  bool: BoilerplateVariableType.Bool,
  list: BoilerplateVariableType.List,
  map: BoilerplateVariableType.Map,
  json: BoilerplateVariableType.String,
}

/**
 * The module's inputs in the shape the runbook's input registry keeps, so a
 * <Template> or <Command> can use them through `inputsId`, as it does an
 * <Inputs> block's.
 */
export function registryConfig(spec: TofuModuleSpec): BoilerplateConfig {
  return {
    variables: spec.variables.map((v) => ({
      name: v.name,
      description: v.description,
      type: BOILERPLATE_TYPES[v.kind],
      default: publishedValue(v, startingValue(v)),
      required: !v.hasDefault,
      ...(v.sensitive ? { sensitive: true } : {}),
    })),
  }
}
