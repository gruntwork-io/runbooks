import { useEffect, useMemo, useRef } from "react"
import {
  extractTemplateDependenciesFromString,
  requireAllOutputs,
} from "@/lib/extractTemplateDependencies"
import { resolveTemplateReferences } from "@/lib/templateUtils"
import type { TfModuleVariable } from "../../../../../../src/domain/tf-module/types"
import { useTemplateDependencies } from "../../_shared/hooks/useTemplateDependencies"
import { prefilledValue } from "../lib"

interface PrefilledVariableProps {
  variable: TfModuleVariable
  /** A literal value, or a string template over other blocks' outputs. */
  value: unknown
  /** What the input holds now. */
  current: unknown
  /** Whether the input holds only its starting value, so filling it overwrites nothing. */
  fillable: boolean
  /** Puts the value in the input, and returns what the input then holds. */
  onFill: (value: unknown) => unknown
}

/**
 * Fills an input with a value the runbook gives it through the block's
 * `prefilledVariables` prop, such as `{{ .outputs.apply_group.email }}`, once
 * every output the value reads exists. It fills each value it resolves to
 * once, so an input the user clears stays clear until the outputs give
 * another value, as after applying a step again. A new value replaces the
 * last one it filled, but never what the user typed.
 */
export function PrefilledVariable({
  variable,
  value,
  current,
  fillable,
  onFill,
}: PrefilledVariableProps) {
  const template = typeof value === "string" ? value : undefined
  const deps = useMemo(
    () => (template ? requireAllOutputs(extractTemplateDependenciesFromString(template)) : []),
    [template],
  )
  const { hasAllDependencies, inputs, outputs } = useTemplateDependencies(deps)
  const resolved =
    template === undefined
      ? value
      : hasAllDependencies
        ? resolveTemplateReferences(template, { inputs, outputs })
        : undefined
  const prefill = resolved === undefined ? undefined : prefilledValue(variable, resolved)
  const fill = prefill && "value" in prefill ? prefill.value : undefined
  const key = fill === undefined || fill === "" ? "" : JSON.stringify(fill)
  const filled = useRef("")
  // What the input held after this component last filled it.
  const left = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (!key || filled.current === key) return
    filled.current = key
    if (fillable || (left.current !== undefined && JSON.stringify(current) === left.current)) {
      left.current = JSON.stringify(onFill(fill))
    }
    // Fills when the resolved value changes, not when the input does.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  if (prefill && "error" in prefill) {
    return (
      <p className="m-0 text-sm text-destructive" role="alert">
        {prefill.error}
      </p>
    )
  }
  return null
}
