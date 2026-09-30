/**
 * Block output values, shared by the main process, the test CLI and the
 * renderer (which re-exports this module from web/src/lib/outputValues.ts).
 * The renderer bundles it directly, so it must stay free of Node and Electron
 * imports.
 *
 * An output the script marked `sensitive:` is carried as an Effect `Redacted`
 * rather than a string. `String()`, template literals, `JSON.stringify` and
 * Node's inspect all print it as `<redacted>`, and the type checker rejects
 * using it where a string is expected. So a consumer that forgets about
 * sensitive outputs shows `<redacted>`, not the secret.
 *
 * Two helpers cover every consumer:
 *
 *  - `revealOutput` returns the real value. It is the only caller of
 *    `Redacted.value`, and `revealOutputs` (and the renderer's
 *    `revealTemplateOutputs`) build on it, so grepping for `reveal\w*Outputs?`
 *    finds every place that reads a secret: template rendering, the auth
 *    blocks' credential detection, the copy button on a View Outputs row,
 *    the test CLI's assertion comparisons.
 *  - `maskOutput` returns what to show: the value, or `<redacted>` for a
 *    sensitive one.
 */

import { Redacted } from "effect"

/** A block output's value: a plain string, or a `Redacted` if the script marked it sensitive. */
export type OutputValue = string | Redacted.Redacted<string>

/** A block's outputs by key. */
export type OutputValues = Record<string, OutputValue>

/** Wrap a value the script marked `sensitive:`. */
export function sensitiveOutput(value: string): Redacted.Redacted<string> {
  return Redacted.make(value)
}

/** Whether the script marked this output `sensitive:`. */
export function isSensitiveOutput(value: OutputValue): value is Redacted.Redacted<string> {
  return Redacted.isRedacted(value)
}

/**
 * The real value, for a consumer that uses it rather than shows it (template
 * rendering, credential detection, copying one value, comparing it). Never
 * pass the result to anything that displays or logs it. A missing output
 * (`undefined`) passes through.
 */
export function revealOutput(value: OutputValue): string
export function revealOutput(value: OutputValue | undefined): string | undefined
export function revealOutput(value: OutputValue | undefined): string | undefined {
  return value !== undefined && isSensitiveOutput(value) ? Redacted.value(value) : value
}

/** The text to show for an output: its value, or `<redacted>` if it's sensitive. */
export function maskOutput(value: OutputValue): string {
  return isSensitiveOutput(value) ? String(value) : value
}

/** `revealOutput` for each of a block's outputs. */
export function revealOutputs(values: OutputValues): Record<string, string> {
  return mapValues(values, (value) => revealOutput(value))
}

/** `maskOutput` for each of a block's outputs. */
export function maskOutputs(values: OutputValues): Record<string, string> {
  return mapValues(values, maskOutput)
}

// ---------------------------------------------------------------------------
// IPC encoding
// ---------------------------------------------------------------------------

/**
 * One output as it crosses IPC. Structured clone copies only an object's own
 * properties, and a `Redacted` keeps its value elsewhere, so a `Redacted` sent
 * as is arrives as `{}`. The main process sends this flat form instead, and
 * the renderer rebuilds the `Redacted` on receipt.
 */
export interface EncodedOutputValue {
  value: string
  sensitive: boolean
}

/** A block's outputs as they cross IPC (see EncodedOutputValue). */
export type EncodedOutputValues = Record<string, EncodedOutputValue>

/** Flatten outputs to send over IPC. */
export function encodeOutputs(values: OutputValues): EncodedOutputValues {
  return mapValues(values, (value) => ({ value: revealOutput(value), sensitive: isSensitiveOutput(value) }))
}

/** Rebuild outputs received over IPC, wrapping the sensitive ones again. */
export function decodeOutputs(encoded: EncodedOutputValues): OutputValues {
  return mapValues(encoded, ({ value, sensitive }) => (sensitive ? sensitiveOutput(value) : value))
}

function mapValues<A, B>(record: Record<string, A>, f: (value: A) => B): Record<string, B> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, f(value)]))
}
