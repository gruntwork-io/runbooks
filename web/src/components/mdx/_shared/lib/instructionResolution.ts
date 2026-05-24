/**
 * Pure helpers for resolving a runbook command into a flattened, copy-pasteable
 * instruction (instruction mode). See plans/non-interactive-mode-spec.md §5/§6.5.
 *
 * The mode runs nothing, so a command's `{{ .outputs.<id>.<key> }}` references
 * can't be computed from app state. Instead we auto-detect them, prompt the user
 * for each value, and merge their entries into the variables map alongside the
 * `Inputs`-form values, then resolve the whole command in one pass.
 *
 * These helpers are intentionally side-effect-free and framework-agnostic so the
 * resolution rules can be unit-tested without React.
 */

import {
  extractTemplateDependenciesFromString,
  splitDependencies,
} from '@/lib/extractTemplateDependencies'
import {
  resolveTemplateReferences,
  type TemplateContext,
  type TemplateOutputs,
} from '@/lib/templateUtils'
import { normalizeBlockId } from '@/lib/utils'

/**
 * A synthesized prompt for an `{{ .outputs.<id>.<key> }}` reference the app can't
 * resolve on its own. The user pastes the value they got by running the earlier
 * step by hand.
 */
export interface ManualFieldSpec {
  /** Stable id for the field — the normalized template path (e.g. "outputs.create_account.account_id"). */
  id: string
  /** Original (un-normalized) block id as written in the command (e.g. "create-account"). */
  blockId: string
  /** Output key produced by that block (e.g. "account_id"). */
  outputName: string
  /** Human label, e.g. "account_id — output of step create-account" (PRD Q3 default). */
  label: string
}

/**
 * Scan a command for distinct `{{ .outputs.<id>.<key> }}` references and
 * synthesize one manual field per reference. `{{ .inputs.* }}` references are
 * NOT collected — those come from the still-functional Inputs forms (§6.5.1).
 */
export function detectManualFields(
  command: string | string[] | undefined,
): ManualFieldSpec[] {
  const texts = normalizeCommandList(command)
  const seen = new Set<string>()
  const fields: ManualFieldSpec[] = []

  for (const text of texts) {
    const deps = extractTemplateDependenciesFromString(text)
    const { outputs } = splitDependencies(deps)
    for (const dep of outputs) {
      if (seen.has(dep.fullPath)) continue
      seen.add(dep.fullPath)
      fields.push({
        id: dep.fullPath,
        blockId: dep.blockId,
        outputName: dep.outputName,
        label: `${dep.outputName} — output of step ${dep.blockId}`,
      })
    }
  }

  return fields
}

/**
 * Build the `outputs` namespace from the user's manual entries. When a field is
 * still empty we substitute a `<key>` placeholder so the displayed command never
 * contains a raw `{{ … }}` (the hard rule) yet still reads as a clear "fill me
 * in" slot. Each value is stored under both the normalized and original block id
 * so the resolver finds it regardless of which form the command used.
 */
export function buildManualOutputs(
  fields: ManualFieldSpec[],
  values: Record<string, string>,
): TemplateOutputs {
  const outputs: TemplateOutputs = {}

  const put = (blockId: string, outputName: string, value: string) => {
    if (!outputs[blockId]) outputs[blockId] = {}
    outputs[blockId][outputName] = value
  }

  for (const field of fields) {
    const entered = values[field.id]
    const value =
      entered != null && entered !== '' ? entered : `<${field.outputName}>`
    const normalized = normalizeBlockId(field.blockId)
    put(normalized, field.outputName, value)
    if (field.blockId !== normalized) {
      put(field.blockId, field.outputName, value)
    }
  }

  return outputs
}

/**
 * Whether the template context already resolves a given output reference — e.g.
 * a DirPicker that published its chosen path as `{{ .outputs.<id>.PATH }}`.
 * Such references resolve from context and don't need a manual prompt.
 */
export function contextHasOutput(
  ctx: TemplateContext,
  blockId: string,
  outputName: string,
): boolean {
  const value =
    ctx.outputs[normalizeBlockId(blockId)]?.[outputName] ??
    ctx.outputs[blockId]?.[outputName]
  return value != null && value !== ''
}

/**
 * Of the auto-detected output references, the ones that actually need a manual
 * prompt: those the template context can't already resolve.
 */
export function fieldsNeedingPrompt(
  fields: ManualFieldSpec[],
  ctx: TemplateContext,
): ManualFieldSpec[] {
  return fields.filter((f) => !contextHasOutput(ctx, f.blockId, f.outputName))
}

/**
 * Merge form inputs and manually-supplied output values into a single template
 * context (§5 step 2). Existing context outputs are kept (e.g. a DirPicker's
 * published path), with the prompted manual values layered on top.
 */
export function buildMergedContext(
  baseContext: TemplateContext,
  fields: ManualFieldSpec[],
  values: Record<string, string>,
): TemplateContext {
  const manualOutputs = buildManualOutputs(fields, values)

  // Merge per-block so manual values for one output key don't drop the block's
  // other keys already resolved in context (e.g. a DirPicker's published PATH).
  const mergedOutputs: TemplateOutputs = { ...baseContext.outputs }
  for (const [blockId, outputValues] of Object.entries(manualOutputs)) {
    mergedOutputs[blockId] = { ...(mergedOutputs[blockId] ?? {}), ...outputValues }
  }

  return {
    inputs: baseContext.inputs,
    outputs: mergedOutputs,
  }
}

/**
 * Client-side fallback resolver (§5 step 3 fallback). Lower fidelity than the Go
 * engine — it does no conditionals/functions — but it fills `{{ .inputs.* }}` /
 * `{{ .outputs.*.* }}` references and is the backstop guaranteeing no raw `{{ }}`
 * survives in the displayed command.
 */
export function resolveCommandClientSide(
  command: string,
  ctx: TemplateContext,
): string {
  return resolveTemplateReferences(command, ctx)
}

/** Normalize a `string | string[] | undefined` command into a string array. */
export function normalizeCommandList(
  command: string | string[] | undefined,
): string[] {
  if (command == null) return []
  return Array.isArray(command) ? command : [command]
}

/** True if the text still contains an unresolved Go-template reference. */
export function hasUnresolvedTemplate(text: string): boolean {
  return /\{\{/.test(text)
}
