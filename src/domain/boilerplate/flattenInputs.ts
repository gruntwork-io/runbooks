/**
 * Adapter from the UI's `{ inputs, outputs }` payload to the var-file shape
 * boilerplate expects. Two concerns:
 *
 *   1. Resolve user-typed template expressions in `inputs.*` against the
 *      other inputs + outputs map, so a form value like
 *      `{{ .inputs.A }}+suffix@{{ .inputs.B }}` produces the composed
 *      string before it reaches boilerplate.
 *   2. Strip any template values that survived resolution. A raw
 *      `{{ .inputs.X }}` reaching boilerplate as a var-file value crashes
 *      when boilerplate re-evaluates the var-file string inside a
 *      dependency that doesn't expose the `inputs` namespace — stripping
 *      forces fallback to the variable's own `default:` clause, which
 *      boilerplate evaluates correctly in the parent scope.
 *
 * The `outputs` namespace is preserved verbatim throughout. Its values are
 * real block outputs, and downstream `.hcl` files reference
 * `{{ .outputs.X.Y }}` against them.
 */

import { Effect } from "effect"
import { WasmRuntime } from "../../services/WasmRuntime.ts"
import type { WasmRuntimeShape } from "../../services/WasmRuntime.ts"

/** Matches any Go-template expression. `s` flag so `.` spans multi-line defaults. */
const TEMPLATE_EXPR_RE = /\{\{.*?\}\}/s

export function isTemplateString(v: unknown): boolean {
  return typeof v === "string" && TEMPLATE_EXPR_RE.test(v)
}

/**
 * Recursively drop any value that's still a Go-template expression. A map
 * whose resulting keys are all stripped is dropped entirely so the
 * dependency's own defaults apply instead.
 */
export function stripTemplateValues(value: unknown): unknown {
  if (isTemplateString(value)) return undefined
  if (Array.isArray(value)) {
    const cleaned = value
      .map(stripTemplateValues)
      .filter((v) => v !== undefined)
    return cleaned
  }
  if (value && typeof value === "object") {
    const cleaned: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const stripped = stripTemplateValues(v)
      if (stripped !== undefined) cleaned[k] = stripped
    }
    return Object.keys(cleaned).length > 0 ? cleaned : undefined
  }
  return value
}

/**
 * Tight bound on resolution passes. Three covers chained refs A→B→C; deeper
 * chains are almost always a user mistake and would also blow up
 * boilerplate's own `default:` evaluation later, so there's no point
 * looping further.
 */
const MAX_RESOLVE_PASSES = 3

/**
 * Walk `inputs` recursively. For each template-string leaf, render it via
 * WASM against `{ inputs: <non-template-values>, outputs }`.
 *
 *  - Success and the result has no remaining `{{ }}`: replace the leaf.
 *  - Failure (missing key / parse error / runtime not loaded) OR the
 *    result still contains `{{ }}`: leave the original in place. The
 *    strip pass will drop it and boilerplate's `default:` clause runs.
 *
 * Iterates to a fixed point (≤ `MAX_RESOLVE_PASSES`) so chained refs
 * resolve when independent of order. A pass with no replacements ends
 * the loop early, which also handles cycles — neither side ever
 * resolves, so we don't spin.
 */
export function resolveInputTemplates(
  inputs: Record<string, unknown>,
  outputs: unknown,
): Effect.Effect<Record<string, unknown>, never, WasmRuntime> {
  return Effect.gen(function* () {
    if (!hasAnyTemplateString(inputs)) return inputs

    const wasm = yield* WasmRuntime
    let current: unknown = inputs

    for (let pass = 0; pass < MAX_RESOLVE_PASSES; pass++) {
      // Feed only already-resolved values into the render context. A
      // template string in context would render as its literal `{{ }}`
      // text, which is never what the user meant.
      const context =
        (stripTemplateValues(current) as Record<string, unknown> | undefined) ?? {}
      // Mirror the lifting `flattenVariables` does at the end: legacy template
      // refs use top-level `{{ .OrgNamePrefix }}` syntax, not
      // `{{ .inputs.OrgNamePrefix }}`. If we only expose the `inputs`
      // namespace, those refs fail and the value reaches boilerplate
      // unresolved. Reserved namespace names are skipped so they don't
      // clobber the namespaces.
      const contextWithLifted: Record<string, unknown> = {
        inputs: context,
        outputs: outputs ?? {},
      }
      for (const [k, v] of Object.entries(context)) {
        if (k === "inputs" || k === "outputs") continue
        contextWithLifted[k] = v
      }
      const varsJSON = JSON.stringify(contextWithLifted)
      const result = yield* resolveTree(current, wasm, varsJSON)
      current = result.value
      if (!result.changed) break
    }

    return current as Record<string, unknown>
  })
}

function hasAnyTemplateString(value: unknown): boolean {
  if (isTemplateString(value)) return true
  if (Array.isArray(value)) return value.some(hasAnyTemplateString)
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(
      hasAnyTemplateString,
    )
  }
  return false
}

function renderString(
  value: string,
  wasm: WasmRuntimeShape,
  varsJSON: string,
): Effect.Effect<{ value: string; changed: boolean }, never, never> {
  return wasm.renderTemplate(value, varsJSON).pipe(
    Effect.either,
    Effect.map((either) => {
      if (either._tag === "Right" && !TEMPLATE_EXPR_RE.test(either.right)) {
        return { value: either.right, changed: either.right !== value }
      }
      return { value, changed: false }
    }),
  )
}

function resolveTree(
  value: unknown,
  wasm: WasmRuntimeShape,
  varsJSON: string,
): Effect.Effect<{ value: unknown; changed: boolean }, never, never> {
  if (isTemplateString(value)) {
    return renderString(value as string, wasm, varsJSON)
  }
  if (Array.isArray(value)) {
    return Effect.gen(function* () {
      const out: unknown[] = []
      let changed = false
      for (const item of value) {
        const r = yield* resolveTree(item, wasm, varsJSON)
        out.push(r.value)
        if (r.changed) changed = true
      }
      return { value: out, changed }
    })
  }
  if (value && typeof value === "object") {
    return Effect.gen(function* () {
      const out: Record<string, unknown> = {}
      let changed = false
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        // Map keys can themselves be templates (e.g. the `AccountDefaultTags`
        // default in bootstrap is `{ "{{ .OrgNamePrefix }}:Team": "DevOps" }`).
        // Boilerplate doesn't re-evaluate var-file map keys, so unless we
        // render the key here the literal `{{ ... }}` flows through to the
        // rendered output.
        let resolvedKey = k
        if (isTemplateString(k)) {
          const keyResult = yield* renderString(k, wasm, varsJSON)
          if (keyResult.changed) {
            resolvedKey = keyResult.value as string
            changed = true
          }
        }
        const r = yield* resolveTree(v, wasm, varsJSON)
        out[resolvedKey] = r.value
        if (r.changed) changed = true
      }
      return { value: out, changed }
    })
  }
  return Effect.succeed({ value, changed: false })
}

/**
 * Flatten `{ inputs, outputs }` into the var-file shape boilerplate expects:
 * each input lifted to the top level (for legacy `{{ .X }}` syntax + the
 * CLI's required-variable check) while the `inputs` and `outputs`
 * namespaces are preserved (for `{{ .inputs.X }}` / `{{ .outputs.block.X }}`
 * references).
 *
 * Explicit root-level keys win over the lifted inputs (matches main's
 * `applyBackwardCompatibility`). Reserved names `inputs` and `outputs`
 * inside the inputs namespace are skipped to avoid clobbering the
 * namespaces.
 *
 * User-typed template values in `inputs` are first resolved against the
 * other inputs + outputs (see `resolveInputTemplates`). Anything that
 * doesn't resolve is then stripped (see `stripTemplateValues`).
 */
export function flattenVariables(
  variables: Record<string, unknown> | undefined,
): Effect.Effect<Record<string, unknown>, never, WasmRuntime> {
  return Effect.gen(function* () {
    const src = variables ?? {}
    const rawInputs = src.inputs
    const inputsObj =
      rawInputs && typeof rawInputs === "object" && !Array.isArray(rawInputs)
        ? (rawInputs as Record<string, unknown>)
        : {}

    const resolvedInputs = yield* resolveInputTemplates(inputsObj, src.outputs)

    // Anything that didn't resolve gets dropped so boilerplate's own
    // `default:` clause runs in the parent scope.
    const cleanedInputs =
      (stripTemplateValues(resolvedInputs) as
        | Record<string, unknown>
        | undefined) ?? {}

    const result: Record<string, unknown> = {
      ...src,
      inputs: cleanedInputs,
    }

    for (const [k, v] of Object.entries(cleanedInputs)) {
      if (k === "inputs" || k === "outputs") continue
      if (!(k in result)) result[k] = v
    }
    return result
  })
}
