// ============================================================================
// Template Renderer - JavaScript-based Go template renderer
// This serves as a placeholder for the WASM bridge. It handles basic Go
// template syntax ({{ .Var }}, {{ .Var | func }}) for the prototype.
// In production, this would be replaced by the WASM binary from PR #277.
// ============================================================================

// Built-in Sprig-like template functions
const templateFunctions: Record<string, (...args: string[]) => string> = {
  // String functions
  upper: (s: string) => s.toUpperCase(),
  lower: (s: string) => s.toLowerCase(),
  title: (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase()),
  trim: (s: string) => s.trim(),
  trimPrefix: (s: string, prefix: string) => (s.startsWith(prefix) ? s.slice(prefix.length) : s),
  trimSuffix: (s: string, suffix: string) => (s.endsWith(suffix) ? s.slice(0, -suffix.length) : s),
  replace: (s: string, old: string, new_: string) => s.split(old).join(new_),
  contains: (s: string, substr: string) => String(s.includes(substr)),
  hasPrefix: (s: string, prefix: string) => String(s.startsWith(prefix)),
  hasSuffix: (s: string, suffix: string) => String(s.endsWith(suffix)),
  quote: (s: string) => `"${s}"`,
  squote: (s: string) => `'${s}'`,

  // Case conversion
  snakecase: (s: string) =>
    s
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      .replace(/[\s-]+/g, '_')
      .toLowerCase(),
  camelcase: (s: string) =>
    s
      .replace(/[-_\s]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''))
      .replace(/^[A-Z]/, (c) => c.toLowerCase()),
  kebabcase: (s: string) =>
    s
      .replace(/([a-z])([A-Z])/g, '$1-$2')
      .replace(/[\s_]+/g, '-')
      .toLowerCase(),
  dasherize: (s: string) =>
    s
      .replace(/([a-z])([A-Z])/g, '$1-$2')
      .replace(/[\s_]+/g, '-')
      .toLowerCase(),

  // Default
  default: (s: string, defaultVal: string) => (s === '' || s === undefined || s === null ? defaultVal : s),

  // Type conversion
  toString: (s: unknown) => String(s),
  toInt: (s: string) => String(parseInt(s, 10)),
  toFloat: (s: string) => String(parseFloat(s)),
  toBool: (s: string) => String(s === 'true' || s === '1'),

  // Logic (for use in conditionals)
  not: (s: string) => String(s === 'false' || s === '' || s === '0' || s === 'undefined'),
  and: (a: string, b: string) => String(Boolean(a) && Boolean(b)),
  or: (a: string, b: string) => String(Boolean(a) || Boolean(b)),
  eq: (a: string, b: string) => String(a === b),
  ne: (a: string, b: string) => String(a !== b),

  // Shell placeholder (WASM limitation)
  shell: () => 'replace-me',
}

// Resolve a dotted path like ".Foo.Bar" from a variables object
function resolvePath(vars: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.')
  let current: unknown = vars
  for (const part of parts) {
    if (part === '') continue
    if (current === null || current === undefined) return undefined
    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[part]
    } else {
      return undefined
    }
  }
  return current
}

// Format a value for template output
function formatValue(val: unknown): string {
  if (val === null || val === undefined) return ''
  if (typeof val === 'object') return JSON.stringify(val)
  return String(val)
}

// Parse pipe-separated function calls: ".Var | func1 | func2 arg"
function parsePipeline(
  expr: string
): { varPath: string; functions: Array<{ name: string; args: string[] }> } {
  const parts = expr.split('|').map((s) => s.trim())
  const varPath = parts[0]
  const functions: Array<{ name: string; args: string[] }> = []

  for (let i = 1; i < parts.length; i++) {
    const tokens = parts[i].split(/\s+/)
    const name = tokens[0]
    const args = tokens.slice(1).map((a) => a.replace(/^["']|["']$/g, ''))
    functions.push({ name, args })
  }

  return { varPath, functions }
}

// Evaluate a single expression within {{ }}
function evaluateExpression(expr: string, vars: Record<string, unknown>): string {
  expr = expr.trim()

  // Handle string literals
  if (/^"[^"]*"$/.test(expr) || /^'[^']*'$/.test(expr)) {
    return expr.slice(1, -1)
  }

  // Handle numeric literals
  if (/^\d+(\.\d+)?$/.test(expr)) {
    return expr
  }

  // Handle function calls like `funcName "arg1" .Var`
  // e.g., `hasPrefix "python" .Runtime`
  const funcCallMatch = expr.match(/^(\w+)\s+(.+)$/)
  if (funcCallMatch && templateFunctions[funcCallMatch[1]] && !funcCallMatch[2].startsWith('.')) {
    // This is a function call with literal first arg
    // Actually let's handle this more carefully for cases like `not (hasPrefix "python" .Runtime)`
  }

  // Handle pipeline expressions: .Var | func1 | func2
  const { varPath, functions } = parsePipeline(expr)

  // Resolve the initial value
  let value: string
  if (varPath.startsWith('.')) {
    const resolved = resolvePath(vars, varPath.slice(1))
    if (resolved === undefined) {
      throw new Error(`variable "${varPath}" not found`)
    }
    value = formatValue(resolved)
  } else if (varPath.startsWith('"') || varPath.startsWith("'")) {
    value = varPath.slice(1, -1)
  } else if (/^\d+/.test(varPath)) {
    value = varPath
  } else {
    // Could be a function call without pipes
    if (templateFunctions[varPath]) {
      value = templateFunctions[varPath]()
    } else {
      throw new Error(`unknown expression: "${varPath}"`)
    }
  }

  // Apply piped functions
  for (const fn of functions) {
    const func = templateFunctions[fn.name]
    if (!func) {
      throw new Error(`unknown template function: "${fn.name}"`)
    }
    // Resolve any variable references in args
    const resolvedArgs = fn.args.map((arg) => {
      if (arg.startsWith('.')) {
        const resolved = resolvePath(vars, arg.slice(1))
        return formatValue(resolved)
      }
      return arg
    })
    value = func(value, ...resolvedArgs)
  }

  return value
}

// Process conditional blocks: {{ if .Var }}...{{ else }}...{{ end }}
function processConditionals(template: string, vars: Record<string, unknown>): string {
  // Handle {{ if expr }}...{{ else }}...{{ end }} and {{ if expr }}...{{ end }}
  // This is simplified and handles single-level nesting
  const ifRegex =
    /\{\{-?\s*if\s+(.+?)\s*-?\}\}([\s\S]*?)(?:\{\{-?\s*else\s*-?\}\}([\s\S]*?))?\{\{-?\s*end\s*-?\}\}/g

  let result = template
  let prevResult = ''
  let iterations = 0

  while (result !== prevResult && iterations < 10) {
    prevResult = result
    iterations++
    result = result.replace(ifRegex, (_match, condition, ifBlock, elseBlock) => {
      try {
        const condValue = evaluateExpression(condition.trim(), vars)
        const isTruthy =
          condValue !== '' &&
          condValue !== 'false' &&
          condValue !== '0' &&
          condValue !== 'undefined' &&
          condValue !== 'null' &&
          condValue !== '<no value>'
        return isTruthy ? (ifBlock || '') : (elseBlock || '')
      } catch {
        // If condition can't be evaluated, keep the block
        return _match
      }
    })
  }

  return result
}

// Process range blocks: {{ range .List }}...{{ end }}
function processRanges(template: string, vars: Record<string, unknown>): string {
  const rangeRegex =
    /\{\{-?\s*range\s+(.+?)\s*-?\}\}([\s\S]*?)\{\{-?\s*end\s*-?\}\}/g

  return template.replace(rangeRegex, (_match, expr, body) => {
    try {
      const value = resolvePath(vars, expr.trim().slice(1))
      if (Array.isArray(value)) {
        return value
          .map((item) => {
            // Replace {{ . }} with the current item
            let rendered = body.replace(/\{\{\s*\.\s*\}\}/g, formatValue(item))
            // Also replace {{ .FieldName }} for object items
            if (typeof item === 'object' && item !== null) {
              rendered = renderTemplate(rendered, item as Record<string, unknown>)
            }
            return rendered
          })
          .join('')
      }
      if (typeof value === 'object' && value !== null) {
        return Object.entries(value as Record<string, unknown>)
          .map(([key, val]) => {
            let rendered = body
              .replace(/\{\{\s*\.Key\s*\}\}/g, key)
              .replace(/\{\{\s*\.Value\s*\}\}/g, formatValue(val))
            return rendered
          })
          .join('')
      }
      return ''
    } catch {
      return _match
    }
  })
}

// Handle whitespace trimming for {{- and -}}
function trimWhitespace(template: string): string {
  // {{- trims preceding whitespace
  template = template.replace(/\s*\{\{-/g, '{{')
  // -}} trims following whitespace
  template = template.replace(/-\}\}\s*/g, '}}')
  return template
}

/**
 * Render a Go-style template string with the given variables.
 * This is a JavaScript implementation that handles the most common Go template
 * patterns. For the production version, this would be replaced by the WASM binary.
 */
export function renderTemplate(
  templateStr: string,
  vars: Record<string, unknown>
): string {
  let result = templateStr

  // Handle whitespace trimming markers
  result = trimWhitespace(result)

  // Process conditionals first (they may contain other expressions)
  result = processConditionals(result, vars)

  // Process range blocks
  result = processRanges(result, vars)

  // Process simple expressions: {{ .Var }}, {{ .Var | func }}
  result = result.replace(/\{\{\s*(.*?)\s*\}\}/g, (_match, expr) => {
    try {
      return evaluateExpression(expr.trim(), vars)
    } catch (err) {
      // Re-throw to signal that rendering failed (used by multi-trial algorithm)
      throw err
    }
  })

  return result
}

/**
 * Try to render a template, returning { result, error }.
 * Used by the multi-trial rendering algorithm.
 */
export function tryRenderTemplate(
  templateStr: string,
  vars: Record<string, unknown>
): { result?: string; error?: string } {
  try {
    const result = renderTemplate(templateStr, vars)
    return { result }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}
