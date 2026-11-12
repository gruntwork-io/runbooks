import { useEffect, useMemo, useRef } from "react"
import {
  extractTemplateDependenciesFromString,
  requireAllOutputs,
} from "@/lib/extractTemplateDependencies"
import { resolveTemplateReferences } from "@/lib/templateUtils"
import { useTemplateDependencies } from "../../_shared/hooks/useTemplateDependencies"

interface PrefilledVariableProps {
  /** A literal value, or a string template over other blocks' outputs. */
  value: unknown
  /** Whether the input holds only its starting value, so filling it overwrites nothing. */
  fillable: boolean
  onFill: (value: unknown) => void
}

/**
 * Fills an input with a value the runbook gives it through the block's
 * `prefilledVariables` prop, such as `{{ .outputs.apply_group.email }}`, once
 * every output the value reads exists. It fills each value it resolves to
 * once, so an input the user clears stays clear until the outputs give
 * another value, as after applying a step again.
 */
export function PrefilledVariable({ value, fillable, onFill }: PrefilledVariableProps) {
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
  const key = resolved === undefined || resolved === "" ? "" : JSON.stringify(resolved)
  const filled = useRef("")

  useEffect(() => {
    if (!key || filled.current === key) return
    filled.current = key
    if (fillable) onFill(resolved)
    // Fills when the resolved value changes, not when the input does.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return null
}
