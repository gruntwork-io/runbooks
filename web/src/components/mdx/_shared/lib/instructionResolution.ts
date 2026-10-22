/**
 * Pure helpers for resolving a runbook command into a flattened, copy-pasteable
 * instruction (instruction mode).
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
} from "@/lib/extractTemplateDependencies"
import {
  extractInputValueReferences,
  resolveInputPath,
  resolveTemplateReferences,
  type TemplateContext,
  type TemplateInputs,
  type TemplateOutputs,
} from "@/lib/templateUtils"
import { normalizeBlockId } from "@/lib/utils"
import { isSensitiveOutput } from "@/lib/outputValues"

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
  /**
   * The commands read this output only behind a `hasKey` guard, so the block
   * may not have produced it. Left empty, it stays absent rather than getting
   * a placeholder, so the guard skips it as it would at run time.
   */
  optional?: boolean
}

/**
 * Scan a command for distinct `{{ .outputs.<id>.<key> }}` references and
 * synthesize one manual field per reference. `{{ .inputs.* }}` references are
 * NOT collected — those come from the still-functional Inputs forms (§6.5.1).
 */
export function detectManualFields(command: string | string[] | undefined): ManualFieldSpec[] {
  // Each command is its own template: an output any of them reads unguarded is
  // required.
  const { outputs } = splitDependencies(
    extractTemplateDependenciesFromString(...normalizeCommandList(command)),
  )
  return outputs.map((dep) => ({
    id: dep.fullPath,
    blockId: dep.blockId,
    outputName: dep.outputName,
    label: `${dep.outputName} — output of step ${dep.blockId}${dep.optional ? " (optional)" : ""}`,
    ...(dep.optional ? { optional: true } : {}),
  }))
}

/**
 * Build the `outputs` namespace from the user's manual entries. When a field is
 * still empty we substitute a `<key>` placeholder so the output reference never
 * shows as a raw `{{ … }}` yet still reads as a clear "fill me in" slot. An
 * empty optional field is left out instead, so its `hasKey` guard skips it;
 * its block still gets an entry, which the guard needs to look the key up in.
 * Each value is stored under both the normalized and original block id so
 * the resolver finds it regardless of which form the command used.
 */
export function buildManualOutputs(
  fields: ManualFieldSpec[],
  values: Record<string, string>,
): TemplateOutputs {
  const outputs: TemplateOutputs = {}

  const put = (blockId: string, outputName: string, value: string | undefined) => {
    if (!outputs[blockId]) outputs[blockId] = {}
    if (value !== undefined) outputs[blockId][outputName] = value
  }

  for (const field of fields) {
    const entered = values[field.id]
    const value =
      entered != null && entered !== ""
        ? entered
        : field.optional
          ? undefined
          : `<${field.outputName}>`
    const normalized = normalizeBlockId(field.blockId)
    put(normalized, field.outputName, value)
    if (field.blockId !== normalized) {
      put(field.blockId, field.outputName, value)
    }
  }

  return outputs
}

/**
 * The inputs counterpart of buildManualOutputs: give every input the commands
 * use as a plain value (`{{ .inputs.x }}`, optionally piped) that has no value
 * at all (absent or `undefined`, as an untouched field with no default is) a
 * `<name>` placeholder. The engine fails on such a missing key and renders a
 * `[template error: …]` in place of the whole command, so filling the gap first
 * keeps the rest of the command intact and reads as a clear "fill me in" slot.
 * A dotted reference (`{{ .inputs.tags.env }}`) gets a nested placeholder named
 * after its last segment (`<env>`). The given inputs are not mutated.
 *
 * Any other value, including `''` and `null`, is left as it is. The engine
 * renders it, and a placeholder would change what the command's logic decides:
 * `{{ if .inputs.var_file }}` would take the branch and `| default "x"` would
 * not apply, so the command would differ from what runs for that value.
 *
 * An input referenced only inside template logic (`{{ if .inputs.x }}`, a
 * function argument) is left unset: a placeholder there would be evaluated as
 * a real value (a truthy string) and silently pick a branch the user never
 * chose. Unset, it makes the engine fail, and the client-side fallback shows
 * that logic as written, with a note. An input with no value that is also used
 * as a plain value does get the placeholder (the engine takes one value per
 * input, and can't render the command without one), so the command shows the
 * visible `<name>` slot.
 */
export function buildInputPlaceholders(commands: string[], inputs: TemplateInputs): TemplateInputs {
  const referenced = [...new Set(commands.flatMap(extractInputValueReferences))]
  const missing = referenced.filter((name) => resolveInputPath(inputs, name) === undefined)
  if (missing.length === 0) return inputs

  const filled: TemplateInputs = { ...inputs }
  for (const name of missing) {
    const segments = name.split(".")
    const key = segments.pop() as string
    let target: Record<string, unknown> | null = filled
    for (const segment of segments) {
      const current: unknown = Object.hasOwn(target, segment) ? target[segment] : undefined
      // Don't clobber a set value (a scalar, or null) that the reference
      // treats as an object.
      if (
        current !== undefined &&
        (current === null || typeof current !== "object" || Array.isArray(current))
      ) {
        target = null
        break
      }
      const copy = { ...(current as Record<string, unknown> | undefined) }
      target[segment] = copy
      target = copy
    }
    if (target) target[key] = `<${key}>`
  }

  return filled
}

/**
 * Whether the template context already resolves a given output reference — e.g.
 * a DirPicker that published its chosen path as `{{ .outputs.<id>.PATH }}`.
 * Such references resolve from context and don't need a manual prompt. A
 * sensitive output doesn't: instruction mode never shows it, so the user
 * pastes it like one that hasn't been produced.
 */
export function contextHasOutput(
  ctx: TemplateContext,
  blockId: string,
  outputName: string,
): boolean {
  const value =
    ctx.outputs[normalizeBlockId(blockId)]?.[outputName] ?? ctx.outputs[blockId]?.[outputName]
  return value != null && !isSensitiveOutput(value) && value !== ""
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
 * published path), with the prompted manual values layered on top. Inputs the
 * `commands` use as plain values but no form has set get a `<name>`
 * placeholder (see buildInputPlaceholders).
 */
export function buildMergedContext(
  baseContext: TemplateContext,
  fields: ManualFieldSpec[],
  values: Record<string, string>,
  commands: string[],
): TemplateContext {
  const manualOutputs = buildManualOutputs(fields, values)

  // Merge per-block so manual values for one output key don't drop the block's
  // other keys already resolved in context (e.g. a DirPicker's published PATH).
  const mergedOutputs: TemplateOutputs = { ...baseContext.outputs }
  for (const [blockId, outputValues] of Object.entries(manualOutputs)) {
    mergedOutputs[blockId] = { ...mergedOutputs[blockId], ...outputValues }
  }

  return {
    inputs: buildInputPlaceholders(commands, baseContext.inputs),
    outputs: mergedOutputs,
  }
}

/**
 * Client-side fallback resolver (§5 step 3 fallback). Lower fidelity than the Go
 * engine — it does no conditionals/functions — but it fills `{{ .inputs.* }}` /
 * `{{ .outputs.*.* }}` value references. Given a buildMergedContext context,
 * every such reference resolves to a value or a `<name>` placeholder; template
 * logic (`{{ if … }}`, functions) is left as written, since only the engine can
 * evaluate it.
 */
export function resolveCommandClientSide(command: string, ctx: TemplateContext): string {
  return resolveTemplateReferences(command, ctx)
}

/** Normalize a `string | string[] | undefined` command into a string array. */
export function normalizeCommandList(command: string | string[] | undefined): string[] {
  if (command == null) return []
  return Array.isArray(command) ? command : [command]
}
