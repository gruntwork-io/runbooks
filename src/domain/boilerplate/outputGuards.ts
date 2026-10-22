/**
 * Which parts of a Go template run only after a `hasKey` guard has checked
 * that an output exists.
 *
 * Templates render with missing-key-action=error, so reading an output its
 * block didn't emit fails the render. A block that emits an output only
 * sometimes (GitClone's `org_id`, a script's conditional output) is read
 * behind a guard:
 *
 *   {{ if hasKey .outputs.clone_repo "org_id" }}--org {{ .outputs.clone_repo.org_id }}{{ end }}
 *
 * A guard covers only the branch it opens. This follows `if`/`else`/`end`
 * nesting, so a reference outside that branch stays required. Anything not
 * recognised as a guard leaves its references required too: that keeps the
 * block waiting, where a wrong guess would let the render fail.
 *
 * Shared by the backend extractor (src/domain/boilerplate/config.ts) and the
 * frontend one (web/src/lib/extractTemplateDependencies.ts). The renderer
 * bundles this module directly, so it must stay free of Node and Electron
 * imports.
 */

/** Template code and the outputs a guard guarantees exist where it runs. */
export interface GuardedCode {
  /** Template code, without delimiters, to scan for references. */
  code: string
  /** `outputs.<block_id>.<key>` paths (block ID normalized) a guard guarantees exist here. */
  guarded: ReadonlySet<string>
}

const ACTION_PATTERN = /\{\{-?([\s\S]*?)-?\}\}/g
const KEYWORD_PATTERN = /^(if|else|end|with|range|block|define)\b\s*([\s\S]*)$/
const ELSE_IF_PATTERN = /^if\b\s*([\s\S]*)$/
const GUARDED_MAP_PATTERN = /^\$?\.outputs\.([a-zA-Z0-9_-]+)$/
const GUARDED_KEY_PATTERN = /^(?:"([a-zA-Z0-9_-]+)"|`([a-zA-Z0-9_-]+)`)$/

const NONE: ReadonlySet<string> = new Set()

interface Branch {
  /** Guards in force in the branch being scanned. */
  current: ReadonlySet<string>
  /** Guards in force in a following `else` branch. */
  otherwise: ReadonlySet<string>
}

interface Condition {
  /** The condition's own code, each part with the guards in force where it runs. */
  parts: GuardedCode[]
  /** What the condition guarantees when it holds. */
  holds: ReadonlySet<string>
  /** What the condition guarantees when it fails. */
  fails: ReadonlySet<string>
}

/**
 * Split the code inside a template's `{{ }}` actions into parts, each with
 * the outputs a `hasKey` guard guarantees exist there. Comments are dropped.
 */
export function scanGuardedCode(content: string): GuardedCode[] {
  const parts: GuardedCode[] = []
  const branches: Branch[] = []
  const inForce = () => branches.at(-1)?.current ?? NONE

  for (const [, action = ""] of content.matchAll(ACTION_PATTERN)) {
    const code = action.trim()
    if (code.startsWith("/*")) continue

    const [, keyword = "", rest = ""] = KEYWORD_PATTERN.exec(code) ?? []
    switch (keyword) {
      case "if": {
        const outer = inForce()
        const condition = parseCondition(rest, outer)
        parts.push(...condition.parts)
        branches.push({
          current: union(outer, condition.holds),
          otherwise: union(outer, condition.fails),
        })
        break
      }
      case "else": {
        const branch = branches.at(-1)
        if (!branch) break
        const elseIf = ELSE_IF_PATTERN.exec(rest)
        if (elseIf) {
          // `else if` runs only once every earlier condition has failed.
          const condition = parseCondition(elseIf[1] ?? "", branch.otherwise)
          parts.push(...condition.parts)
          branch.current = union(branch.otherwise, condition.holds)
          branch.otherwise = union(branch.otherwise, condition.fails)
        } else {
          // A plain `else`, or `else with <pipeline>`
          if (rest) parts.push({ code: rest, guarded: branch.otherwise })
          branch.current = branch.otherwise
        }
        break
      }
      case "end":
        branches.pop()
        break
      case "define":
        // The body runs wherever the template is called, not where it's
        // written, so no guard around it applies.
        branches.push({ current: NONE, otherwise: NONE })
        break
      case "with":
      case "range":
      case "block":
        parts.push({ code: rest, guarded: inForce() })
        branches.push({ current: inForce(), otherwise: inForce() })
        break
      default:
        parts.push({ code, guarded: inForce() })
    }
  }

  return parts
}

/**
 * What an `if` condition guarantees. Recognised: `hasKey <outputs map> "<key>"`,
 * `not (hasKey …)`, and `and` with `(hasKey …)` arguments. Since Go 1.18,
 * `and` stops at its first false argument, so each argument also runs only
 * after the guards before it held.
 */
function parseCondition(pipeline: string, outer: ReadonlySet<string>): Condition {
  const guard = guardOf(pipeline)
  if (guard) return { parts: [], holds: new Set([guard]), fails: NONE }

  const args = splitArgs(unwrap(pipeline))
  if (args?.[0] === "not" && args.length === 2) {
    const negated = guardOf(args[1]!)
    if (negated) return { parts: [], holds: NONE, fails: new Set([negated]) }
  }
  if (args?.[0] === "and") {
    const held = new Set<string>()
    const parts: GuardedCode[] = []
    for (const arg of args.slice(1)) {
      parts.push({ code: arg, guarded: union(outer, held) })
      const argGuard = guardOf(arg)
      if (argGuard) held.add(argGuard)
    }
    return { parts, holds: held, fails: NONE }
  }

  return { parts: [{ code: pipeline, guarded: outer }], holds: NONE, fails: NONE }
}

/** The `outputs.<block_id>.<key>` path `hasKey <outputs map> "<key>"` checks, if `expr` is one. */
function guardOf(expr: string): string | undefined {
  const args = splitArgs(unwrap(expr))
  if (args?.length !== 3 || args[0] !== "hasKey") return undefined
  const [, blockId] = GUARDED_MAP_PATTERN.exec(unwrap(args[1]!)) ?? []
  const [, quoted, backquoted] = GUARDED_KEY_PATTERN.exec(args[2]!) ?? []
  const key = quoted ?? backquoted
  if (!blockId || !key) return undefined
  return `outputs.${blockId.replaceAll("-", "_")}.${key}`
}

/**
 * Split a pipeline into its top-level arguments: `hasKey (.outputs.x) "y"`
 * gives `hasKey`, `(.outputs.x)`, `"y"`. Undefined for a pipeline with a
 * top-level `|`, or one whose parentheses or quotes don't balance.
 */
function splitArgs(pipeline: string): string[] | undefined {
  const args: string[] = []
  let depth = 0
  let start = -1
  for (let i = 0; i < pipeline.length; i++) {
    const char = pipeline[i]!
    if (depth === 0 && /\s/.test(char)) {
      if (start >= 0) args.push(pipeline.slice(start, i))
      start = -1
      continue
    }
    if (depth === 0 && char === "|") return undefined
    if (start < 0) start = i
    if (char === '"' || char === "`" || char === "'") {
      i = closingQuote(pipeline, i)
      if (i < 0) return undefined
    } else if (char === "(") {
      depth++
    } else if (char === ")" && --depth < 0) {
      return undefined
    }
  }
  if (depth !== 0) return undefined
  if (start >= 0) args.push(pipeline.slice(start))
  return args
}

/** Strip parentheses that wrap the whole expression: `((x y))` gives `x y`. */
function unwrap(expr: string): string {
  let inner = expr.trim()
  while (inner.startsWith("(") && closingParen(inner) === inner.length - 1) {
    inner = inner.slice(1, -1).trim()
  }
  return inner
}

/** The index of the `)` that closes the `(` at the start of `code`, or -1. */
function closingParen(code: string): number {
  let depth = 0
  for (let i = 0; i < code.length; i++) {
    const char = code[i]
    if (char === '"' || char === "`" || char === "'") {
      i = closingQuote(code, i)
      if (i < 0) return -1
    } else if (char === "(") {
      depth++
    } else if (char === ")" && --depth === 0) {
      return i
    }
  }
  return -1
}

/** The index of the quote that closes the string literal opening at `open`, or -1. */
function closingQuote(code: string, open: number): number {
  const quote = code[open]
  for (let i = open + 1; i < code.length; i++) {
    if (code[i] === "\\" && quote !== "`") i++
    else if (code[i] === quote) return i
  }
  return -1
}

function union(a: ReadonlySet<string>, b: ReadonlySet<string>): ReadonlySet<string> {
  if (b.size === 0) return a
  if (a.size === 0) return b
  return new Set([...a, ...b])
}
