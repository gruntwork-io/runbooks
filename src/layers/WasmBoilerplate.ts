/**
 * TypeScript implementation of the BoilerplateRenderer service.
 *
 * Renders Go text/template-compatible strings with variable substitution.
 * Supports: {{ .path.to.value }}, {{ if .x }}...{{ else }}...{{ end }},
 * {{ range ... }}...{{ end }}, {{ fromJson .x }}, and {{ toJson .x }}.
 */
import { Effect, Layer } from "effect"
import { BoilerplateRenderer } from "../services/BoilerplateRenderer.ts"
import type { BoilerplateRendererShape } from "../services/BoilerplateRenderer.ts"
import { RenderError } from "../errors/index.ts"

// ---------------------------------------------------------------------------
// Go template renderer (TypeScript implementation)
// ---------------------------------------------------------------------------

/**
 * Resolve a dot-separated path against a nested object.
 * e.g. resolveDotPath({ inputs: { region: "us-east-1" } }, "inputs.region") => "us-east-1"
 */
function resolveDotPath(obj: Record<string, unknown>, dotPath: string): unknown {
  const parts = dotPath.split(".")
  let current: unknown = obj
  for (const part of parts) {
    if (current === null || current === undefined) return undefined
    if (typeof current !== "object") return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

/**
 * Render a Go text/template string with the given variables.
 *
 * Supported constructs (in order of processing):
 *   1. {{ range $var := (fromJson .path) }}...{{ end }}
 *   2. {{ range $key, $value := (fromJson .path) }}...{{ end }}
 *   3. {{ if .path }}...{{ else }}...{{ end }}
 *   4. {{ fromJson .path }}
 *   5. {{ toJson .path }}
 *   6. {{ .path.to.value }}
 *
 * This covers the patterns used in runbook scripts and TemplateInline blocks.
 */
function renderGoTemplate(
  content: string,
  vars: Record<string, unknown>,
): string {
  let result = content

  // 1. Handle {{ range $key, $value := (fromJson .path) }}...{{ end }}
  //    and {{ range $var := (fromJson .path) }}...{{ end }}
  //    and {{ range (fromJson .path) }}...{{ end }}
  result = result.replace(
    /\{\{-?\s*range\s+(?:(\$\w+)\s*,\s*(\$\w+)\s*:=\s*|(\$\w+)\s*:=\s*)?\(fromJson\s+\.([a-zA-Z0-9_.]+)\)\s*-?\}\}([\s\S]*?)\{\{-?\s*end\s*-?\}\}/g,
    (_match, keyVar: string | undefined, valVar: string | undefined, singleVar: string | undefined, jsonPath: string, body: string) => {
      const raw = resolveDotPath(vars, jsonPath)
      if (raw === undefined || raw === null) return ""
      let parsed: unknown
      try {
        parsed = typeof raw === "string" ? JSON.parse(raw) : raw
      } catch {
        return ""
      }

      if (Array.isArray(parsed)) {
        const itemVar = singleVar || "$item"
        return parsed.map((item) => {
          let rendered = body
          // Replace {{ . }} (current item in range) and {{ $var }}
          rendered = rendered.replace(/\{\{-?\s*\.\s*-?\}\}/g, String(item))
          rendered = rendered.replace(
            new RegExp(`\\{\\{-?\\s*\\${itemVar.replace("$", "\\$")}\\s*-?\\}\\}`, "g"),
            String(item),
          )
          return rendered
        }).join("")
      }

      if (typeof parsed === "object" && parsed !== null) {
        const kVar = keyVar || "$key"
        const vVar = valVar || singleVar || "$value"
        return Object.entries(parsed as Record<string, unknown>).map(([k, v]) => {
          let rendered = body
          rendered = rendered.replace(
            new RegExp(`\\{\\{-?\\s*\\${kVar.replace("$", "\\$")}\\s*-?\\}\\}`, "g"),
            k,
          )
          // Handle nested field access: {{ $value.field }}
          rendered = rendered.replace(
            new RegExp(`\\{\\{-?\\s*\\${vVar.replace("$", "\\$")}\\.([a-zA-Z0-9_.]+)\\s*-?\\}\\}`, "g"),
            (_m: string, field: string) => {
              if (v && typeof v === "object") {
                const val = resolveDotPath(v as Record<string, unknown>, field)
                if (val === undefined || val === null) return ""
                // Handle arrays for nested range
                if (Array.isArray(val)) return String(val.join(", "))
                return String(val)
              }
              return ""
            },
          )
          // Handle plain {{ $value }}
          rendered = rendered.replace(
            new RegExp(`\\{\\{-?\\s*\\${vVar.replace("$", "\\$")}\\s*-?\\}\\}`, "g"),
            typeof v === "object" ? JSON.stringify(v) : String(v),
          )
          // Handle nested range over $value.field
          rendered = rendered.replace(
            /\{\{-?\s*range\s+(\$\w+\.)?([a-zA-Z0-9_.]+)\s*-?\}\}([\s\S]*?)\{\{-?\s*end\s*-?\}\}/g,
            (_m2: string, prefix: string | undefined, field: string, innerBody: string) => {
              if (!v || typeof v !== "object") return ""
              const arr = resolveDotPath(v as Record<string, unknown>, field)
              if (!Array.isArray(arr)) return ""
              return arr.map((item) => {
                return innerBody.replace(/\{\{-?\s*\.\s*-?\}\}/g, String(item))
              }).join("")
            },
          )
          return rendered
        }).join("")
      }

      return ""
    },
  )

  // 2. Handle {{ if .x }}...{{ else }}...{{ end }}
  result = result.replace(
    /\{\{-?\s*if\s+\.([a-zA-Z0-9_.]+)\s*-?\}\}([\s\S]*?)(?:\{\{-?\s*else\s*-?\}\}([\s\S]*?))?\{\{-?\s*end\s*-?\}\}/g,
    (_match, keyPath: string, truePart: string, falsePart?: string) => {
      const value = resolveDotPath(vars, keyPath)
      if (value) return truePart
      return falsePart ?? ""
    },
  )

  // 3. Handle {{ fromJson .path }}
  result = result.replace(
    /\{\{-?\s*fromJson\s+\.([a-zA-Z0-9_.]+)\s*-?\}\}/g,
    (_match, keyPath: string) => {
      const value = resolveDotPath(vars, keyPath)
      if (value === undefined) return ""
      try {
        return JSON.stringify(typeof value === "string" ? JSON.parse(value) : value)
      } catch {
        return String(value)
      }
    },
  )

  // 4. Handle {{ toJson .path }}
  result = result.replace(
    /\{\{-?\s*toJson\s+\.([a-zA-Z0-9_.]+)\s*-?\}\}/g,
    (_match, keyPath: string) => {
      const value = resolveDotPath(vars, keyPath)
      if (value === undefined) return ""
      return JSON.stringify(value)
    },
  )

  // 5. Handle {{ .path.to.value }} variable substitution
  result = result.replace(
    /\{\{-?\s*\.([a-zA-Z0-9_.]+)\s*-?\}\}/g,
    (_match, keyPath: string) => {
      const value = resolveDotPath(vars, keyPath)
      if (value === undefined || value === null) return ""
      return String(value)
    },
  )

  return result
}

// ---------------------------------------------------------------------------
// Service implementation
// ---------------------------------------------------------------------------

const impl: BoilerplateRendererShape = {
  renderFile: (templateContent: string, variables: Record<string, unknown>) =>
    Effect.try({
      try: () => renderGoTemplate(templateContent, variables),
      catch: (err) => new RenderError({ message: String(err) }),
    }),

  renderTemplate: (_templateDir: string, _outputDir: string, _variables: Record<string, unknown>) =>
    Effect.fail(new RenderError({ message: "BoilerplateRenderer.renderTemplate is not yet implemented" })),
}

export const WasmBoilerplateLive = Layer.succeed(BoilerplateRenderer, impl)
