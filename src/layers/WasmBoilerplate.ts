/**
 * Placeholder implementation of the BoilerplateRenderer service.
 *
 * The actual WASM-based rendering API needs further investigation.
 * For now all methods fail with a "not yet implemented" RenderError.
 */
import { Effect, Layer } from "effect"
import { BoilerplateRenderer } from "../services/BoilerplateRenderer.ts"
import type { BoilerplateRendererShape } from "../services/BoilerplateRenderer.ts"
import { RenderError } from "../errors/index.ts"

const impl: BoilerplateRendererShape = {
  renderFile: (_templateContent: string, _variables: Record<string, unknown>) =>
    Effect.fail(new RenderError({ message: "BoilerplateRenderer.renderFile is not yet implemented" })),

  renderTemplate: (_templateDir: string, _outputDir: string, _variables: Record<string, unknown>) =>
    Effect.fail(new RenderError({ message: "BoilerplateRenderer.renderTemplate is not yet implemented" })),
}

export const WasmBoilerplateLive = Layer.succeed(BoilerplateRenderer, impl)
