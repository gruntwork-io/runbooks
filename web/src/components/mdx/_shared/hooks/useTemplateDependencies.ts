/**
 * useTemplateDependencies — Unified hook for resolving template dependencies.
 *
 * This hook only *resolves* dependencies — it doesn't parse them. Extraction is done
 * by the caller using extractTemplateDependenciesFromString (or similar), giving each
 * block full control over which props contribute dependencies.
 *
 * Returns flattened values matching the template namespaces ({{ .inputs.* }}, {{ .outputs.*.* }})
 * plus readiness state and unmet dependency lists for warning display.
 *
 * @example
 * ```tsx
 * const deps = useMemo(() => extractTemplateDependenciesFromString(command), [command])
 * const { hasAllDependencies, unmetInputDeps, unmetOutputDeps, inputs, outputs } =
 *   useTemplateDependencies(deps, inputsId)
 * ```
 */

import { useMemo } from 'react'
import { useInputs, useAllOutputs, flattenInputs } from '@/contexts/useRunbook'
import {
  flattenBlockOutputs,
  computeUnmetInputDependencies,
  computeUnmetOutputDependencies,
} from '@/lib/templateUtils'
import type {
  InputName,
  TemplateInputs,
  TemplateOutputs,
  BlockOutput,
} from '@/lib/templateUtils'
import { splitDependencies } from '@/lib/extractTemplateDependencies'
import type { TemplateDependency } from '@/lib/extractTemplateDependencies'

export interface UseTemplateDependenciesResult {
  /** Flattened input values — matches {{ .inputs.* }} */
  inputs: TemplateInputs
  /** Flattened output values — matches {{ .outputs.*.* }} */
  outputs: TemplateOutputs
  /** Input dependency names that don't have values yet */
  unmetInputDeps: InputName[]
  /** Output dependencies that haven't been produced yet */
  unmetOutputDeps: BlockOutput[]
  /** True when all dependencies are satisfied (both inputs and outputs) */
  hasAllDependencies: boolean
}

/**
 * Resolves template dependencies against the shared RunbookContext.
 *
 * Flattens raw storage formats internally:
 * - InputValue[] (from useInputs) → flattenInputs → TemplateInputs
 * - Record<string, BlockOutputs> (from useAllOutputs) → flattenBlockOutputs → TemplateOutputs
 *
 * Callers never see the raw storage formats — they get flat maps matching the
 * template namespace structure.
 */
export function useTemplateDependencies(
  dependencies: TemplateDependency[],
  inputsId?: string | string[]
): UseTemplateDependenciesResult {
  // 1. Read and flatten values from context
  const rawInputs = useInputs(inputsId)
  const inputs = useMemo(() => flattenInputs(rawInputs), [rawInputs])

  const rawOutputs = useAllOutputs()
  const outputs = useMemo(() => flattenBlockOutputs(rawOutputs), [rawOutputs])

  // 2. Split mixed deps into typed groups (one split, used by both checkers)
  const { inputs: inputDeps, outputs: outputDeps } = useMemo(
    () => splitDependencies(dependencies),
    [dependencies]
  )

  // 3. Compute unmet deps — symmetric pair of functions
  const unmetInputDeps = useMemo(
    () => computeUnmetInputDependencies(inputDeps, inputs),
    [inputDeps, inputs]
  )

  const unmetOutputDeps = useMemo(
    () => computeUnmetOutputDependencies(outputDeps, rawOutputs),
    [outputDeps, rawOutputs]
  )

  // 4. Derive readiness from unmet lists
  const hasAllDependencies = unmetInputDeps.length === 0 && unmetOutputDeps.length === 0

  return { inputs, outputs, unmetInputDeps, unmetOutputDeps, hasAllDependencies }
}
