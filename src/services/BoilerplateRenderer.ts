import { Context, Effect } from "effect"
import type { RenderError } from "../errors/index.ts"

export interface BoilerplateRendererShape {
  readonly renderFile: (
    templateContent: string,
    variables: Record<string, unknown>,
  ) => Effect.Effect<string, RenderError>

  readonly renderTemplate: (
    templateDir: string,
    outputDir: string,
    variables: Record<string, unknown>,
  ) => Effect.Effect<void, RenderError>
}

export class BoilerplateRenderer extends Context.Tag("BoilerplateRenderer")<
  BoilerplateRenderer,
  BoilerplateRendererShape
>() {}
