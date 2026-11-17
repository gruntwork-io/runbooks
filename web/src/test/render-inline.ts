import type { Result } from "./test-api"

type RenderedInline = Result<"boilerplate:render-inline">

/**
 * A boilerplate:render-inline answer with `contents`, each rendered file's
 * content by its name, building each file's entry as main does. `written` adds
 * what main sends for a render that wrote the files (a fileTree and its
 * truncation fields).
 */
export function renderedInline(
  contents: Record<string, string>,
  written: Omit<RenderedInline, "message" | "renderedFiles"> = {},
): RenderedInline {
  const renderedFiles: RenderedInline["renderedFiles"] = {}
  for (const [name, content] of Object.entries(contents)) {
    renderedFiles[name] = {
      name,
      path: name,
      content,
      language: "",
      size: content.length,
      isTruncated: false,
    }
  }
  return { message: "Inline template rendered", renderedFiles, ...written }
}
