/**
 * Values the user enters by hand for the block outputs a script block's `env`
 * reads, in place of what those blocks output.
 *
 * An env value made of text and plain `{{ .outputs.<block>.<name> }}`
 * references shows each reference as a chip (see EnvVars). Clicking one gives
 * that output another value for this block: its env and its script render
 * with it, and the block stops waiting for the block that produces it.
 * Resetting the chip goes back to that block's output.
 */

import { normalizeBlockId } from "@/lib/utils"
import type { OutputValue, TemplateOutputs } from "@/lib/templateUtils"

/** An env variable as a script block shows it. */
export interface EnvVar {
  name: string
  /**
   * What the script will get: rendered with the current values, else as
   * written. Sensitive outputs show as <redacted>.
   */
  value: string
  /** The value as its text and the outputs it reads, when it's made of only those (see envValueParts). */
  parts?: EnvVarPart[]
}

export type EnvVarPart =
  | { kind: "text"; text: string }
  | {
      kind: "output"
      ref: OutputRef
      /** What the block outputs, or undefined until it has. */
      output: OutputValue | undefined
      /** The value entered in its place, if any. */
      override: OutputValue | undefined
    }

/** An output an env value reads, as `{{ .outputs.<blockId>.<outputName> }}`. */
export interface OutputRef {
  /** The block's id as the runbook writes it, e.g. `fetch-pr`. */
  blockId: string
  outputName: string
  /** `outputs.<block_id>.<output_name>`, with the block id normalized, as TemplateDependency has it. */
  fullPath: string
}

export type EnvValuePart = { kind: "text"; text: string } | { kind: "output"; ref: OutputRef }

const ACTION_RE = /\{\{(.*?)\}\}/gs

/** A whole action that is just `.outputs.<block>.<name>`, matching the dependency extractor's reference. */
const OUTPUT_REF_RE = /^\.outputs\.([a-zA-Z0-9_-]+)\.(\w+)$/

/** The OutputRef for a block's output. */
export function outputRef(blockId: string, outputName: string): OutputRef {
  return { blockId, outputName, fullPath: `outputs.${normalizeBlockId(blockId)}.${outputName}` }
}

/**
 * Split an env value into literal text and the outputs it reads, when it is
 * made of only those and reads at least one. Null for a value with any other
 * action (an input, a pipe, a condition), whose output references can't be
 * shown apart from the rest. Whitespace removed by `{{-` / `-}}` trim markers
 * is dropped from the text, as it is from the rendered value.
 */
export function envValueParts(template: string): EnvValuePart[] | null {
  const parts: EnvValuePart[] = []
  let textStart = 0
  let trimLeadingText = false

  const addText = (text: string) => {
    if (text) parts.push({ kind: "text", text })
  }

  for (const match of template.matchAll(ACTION_RE)) {
    let action = match[1]!
    const trimBefore = /^-\s/.test(action)
    const trimAfter = /\s-$/.test(action)
    if (trimBefore) action = action.slice(1)
    if (trimAfter) action = action.slice(0, -1)

    const ref = OUTPUT_REF_RE.exec(action.trim())
    if (!ref) return null

    let text = template.slice(textStart, match.index)
    if (trimLeadingText) text = text.trimStart()
    if (trimBefore) text = text.trimEnd()
    addText(text)
    textStart = match.index + match[0].length
    trimLeadingText = trimAfter

    parts.push({ kind: "output", ref: outputRef(ref[1]!, ref[2]!) })
  }

  const rest = template.slice(textStart)
  addText(trimLeadingText ? rest.trimStart() : rest)

  return parts.some((part) => part.kind === "output") ? parts : null
}

/** The value entered for an output, or undefined when it has none. */
export function overrideFor(overrides: TemplateOutputs, ref: OutputRef): OutputValue | undefined {
  const values = overrides[normalizeBlockId(ref.blockId)]
  return values && Object.hasOwn(values, ref.outputName) ? values[ref.outputName] : undefined
}

/** `overrides` with the value for `ref` set, or removed when `value` is undefined. */
export function withOverride(
  overrides: TemplateOutputs,
  ref: OutputRef,
  value: OutputValue | undefined,
): TemplateOutputs {
  const blockId = normalizeBlockId(ref.blockId)
  const { [ref.outputName]: _previous, ...rest } = overrides[blockId] ?? {}
  const values = value === undefined ? rest : { ...rest, [ref.outputName]: value }
  const { [blockId]: _block, ...others } = overrides
  return Object.keys(values).length > 0 ? { ...others, [blockId]: values } : others
}

/** Only the overrides for these outputs (by fullPath): the ones an env value still reads. */
export function overridesFor(
  overrides: TemplateOutputs,
  refs: ReadonlyMap<string, OutputRef>,
): TemplateOutputs {
  let kept: TemplateOutputs = {}
  for (const ref of refs.values()) {
    const value = overrideFor(overrides, ref)
    if (value !== undefined) kept = withOverride(kept, ref, value)
  }
  return kept
}

/** Whether `overrides` has a value for the output at `fullPath`. */
export function isOverridden(overrides: TemplateOutputs, fullPath: string): boolean {
  const [, blockId, outputName] = fullPath.split(".")
  return !!blockId && !!outputName && Object.hasOwn(overrides[blockId] ?? {}, outputName)
}

/** Block outputs with the entered values in place of the ones they replace. */
export function applyOverrides(
  outputs: TemplateOutputs,
  overrides: TemplateOutputs,
): TemplateOutputs {
  if (Object.keys(overrides).length === 0) return outputs
  const merged: TemplateOutputs = { ...outputs }
  for (const [blockId, values] of Object.entries(overrides)) {
    merged[blockId] = { ...merged[blockId], ...values }
  }
  return merged
}
