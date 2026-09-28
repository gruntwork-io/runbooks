/**
 * Template rendering for Command/Check scripts before they execute.
 */
import { Effect } from "effect"
import { BoilerplateRenderer } from "../../services/BoilerplateRenderer.ts"
import type { WasmRuntime } from "../../services/WasmRuntime.ts"
import type { RenderError } from "../../errors/index.ts"
import { resolveInputTemplates } from "../boilerplate/flattenInputs.ts"

/**
 * Render a script's `{{ .inputs.X }}` / `{{ .outputs.B.K }}` references with
 * the UI's `{ inputs, outputs }` values, ready to execute.
 *
 * Values are inserted verbatim, with no shell quoting or escaping — the same
 * contract as the View Source preview and the test CLI. Scripts quote where
 * the shell needs it (`X="{{ .inputs.X }}"`), and string comparisons such as
 * `{{ if eq .inputs.X "lit" }}` see the raw value.
 *
 * Rendering is strict: a template error fails with `RenderError` so the
 * block fails with the real cause, rather than running the preview's
 * `[template error: ...]` marker as the script.
 */
export function renderScriptForExec(
  scriptContent: string,
  templateVarValues: Record<string, unknown>,
): Effect.Effect<string, RenderError, BoilerplateRenderer | WasmRuntime> {
  return Effect.gen(function* () {
    const renderer = yield* BoilerplateRenderer

    // Resolve nested input templates first. An input value can itself
    // be a template — e.g. a Template block exposes
    //   LogsAccountEmail = "{{ .inputs.EmailUsername }}+logs@{{ .inputs.EmailDomainName }}"
    // via inputsId. A single render pass would insert that value
    // verbatim, leaving the inner `{{ .inputs.* }}` unrendered. We
    // resolve the inputs namespace to a fixed point against the other
    // inputs/outputs first — mirroring what flattenVariables does for
    // the Template render path so exec and render behave identically.
    const rawInputs =
      templateVarValues.inputs &&
      typeof templateVarValues.inputs === "object" &&
      !Array.isArray(templateVarValues.inputs)
        ? (templateVarValues.inputs as Record<string, unknown>)
        : {}
    const resolvedInputs = yield* resolveInputTemplates(
      rawInputs,
      templateVarValues.outputs,
    )
    const resolvedVars = { ...templateVarValues, inputs: resolvedInputs }

    return yield* renderer.renderFileStrict(scriptContent, resolvedVars)
  })
}
