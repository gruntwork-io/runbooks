/**
 * Whether an input value is a Go-template expression, which the main process
 * resolves against the other inputs before rendering (see
 * resolveInputTemplates in flattenInputs.ts).
 *
 * The form (web/) uses the same test to decide which values it shows as
 * linked tokens, so a value shown as linked is exactly one main resolves. The
 * renderer bundles this module directly, so it must stay free of imports.
 */

/** Matches any Go-template expression. `s` flag so `.` spans multi-line defaults. */
export const TEMPLATE_EXPR_RE = /\{\{.*?\}\}/s

export function isTemplateString(v: unknown): boolean {
  return typeof v === "string" && TEMPLATE_EXPR_RE.test(v)
}
