/**
 * Rendering the templates in a Command, Check or Finish block's props before
 * its script runs. The script itself runs as written.
 */
import { Effect } from "effect"
import { BoilerplateRenderer } from "../../services/BoilerplateRenderer.ts"
import type { WasmRuntime } from "../../services/WasmRuntime.ts"
import { RenderError } from "../../errors/index.ts"
import { resolveInputTemplates } from "../boilerplate/flattenInputs.ts"
import type { BlockEnv } from "./blockEnv.ts"

/**
 * Render a block's `env` templates with the block's `{ inputs, outputs }`
 * values, ready to set in the script's environment. Values are inserted
 * verbatim, and the script gets each one as data. Strict: a template error,
 * such as an output that doesn't exist, fails the run with `RenderError` and
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
 * Render a block's `workingDir` template with the same values as its env.
 * Strict like renderBlockEnv: a template error fails the run, since the
 * script would otherwise run in the wrong directory.
 */
export function renderBlockWorkingDir(
  workingDir: string,
  templateVarValues: Record<string, unknown>,
): Effect.Effect<string, RenderError, BoilerplateRenderer | WasmRuntime> {
  return Effect.gen(function* () {
    if (!workingDir.includes("{{")) return workingDir
    const renderer = yield* BoilerplateRenderer
    const vars = yield* resolveTemplateVars(templateVarValues)
    return yield* renderer
      .renderFileStrict(workingDir, vars)
      .pipe(
        Effect.mapError(
          (err) => new RenderError({ message: `workingDir: ${err.message}`, cause: err }),
        ),
      )
  })
}

/**
 * The values to render a block's props with: `templateVarValues` with
 * the inputs that are templates themselves resolved.
 *
 * An input value can itself be a template — e.g. a Template block exposes
 *   LogsAccountEmail = "{{ .inputs.EmailUsername }}+logs@{{ .inputs.EmailDomainName }}"
 * via inputsId. A single render pass would insert that value verbatim,
 * leaving the inner `{{ .inputs.* }}` unrendered. We resolve the inputs
 * namespace to a fixed point against the other inputs/outputs first —
 * mirroring what flattenVariables does for the Template render path so
 * both render the same.
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
