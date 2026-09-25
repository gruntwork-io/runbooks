import { Context, Effect } from "effect"
import type { RenderError } from "../errors/index.ts"

export interface BoilerplateRendererShape {
  /**
   * Render a single Go text/template string, leniently: a template-level
   * failure (missing key, parse error, unknown function) renders as a
   * one-line `[template error: ...]` marker instead of failing. Meant for
   * previews (`<TemplateInline>`, View Source, instruction mode). Anything
   * that will be executed must use `renderFileStrict` instead.
   */
  readonly renderFile: (
    templateContent: string,
    variables: Record<string, unknown>,
  ) => Effect.Effect<string, RenderError>

  /**
   * Render a single Go text/template string, strictly: every failure,
   * including template-level ones, fails with `RenderError`. Use this for
   * content that will be executed, such as Command/Check scripts.
   */
  readonly renderFileStrict: (
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
