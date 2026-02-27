/**
 * Shared utility functions for template rendering and output dependency tracking.
 * Used by Template, TemplateInline, useScriptExecution, GitClone, and other blocks.
 */

import type { BlockOutputs, TemplateValue } from '@/contexts/RunbookContext'
import { BoilerplateVariableType } from '@/types/boilerplateVariable'
import type { OutputDependency } from '@/lib/extractTemplateDependencies'
import { normalizeBlockId } from '@/lib/utils'

// --- Shared types for the new inputs/outputs architecture ---

/** A variable name from an Inputs block (e.g., "region", "env") */
export type InputName = string

/** The resolved value of an input variable (string, number, boolean, etc.) */
export type TemplateInputValue = unknown

/** A normalized block ID (e.g., "create_account") */
export type BlockId = string

/** An output key produced by a Command/Check block (e.g., "account_id") */
export type OutputName = string

/** The string value of a block output (always string — parsed from stdout key=value) */
export type OutputValue = string

/** Flattened input values. Matches {{ .inputs.<InputName> }} */
export type TemplateInputs = Record<InputName, TemplateInputValue>

/** Flattened output values. Matches {{ .outputs.<BlockId>.<OutputName> }} */
export type TemplateOutputs = Record<BlockId, Record<OutputName, OutputValue>>

/** The template data context — mirrors the Go template engine's dot context */
export interface TemplateContext {
  inputs: TemplateInputs
  outputs: TemplateOutputs
}

/** A block and the specific outputs referenced from it */
export interface BlockOutput {
  blockId: BlockId
  outputNames: OutputName[]
}

/**
 * Build the TemplateValue[] payload for /api/boilerplate/render-inline.
 * Wraps both namespaces as Map-typed entries — the Go template engine navigates them
 * via {{ .inputs.X }} and {{ .outputs.X.Y }}.
 */
export function buildTemplatePayload(ctx: TemplateContext): TemplateValue[] {
  return [
    { name: 'inputs', type: BoilerplateVariableType.Map, value: ctx.inputs },
    { name: 'outputs', type: BoilerplateVariableType.Map, value: ctx.outputs },
  ]
}

/**
 * Check if any numeric input has an empty string value.
 * This only applies to Int and Float types — when the user clears a number
 * field before typing a new value, the value is briefly "". Sending that to
 * render-inline causes a backend error (strconv.Atoi("") / ParseFloat("")).
 *
 * String types are NOT checked because "" is a valid string value.
 * Bool, List, Map, and Enum never produce empty strings from their controls.
 */
export function hasEmptyNumericInputs(inputs: TemplateValue[]): boolean {
  return inputs.some(
    i => (i.type === BoilerplateVariableType.Int || i.type === BoilerplateVariableType.Float) && i.value === ''
  )
}

/**
 * Compute which output dependencies are not yet satisfied.
 * Groups dependencies by block, normalizes IDs for lookup, and returns
 * the list of blocks/outputs that haven't been produced yet.
 */
export function computeUnmetOutputDependencies(
  outputDependencies: OutputDependency[],
  allOutputs: Record<string, BlockOutputs>
): BlockOutput[] {
  if (outputDependencies.length === 0) return []

  const byBlock = groupDependenciesByBlock(outputDependencies)
  const unmet: BlockOutput[] = []

  for (const [blockId, outputNames] of byBlock) {
    const normalizedId = normalizeBlockId(blockId)
    const blockData = allOutputs[normalizedId]

    if (!blockData) {
      // Block hasn't produced any outputs yet - preserve original blockId for display
      unmet.push({ blockId, outputNames })
    } else {
      const missingOutputs = outputNames.filter(name => !(name in blockData.values))
      if (missingOutputs.length > 0) {
        unmet.push({ blockId, outputNames: missingOutputs })
      }
    }
  }

  return unmet
}

/**
 * Flatten block outputs by stripping the .values wrapper.
 * Transforms Record<string, BlockOutputs> → TemplateOutputs.
 * Used inside useTemplateDependencies to provide callers with the flat format
 * matching {{ .outputs.*.* }} template expressions.
 */
export function flattenBlockOutputs(
  allOutputs: Record<string, BlockOutputs>
): TemplateOutputs {
  const result: TemplateOutputs = {}
  for (const [blockId, data] of Object.entries(allOutputs)) {
    result[blockId] = data.values
  }
  return result
}

/**
 * Returns input dependency names that don't have values yet.
 * Mirrors computeUnmetOutputDependencies — same pattern, same naming.
 * Returns an empty array when deps is empty (no dependencies to check).
 */
export function computeUnmetInputDependencies(
  deps: InputName[],
  inputs: TemplateInputs
): InputName[] {
  return deps.filter(name => {
    const value = inputs[name]
    return value === undefined || value === null || value === ''
  })
}

/**
 * Filter unmet output dependencies to only those matching specific output-level deps.
 * Used by blocks that distinguish blocking vs non-blocking dependencies (GitClone,
 * GitHubPullRequest) to narrow the unmet list to only outputs referenced by blocking props.
 */
export function filterUnmetOutputDeps(
  allUnmetOutputDeps: BlockOutput[],
  targetOutputDeps: OutputDependency[]
): BlockOutput[] {
  return allUnmetOutputDeps
    .map(dep => {
      const blockingNames = targetOutputDeps
        .filter(bd => bd.blockId === dep.blockId)
        .map(bd => bd.outputName)
      const matchedNames = dep.outputNames.filter(n => blockingNames.includes(n))
      return matchedNames.length > 0 ? { ...dep, outputNames: matchedNames } : null
    })
    .filter((dep): dep is NonNullable<typeof dep> => dep !== null)
}

/**
 * Resolve {{ .inputs.X }} and {{ .outputs.X.Y }} expressions in a string.
 * Client-side string resolver for blocks that don't go through the Go template engine
 * (e.g., GitClone prefilled props, GitHubPullRequest title/body).
 */
export function resolveTemplateReferences(
  text: string,
  ctx: TemplateContext
): string {
  if (!text) return text
  return text.replace(
    /\{\{-?\s*\.(inputs|outputs)\.([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*)\s*(?:\|[^}]*)?\s*-?\}\}/g,
    (match, namespace, path) => {
      if (namespace === 'inputs') {
        const value = ctx.inputs[path]
        return value != null ? String(value) : `\`${match}\``
      }
      if (namespace === 'outputs') {
        const dotIdx = path.indexOf('.')
        if (dotIdx > 0) {
          const blockId = normalizeBlockId(path.slice(0, dotIdx))
          const outputName = path.slice(dotIdx + 1)
          return ctx.outputs[blockId]?.[outputName] ?? `\`${match}\``
        }
      }
      return `\`${match}\``
    }
  )
}

// --- Internal helpers ---

/**
 * Group output dependencies by block ID.
 */
function groupDependenciesByBlock(dependencies: OutputDependency[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>()

  for (const dep of dependencies) {
    const existing = grouped.get(dep.blockId) || []
    if (!existing.includes(dep.outputName)) {
      existing.push(dep.outputName)
    }
    grouped.set(dep.blockId, existing)
  }

  return grouped
}
