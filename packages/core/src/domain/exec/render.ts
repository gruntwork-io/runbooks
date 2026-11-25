/**
 * Template rendering for Command/Check scripts before they execute.
 */
import { Effect } from "effect"
import { BoilerplateRenderer } from "../../services/BoilerplateRenderer.ts"
import type { WasmRuntime } from "../../services/WasmRuntime.ts"
import { RenderError } from "../../errors/index.ts"
import { resolveInputTemplates } from "../boilerplate/flattenInputs.ts"
import type { BlockEnv } from "./blockEnv.ts"

/**
 * Render a script's `{{ .inputs.X }}` / `{{ .outputs.B.K }}` references with
 * the UI's `{ inputs, outputs }` values, ready to execute.
 *
 * Values are inserted verbatim, with no shell quoting or escaping — the same
 * contract as the View Source preview and the test CLI. Scripts quote where
 * the shell needs it (`X="{{ .inputs.X }}"`), and string comparisons such as
 * `{{ if eq .inputs.X "lit" }}` see the raw value. A block's `env` prop
 * passes values as data instead (renderBlockEnv).
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
    const vars = yield* resolveTemplateVars(templateVarValues)
    return yield* renderer.renderFileStrict(scriptContent, vars)
  })
}

/**
 * Render a block's `env` templates with the same values as its script, ready
 * to set in the script's environment. Strict like renderScriptForExec: a
 * template error, such as an output that doesn't exist, fails the run and
 * names the variable, since the script would otherwise run with it wrong.
 */
export function renderBlockEnv(
  env: BlockEnv,
  templateVarValues: Record<string, unknown>,
): Effect.Effect<Record<string, string>, RenderError, BoilerplateRenderer | WasmRuntime> {
  return Effect.gen(function* () {
    const rendered: Record<string, string> = { ...env }
    const templated = Object.keys(env).filter((name) => env[name]!.includes("{{"))
    if (templated.length === 0) return rendered

    const renderer = yield* BoilerplateRenderer
    const vars = yield* resolveTemplateVars(templateVarValues)
    for (const name of templated) {
      rendered[name] = yield* renderer
        .renderFileStrict(env[name]!, vars)
        .pipe(
          Effect.mapError(
            (err) => new RenderError({ message: `${name} in env: ${err.message}`, cause: err }),
          ),
        )
    }
    return rendered
  })
}

/**
 * The values to render a script or its env with: `templateVarValues` with
 * the inputs that are templates themselves resolved.
 *
 * An input value can itself be a template — e.g. a Template block exposes
 *   LogsAccountEmail = "{{ .inputs.EmailUsername }}+logs@{{ .inputs.EmailDomainName }}"
 * via inputsId. A single render pass would insert that value verbatim,
 * leaving the inner `{{ .inputs.* }}` unrendered. We resolve the inputs
 * namespace to a fixed point against the other inputs/outputs first —
 * mirroring what flattenVariables does for the Template render path so exec
 * and render behave identically.
 */
function resolveTemplateVars(templateVarValues: Record<string, unknown>) {
  return Effect.gen(function* () {
    const rawInputs =
      templateVarValues.inputs &&
      typeof templateVarValues.inputs === "object" &&
      !Array.isArray(templateVarValues.inputs)
        ? (templateVarValues.inputs as Record<string, unknown>)
        : {}
    const resolvedInputs = yield* resolveInputTemplates(rawInputs, templateVarValues.outputs)
    return { ...templateVarValues, inputs: resolvedInputs }
  })
}
