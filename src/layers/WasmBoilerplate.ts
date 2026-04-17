/**
 * BoilerplateRenderer implementation.
 *
 * Two concerns live here:
 *
 *  - `renderFile`: pure-TS Go text/template-compatible engine, used by
 *    `<TemplateInline>` for live preview of inline template snippets. We can't
 *    shell out per keystroke, so a small hand-rolled renderer handles this.
 *
 *  - `renderTemplate`: shells out to the `boilerplate` CLI. This covers the
 *    full boilerplate feature surface (dependencies, skip_files, hooks,
 *    partials, all built-in functions) without us maintaining a reimplementation.
 *
 * The inline engine supports: {{ .path.to.value }}, {{ if EXPR }}...{{ end }},
 * {{ range ... }}...{{ end }}, {{ fromJson .x }}, {{ toJson .x }}, and pipes
 * `{{ EXPR | fn arg | fn2 }}` with a small function table. It is not a
 * complete Go text/template and is intentionally minimal.
 */
import path from "node:path"
import { Effect, Layer, Stream } from "effect"
import { BoilerplateRenderer } from "../services/BoilerplateRenderer.ts"
import type { BoilerplateRendererShape } from "../services/BoilerplateRenderer.ts"
import { FileSystem } from "../services/FileSystem.ts"
import { ProcessSpawner } from "../services/ProcessSpawner.ts"
import { RenderError } from "../errors/index.ts"

// ---------------------------------------------------------------------------
// Variable resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a dot-separated path against a nested object.
 * e.g. resolveDotPath({ inputs: { region: "us-east-1" } }, "inputs.region") => "us-east-1"
 */
function resolveDotPath(obj: unknown, dotPath: string): unknown {
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
 * Stack of variable scopes. Each scope is a flat record of $name -> value.
 * `.foo.bar` dot-path access always goes to the root vars object — `$name`
 * lookups walk the stack top-down so inner `range` shadows outer.
 */
type Scope = Record<string, unknown>

class ScopeStack {
  private readonly frames: Scope[] = [{}]
  /**
   * Stack of "current dot" rebindings — pushed when `range` has no `:=`
   * binding so `.` and `.field` resolve against the iterated item rather
   * than the root vars. Empty stack means dot resolves to root.
   */
  private readonly dotFrames: unknown[] = []

  push(frame: Scope): void {
    this.frames.push(frame)
  }

  pop(): void {
    if (this.frames.length === 1) return
    this.frames.pop()
  }

  pushDot(value: unknown): void {
    this.dotFrames.push(value)
  }

  popDot(): void {
    this.dotFrames.pop()
  }

  /** Returns the current `.` rebound value, or undefined if at root. */
  currentDot(): unknown {
    if (this.dotFrames.length === 0) return undefined
    return this.dotFrames[this.dotFrames.length - 1]
  }

  /** Look up `$name` from the innermost scope outward. */
  get(name: string): unknown {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      if (name in this.frames[i]) return this.frames[i][name]
    }
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TextToken = { kind: "text"; value: string }
type ActionToken = {
  kind: "action"
  /** Body of the `{{ ... }}` with trim markers stripped, trimmed. */
  body: string
  /** True when the action started with `{{-`. */
  trimLeft: boolean
  /** True when the action ended with `-}}`. */
  trimRight: boolean
}
type Token = TextToken | ActionToken

/**
 * Walk the source string and produce a flat list of text + action tokens.
 * Whitespace-trim markers (`{{-` / `-}}`) are honored when tokens are later
 * joined back to a string.
 */
function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < source.length) {
    const start = source.indexOf("{{", i)
    if (start === -1) {
      tokens.push({ kind: "text", value: source.slice(i) })
      break
    }
    if (start > i) {
      tokens.push({ kind: "text", value: source.slice(i, start) })
    }
    // Detect `{{-` (with mandatory space after to match Go semantics, but we're
    // permissive — accept `{{-` followed by anything).
    let bodyStart = start + 2
    let trimLeft = false
    if (source[bodyStart] === "-") {
      trimLeft = true
      bodyStart += 1
    }

    // Find the closing `}}`.
    const end = source.indexOf("}}", bodyStart)
    if (end === -1) {
      // Unterminated action — treat the rest as literal text, which matches
      // Go's behavior of erroring; here we just bail to keep rendering robust.
      tokens.push({ kind: "text", value: source.slice(start) })
      break
    }

    let bodyEnd = end
    let trimRight = false
    if (source[end - 1] === "-") {
      trimRight = true
      bodyEnd = end - 1
    }

    const body = source.slice(bodyStart, bodyEnd).trim()
    tokens.push({ kind: "action", body, trimLeft, trimRight })
    i = end + 2
  }
  return tokens
}

// ---------------------------------------------------------------------------
// Block parser (tokens -> AST)
// ---------------------------------------------------------------------------

type TextNode = { type: "text"; value: string; trimLeft: boolean; trimRight: boolean }
type ActionNode = {
  type: "action"
  body: string
  trimLeft: boolean
  trimRight: boolean
}
type IfBranch = { cond: string | null /* null = else */; body: TemplateNode[] }
type IfNode = {
  type: "if"
  branches: IfBranch[]
  /** Trim markers from the opening `{{ if }}` and closing `{{ end }}` */
  openTrimLeft: boolean
  closeTrimRight: boolean
}
type RangeNode = {
  type: "range"
  /** Original range header body, e.g. `range $k, $v := .inputs.AWSAccounts`. */
  header: string
  body: TemplateNode[]
  openTrimLeft: boolean
  closeTrimRight: boolean
}
type TemplateNode = TextNode | ActionNode | IfNode | RangeNode

function classifyAction(body: string): "if" | "else_if" | "else" | "end" | "range" | "expr" {
  if (/^if\b/.test(body)) return "if"
  if (/^else\s+if\b/.test(body)) return "else_if"
  if (/^else\b/.test(body)) return "else"
  if (/^end\b/.test(body)) return "end"
  if (/^range\b/.test(body)) return "range"
  return "expr"
}

/**
 * Convert text + action tokens into a nested AST. Handles `if` / `else if` /
 * `else` / `end` and `range` / `end` with proper nesting.
 *
 * Implemented as a single-pass recursive descent over a cursor-tracked token
 * array. Returns the nodes parsed at the current depth and updates the cursor
 * via the returned `next` index.
 */
function parseBlocks(tokens: Token[]): TemplateNode[] {
  const result = parseBlocksFrom(tokens, 0, null)
  return result.nodes
}

type Stop = "end" | "else" | "else_if" | null

function parseBlocksFrom(
  tokens: Token[],
  start: number,
  stop: Stop,
): { nodes: TemplateNode[]; next: number; stoppedOn: ActionToken | null } {
  const nodes: TemplateNode[] = []
  let i = start
  while (i < tokens.length) {
    const tok = tokens[i]
    if (tok.kind === "text") {
      nodes.push({ type: "text", value: tok.value, trimLeft: false, trimRight: false })
      i += 1
      continue
    }
    const cls = classifyAction(tok.body)

    if (
      (stop === "end" && (cls === "end" || cls === "else" || cls === "else_if")) ||
      (stop === "else" && (cls === "end" || cls === "else" || cls === "else_if")) ||
      (stop === "else_if" && (cls === "end" || cls === "else" || cls === "else_if"))
    ) {
      return { nodes, next: i, stoppedOn: tok }
    }

    if (cls === "if") {
      const ifNode: IfNode = {
        type: "if",
        branches: [],
        openTrimLeft: tok.trimLeft,
        closeTrimRight: false,
      }
      const cond = tok.body.replace(/^if\s+/, "").trim()
      // Apply the open `{{ if -}}`/`{{ if }}` trim markers to the previous
      // and following text nodes by mutating them after the fact.
      applyTrimLeftToPrev(nodes, tok.trimLeft)
      let cursor = i + 1
      let nextCond: string | null = cond
      while (true) {
        const branch = parseBlocksFrom(tokens, cursor, "else")
        // The opening action's `-}}` trim-right applies to the first text
        // node of the branch (the just-opened `if`/`else if`/`else`).
        const openTok = cursor === i + 1 ? tok : tokens[cursor - 1] as ActionToken
        if (openTok && openTok.kind === "action") {
          applyTrimRightToFirstText(branch.nodes, openTok.trimRight)
        }
        ifNode.branches.push({ cond: nextCond, body: branch.nodes })

        const term = branch.stoppedOn
        if (!term) {
          // EOF before `{{ end }}` — bail with what we have.
          i = branch.next
          break
        }
        const termClass = classifyAction(term.body)
        // The terminator's trim-left applies to the last text node of the
        // just-finished branch.
        applyTrimLeftToLast(branch.nodes, term.trimLeft)
        if (termClass === "end") {
          ifNode.closeTrimRight = term.trimRight
          // The `{{ end -}}` trim-right will be applied to the next text node
          // by the caller via applyTrimRightToFirst when we exit this if.
          i = branch.next + 1
          break
        }
        if (termClass === "else") {
          // Parse the else body.
          cursor = branch.next + 1
          nextCond = null
          // After parsing we'll loop and expect `end`.
          continue
        }
        if (termClass === "else_if") {
          cursor = branch.next + 1
          nextCond = term.body.replace(/^else\s+if\s+/, "").trim()
          continue
        }
        // Should not happen — bail.
        i = branch.next + 1
        break
      }
      nodes.push(ifNode)
      // Hack: stash the `{{ end -}}` trim-right onto the next text token via
      // a sentinel by trimming the next text node when we render.
      // We instead track closeTrimRight on the IfNode and apply at render time.
      continue
    }

    if (cls === "range") {
      const header = tok.body
      applyTrimLeftToPrev(nodes, tok.trimLeft)
      const branch = parseBlocksFrom(tokens, i + 1, "end")
      const term = branch.stoppedOn
      applyTrimRightToFirstText(branch.nodes, tok.trimRight)
      let closeTrimRight = false
      let nextI: number
      if (term && classifyAction(term.body) === "end") {
        applyTrimLeftToLast(branch.nodes, term.trimLeft)
        closeTrimRight = term.trimRight
        nextI = branch.next + 1
      } else {
        nextI = branch.next
      }
      nodes.push({
        type: "range",
        header,
        body: branch.nodes,
        openTrimLeft: tok.trimLeft,
        closeTrimRight,
      })
      i = nextI
      continue
    }

    if (cls === "end" || cls === "else" || cls === "else_if") {
      // Stray terminator at top level — drop it.
      i += 1
      continue
    }

    // Plain expression (or unknown): keep as ActionNode.
    applyTrimLeftToPrev(nodes, tok.trimLeft)
    nodes.push({
      type: "action",
      body: tok.body,
      trimLeft: tok.trimLeft,
      trimRight: tok.trimRight,
    })
    i += 1
  }
  return { nodes, next: i, stoppedOn: null }
}

/**
 * Honor the `{{- ...}}` trim-left marker: strip ALL trailing whitespace from
 * the previous text node (matching Go template `-}}`/`{{-` semantics, which
 * eat any contiguous whitespace including newlines).
 */
function applyTrimLeftToPrev(nodes: TemplateNode[], trim: boolean): void {
  if (!trim) return
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i]
    if (n.type === "text") {
      n.value = n.value.replace(/\s+$/, "")
      return
    }
  }
}

/** Strip leading whitespace from the next text node by trimming the next text we encounter. */
function applyTrimRightToFirstText(nodes: TemplateNode[], trim: boolean): void {
  if (!trim) return
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    if (n.type === "text") {
      n.value = n.value.replace(/^\s+/, "")
      return
    }
  }
}

/** Apply `{{- end }}` style trim-left to the LAST text node of a branch body. */
function applyTrimLeftToLast(nodes: TemplateNode[], trim: boolean): void {
  if (!trim) return
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i]
    if (n.type === "text") {
      n.value = n.value.replace(/\s+$/, "")
      return
    }
  }
}

// ---------------------------------------------------------------------------
// Expression evaluator (eq/ne/not/and/or, dot-paths, $vars, literals)
// ---------------------------------------------------------------------------

type Operand =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "bool"; value: boolean }
  | { kind: "dotpath"; path: string }
  | { kind: "var"; name: string; field?: string }
  | { kind: "call"; name: string; args: Operand[] }
  | { kind: "group"; inner: Operand }

/**
 * Tokenize an expression string. Returns ordered tokens; supports identifiers,
 * dot-paths, $vars, parentheses, string literals (single/double-quoted),
 * numbers, and bare `true` / `false`.
 */
type EToken =
  | { t: "ident"; v: string }
  | { t: "dot"; v: string }
  | { t: "var"; v: string }
  | { t: "string"; v: string }
  | { t: "number"; v: number }
  | { t: "bool"; v: boolean }
  | { t: "lparen" }
  | { t: "rparen" }

function tokenizeExpr(expr: string): EToken[] {
  const out: EToken[] = []
  let i = 0
  while (i < expr.length) {
    const c = expr[i]
    if (/\s/.test(c)) { i += 1; continue }
    if (c === "(") { out.push({ t: "lparen" }); i += 1; continue }
    if (c === ")") { out.push({ t: "rparen" }); i += 1; continue }
    if (c === '"' || c === "'") {
      const quote = c
      let j = i + 1
      let s = ""
      while (j < expr.length && expr[j] !== quote) {
        if (expr[j] === "\\" && j + 1 < expr.length) {
          const n = expr[j + 1]
          if (n === "n") s += "\n"
          else if (n === "t") s += "\t"
          else if (n === "r") s += "\r"
          else if (n === "\\") s += "\\"
          else if (n === quote) s += quote
          else s += n
          j += 2
          continue
        }
        s += expr[j]
        j += 1
      }
      out.push({ t: "string", v: s })
      i = j + 1
      continue
    }
    if (c === ".") {
      // Dot-path: `.foo.bar.baz`
      let j = i + 1
      while (j < expr.length && /[A-Za-z0-9_.]/.test(expr[j])) j += 1
      out.push({ t: "dot", v: expr.slice(i + 1, j) })
      i = j
      continue
    }
    if (c === "$") {
      let j = i + 1
      while (j < expr.length && /[A-Za-z0-9_.]/.test(expr[j])) j += 1
      out.push({ t: "var", v: expr.slice(i + 1, j) })
      i = j
      continue
    }
    if (/[0-9-]/.test(c) && (c !== "-" || /[0-9]/.test(expr[i + 1] ?? ""))) {
      let j = i + 1
      while (j < expr.length && /[0-9.]/.test(expr[j])) j += 1
      const num = Number(expr.slice(i, j))
      if (!Number.isNaN(num)) {
        out.push({ t: "number", v: num })
        i = j
        continue
      }
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1
      while (j < expr.length && /[A-Za-z0-9_]/.test(expr[j])) j += 1
      const word = expr.slice(i, j)
      if (word === "true") out.push({ t: "bool", v: true })
      else if (word === "false") out.push({ t: "bool", v: false })
      else out.push({ t: "ident", v: word })
      i = j
      continue
    }
    // Unknown char — skip to avoid infinite loop.
    i += 1
  }
  return out
}

/**
 * Parse an expression's token stream. Supports nested calls of the form
 * `fn arg1 arg2 ...` and parenthesized sub-expressions. The grammar matches
 * Go template usage well enough for: `eq .x "a"`, `not .x`, `or (eq .x "a") (eq .x "b")`.
 *
 * We treat any leading identifier as a function call whose arguments are the
 * remaining whitespace-separated operands at the current depth.
 */
function parseExpr(tokens: EToken[]): Operand {
  const r = parseExprFrom(tokens, 0)
  return r.node
}

function parseExprFrom(
  tokens: EToken[],
  start: number,
): { node: Operand; next: number } {
  if (start >= tokens.length) {
    return { node: { kind: "string", value: "" }, next: start }
  }
  const head = tokens[start]
  if (head.t === "lparen") {
    const inner = parseExprFrom(tokens, start + 1)
    let next = inner.next
    if (tokens[next] && tokens[next].t === "rparen") next += 1
    return { node: { kind: "group", inner: inner.node }, next }
  }
  if (head.t === "ident") {
    // Parse function call with remaining args until rparen / EOF.
    const args: Operand[] = []
    let i = start + 1
    while (i < tokens.length) {
      const t = tokens[i]
      if (t.t === "rparen") break
      const arg = parseAtomFrom(tokens, i)
      args.push(arg.node)
      i = arg.next
    }
    return { node: { kind: "call", name: head.v, args }, next: i }
  }
  return parseAtomFrom(tokens, start)
}

function parseAtomFrom(
  tokens: EToken[],
  start: number,
): { node: Operand; next: number } {
  const head = tokens[start]
  if (!head) return { node: { kind: "string", value: "" }, next: start }
  if (head.t === "lparen") {
    const inner = parseExprFrom(tokens, start + 1)
    let next = inner.next
    if (tokens[next] && tokens[next].t === "rparen") next += 1
    return { node: { kind: "group", inner: inner.node }, next }
  }
  if (head.t === "string") return { node: { kind: "string", value: head.v }, next: start + 1 }
  if (head.t === "number") return { node: { kind: "number", value: head.v }, next: start + 1 }
  if (head.t === "bool") return { node: { kind: "bool", value: head.v }, next: start + 1 }
  if (head.t === "dot") return { node: { kind: "dotpath", path: head.v }, next: start + 1 }
  if (head.t === "var") {
    // Allow `$value.field`
    const dotIdx = head.v.indexOf(".")
    if (dotIdx !== -1) {
      return {
        node: { kind: "var", name: head.v.slice(0, dotIdx), field: head.v.slice(dotIdx + 1) },
        next: start + 1,
      }
    }
    return { node: { kind: "var", name: head.v }, next: start + 1 }
  }
  if (head.t === "ident") {
    return { node: { kind: "call", name: head.v, args: [] }, next: start + 1 }
  }
  return { node: { kind: "string", value: "" }, next: start + 1 }
}

/** True if a value is "truthy" by Go template semantics. */
function isTruthy(v: unknown): boolean {
  if (v === undefined || v === null) return false
  if (typeof v === "string") return v.length > 0
  if (typeof v === "number") return v !== 0
  if (typeof v === "boolean") return v
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === "object") return Object.keys(v as object).length > 0
  return Boolean(v)
}

/**
 * Evaluate an Operand to a JS value. Strings/numbers/bools are returned as-is;
 * dotpaths resolve against root vars; $vars walk the scope stack.
 */
function evalOperand(
  op: Operand,
  rootVars: Record<string, unknown>,
  scopes: ScopeStack,
): unknown {
  switch (op.kind) {
    case "string": return op.value
    case "number": return op.value
    case "bool": return op.value
    case "dotpath": {
      // When inside a dot-rebinding `range` (one without `$var :=`), the
      // current dot value shadows the root vars for `.` and `.field`.
      const dot = scopes.currentDot()
      const base = dot === undefined ? rootVars : dot
      if (op.path === "") return base
      return resolveDotPath(base, op.path)
    }
    case "var": {
      const base = scopes.get(op.name)
      if (op.field) return resolveDotPath(base, op.field)
      return base
    }
    case "group": return evalOperand(op.inner, rootVars, scopes)
    case "call": return evalCall(op, rootVars, scopes)
  }
}

function evalCall(
  op: Extract<Operand, { kind: "call" }>,
  rootVars: Record<string, unknown>,
  scopes: ScopeStack,
): unknown {
  const { name, args } = op
  switch (name) {
    case "eq": {
      if (args.length < 2) return false
      const a = evalOperand(args[0], rootVars, scopes)
      for (let i = 1; i < args.length; i++) {
        const b = evalOperand(args[i], rootVars, scopes)
        if (!looseEquals(a, b)) return false
      }
      return true
    }
    case "ne": {
      if (args.length < 2) return false
      const a = evalOperand(args[0], rootVars, scopes)
      const b = evalOperand(args[1], rootVars, scopes)
      return !looseEquals(a, b)
    }
    case "not": {
      if (args.length === 0) return true
      return !isTruthy(evalOperand(args[0], rootVars, scopes))
    }
    case "and": {
      if (args.length === 0) return true
      let last: unknown = true
      for (const a of args) {
        last = evalOperand(a, rootVars, scopes)
        if (!isTruthy(last)) return last
      }
      return last
    }
    case "or": {
      if (args.length === 0) return false
      let last: unknown = false
      for (const a of args) {
        last = evalOperand(a, rootVars, scopes)
        if (isTruthy(last)) return last
      }
      return last
    }
    case "fromJson": {
      const v = evalOperand(args[0], rootVars, scopes)
      if (v === undefined || v === null) return undefined
      if (typeof v === "string") {
        try { return JSON.parse(v) } catch { return v }
      }
      return v
    }
    case "toJson": {
      const v = evalOperand(args[0], rootVars, scopes)
      if (v === undefined) return ""
      return JSON.stringify(v)
    }
    default: {
      // Head function call (no piped input). Evaluate args and dispatch
      // through the pipe-function table with `piped=undefined` so e.g.
      // `printf "%s=%d" "n" 7` reads its format from args[0].
      if (args.length === 0) return ""
      const evaluated = args.map((a) => evalOperand(a, rootVars, scopes))
      return applyPipeFunction(name, undefined, evaluated)
    }
  }
}

/** Compare operands the way Go's `eq` does for the simple cases we ship. */
function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a === "number" && typeof b === "number") return a === b
  if (typeof a === "string" && typeof b === "string") return a === b
  if (typeof a === "boolean" && typeof b === "boolean") return a === b
  // Cross-type: only equal if both stringify the same (e.g. "1" vs 1 => false).
  return false
}

// ---------------------------------------------------------------------------
// Pipe pipeline evaluator
// ---------------------------------------------------------------------------

/**
 * Split an action body on top-level `|` (not inside parentheses or quoted
 * strings). Returns each pipe segment as a string.
 */
function splitPipes(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let inStr: string | null = null
  let start = 0
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (inStr) {
      if (c === "\\" && i + 1 < body.length) { i += 1; continue }
      if (c === inStr) inStr = null
      continue
    }
    if (c === '"' || c === "'") { inStr = c; continue }
    if (c === "(") { depth += 1; continue }
    if (c === ")") { depth -= 1; continue }
    if (c === "|" && depth === 0) {
      parts.push(body.slice(start, i).trim())
      start = i + 1
    }
  }
  parts.push(body.slice(start).trim())
  return parts
}

/**
 * When true, `applyPipeFunction` throws on unknown function names instead of
 * falling back to pass-through. Used by the `skip_files` `if:` evaluator to
 * turn nonsense expressions into caught errors (which the caller logs and
 * treats as "keep the file"). Module-local so the public render path keeps
 * its permissive pass-through behavior.
 */
let strictUnknownFunctions = false

/** Convert any JS value to its Go template default-print representation. */
function stringify(v: unknown): string {
  if (v === undefined || v === null) return ""
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  // For maps/arrays in pipes, JSON.stringify is closer to Go's `%v` than
  // `[object Object]`.
  try { return JSON.stringify(v) } catch { return String(v) }
}

/**
 * Evaluate a single pipe segment (head or downstream) given the upstream
 * piped value. Returns the JS value (not necessarily a string) so chained
 * functions can branch on truthiness.
 *
 * For the head segment, `piped` is undefined and we just evaluate the
 * expression. For downstream segments, we parse the segment as a function
 * invocation and append `piped` as the LAST positional argument (Go template
 * semantics for pipes).
 */
function evalPipeSegment(
  segment: string,
  piped: unknown,
  isHead: boolean,
  rootVars: Record<string, unknown>,
  scopes: ScopeStack,
): unknown {
  const tokens = tokenizeExpr(segment)
  if (tokens.length === 0) return piped
  if (isHead) {
    return evalOperand(parseExpr(tokens), rootVars, scopes)
  }
  // Downstream: head must be an ident (function name); remaining tokens are args.
  const head = tokens[0]
  if (head.t !== "ident") {
    // e.g. piping into a dot-path doesn't really make sense — return piped.
    return piped
  }
  const args: Operand[] = []
  let i = 1
  while (i < tokens.length) {
    const a = parseAtomFrom(tokens, i)
    args.push(a.node)
    i = a.next
  }
  const evaluated = args.map((a) => evalOperand(a, rootVars, scopes))
  return applyPipeFunction(head.v, piped, evaluated)
}

/**
 * Built-in functions for the pipe / call layer. Unknown functions return the
 * piped input unchanged (never crash).
 *
 * Each built-in is callable in two shapes:
 *   - Head call:  `{{ upper "hi" }}`  — `piped=undefined`, args=["hi"]
 *   - Pipe call:  `{{ "hi" | upper }}` — `piped="hi"`, args=[]
 *
 * The head-call shape feeds args[0] in as the input and treats args.slice(1)
 * as supplemental positional args. The pipe-call shape uses `piped` directly.
 */
function applyPipeFunction(name: string, piped: unknown, args: unknown[]): unknown {
  switch (name) {
    case "printf": {
      // Head: args = [format, ...positional]
      // Pipe: args = [format, ...positional]; piped is appended as last arg.
      const fmt = String(args[0] ?? "")
      const positional = args.slice(1)
      if (piped !== undefined) positional.push(piped)
      return goPrintf(fmt, positional)
    }
    case "quote": {
      const input = piped !== undefined ? piped : args[0]
      const s = stringify(input)
      return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
    }
    case "upper": {
      const input = piped !== undefined ? piped : args[0]
      return stringify(input).toUpperCase()
    }
    case "lower": {
      const input = piped !== undefined ? piped : args[0]
      return stringify(input).toLowerCase()
    }
    case "hasPrefix": {
      // Go signature: hasPrefix prefix s — `s | hasPrefix "x"` means `hasPrefix("x", s)`.
      // Head call: hasPrefix prefix s -> args=[prefix, s], piped=undefined.
      // Pipe call: s | hasPrefix "x" -> args=[prefix], piped=s.
      const prefix = String(args[0] ?? "")
      const input = piped !== undefined ? piped : args[1]
      return stringify(input).startsWith(prefix)
    }
    case "hasSuffix": {
      const suffix = String(args[0] ?? "")
      const input = piped !== undefined ? piped : args[1]
      return stringify(input).endsWith(suffix)
    }
    case "default": {
      // Go: default fallback s -> if s is empty/nil use fallback.
      const fallback = args[0]
      const input = piped !== undefined ? piped : args[1]
      const s = stringify(input)
      if (s.length === 0) return fallback
      return input
    }
    default:
      if (strictUnknownFunctions) {
        throw new Error(`unknown template function: ${name}`)
      }
      // Unknown function: pass piped input through; for head calls, return
      // first arg unchanged so unknown identifiers don't disappear.
      return piped !== undefined ? piped : args[0]
  }
}

/**
 * Minimal Go-style printf implementing %s, %q, %d, %v, %%. Other verbs fall
 * back to %v. Width / precision flags are not supported.
 */
function goPrintf(format: string, args: unknown[]): string {
  let out = ""
  let argIdx = 0
  let i = 0
  while (i < format.length) {
    const c = format[i]
    if (c !== "%") { out += c; i += 1; continue }
    const verb = format[i + 1]
    if (verb === undefined) { out += c; i += 1; continue }
    if (verb === "%") { out += "%"; i += 2; continue }
    const arg = args[argIdx]
    argIdx += 1
    switch (verb) {
      case "s": out += stringify(arg); break
      case "q": {
        // Go's %q wraps strings in double-quotes with Go-string escaping. We
        // approximate with JSON.stringify (matches plan note).
        out += JSON.stringify(stringify(arg))
        break
      }
      case "d": {
        const n = Number(arg)
        out += Number.isFinite(n) ? String(Math.trunc(n)) : String(arg)
        break
      }
      case "v":
      default: out += stringify(arg)
    }
    i += 2
  }
  return out
}

// ---------------------------------------------------------------------------
// AST renderer
// ---------------------------------------------------------------------------

function renderNodes(
  nodes: TemplateNode[],
  rootVars: Record<string, unknown>,
  scopes: ScopeStack,
): string {
  let out = ""
  for (const n of nodes) {
    out += renderNode(n, rootVars, scopes)
  }
  return out
}

function renderNode(
  node: TemplateNode,
  rootVars: Record<string, unknown>,
  scopes: ScopeStack,
): string {
  switch (node.type) {
    case "text": return node.value
    case "action": return renderActionExpr(node.body, rootVars, scopes)
    case "if": {
      for (const branch of node.branches) {
        if (branch.cond === null) {
          return renderNodes(branch.body, rootVars, scopes)
        }
        const v = evalExpression(branch.cond, rootVars, scopes)
        if (isTruthy(v)) {
          return renderNodes(branch.body, rootVars, scopes)
        }
      }
      return ""
    }
    case "range": return renderRange(node, rootVars, scopes)
  }
}

/**
 * Evaluate an action expression body (no leading keyword) including pipes.
 */
function evalExpression(
  body: string,
  rootVars: Record<string, unknown>,
  scopes: ScopeStack,
): unknown {
  const segs = splitPipes(body)
  let value: unknown = undefined
  for (let i = 0; i < segs.length; i++) {
    value = evalPipeSegment(segs[i], i === 0 ? undefined : value, i === 0, rootVars, scopes)
  }
  return value
}

/**
 * Render a `{{ ... }}` action's body to the output string. The body is the
 * expression after the leading keyword has been stripped (or the bare
 * expression for non-keyword actions).
 */
function renderActionExpr(
  body: string,
  rootVars: Record<string, unknown>,
  scopes: ScopeStack,
): string {
  const v = evalExpression(body, rootVars, scopes)
  if (v === undefined || v === null) return ""
  return stringify(v)
}

/**
 * Parse a `range` header into its variable bindings and the iterable
 * expression body.
 *
 *   range $k, $v := <expr>
 *   range $v := <expr>
 *   range <expr>
 */
function parseRangeHeader(header: string): {
  keyVar: string | null
  valVar: string | null
  iterExpr: string
} {
  // Strip leading `range` keyword and surrounding whitespace.
  const body = header.replace(/^range\s+/, "").trim()

  // Match `$k , $v := REST` or `$v := REST`.
  const twoVar = /^\$(\w+)\s*,\s*\$(\w+)\s*:=\s*(.*)$/s.exec(body)
  if (twoVar) {
    return { keyVar: twoVar[1], valVar: twoVar[2], iterExpr: twoVar[3].trim() }
  }
  const oneVar = /^\$(\w+)\s*:=\s*(.*)$/s.exec(body)
  if (oneVar) {
    return { keyVar: null, valVar: oneVar[1], iterExpr: oneVar[2].trim() }
  }
  return { keyVar: null, valVar: null, iterExpr: body }
}

function renderRange(
  node: RangeNode,
  rootVars: Record<string, unknown>,
  scopes: ScopeStack,
): string {
  const { keyVar, valVar, iterExpr } = parseRangeHeader(node.header)
  const iter = evalExpression(iterExpr, rootVars, scopes)
  if (iter === undefined || iter === null) return ""

  // Treat strings that look like JSON as already-parsed values to support the
  // legacy `(fromJson .x)` use case when callers pass through a raw value.
  let parsed: unknown = iter
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed) } catch { /* keep as string */ }
  }

  const iterations: Array<{ key: unknown; value: unknown }> = []
  if (Array.isArray(parsed)) {
    parsed.forEach((v, i) => iterations.push({ key: i, value: v }))
  } else if (parsed && typeof parsed === "object") {
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      iterations.push({ key: k, value: v })
    }
  } else {
    return ""
  }

  const dotRebind = keyVar === null && valVar === null

  let out = ""
  for (const { key, value } of iterations) {
    const frame: Scope = {}
    if (keyVar !== null) frame[keyVar] = key
    if (valVar !== null) frame[valVar] = value
    scopes.push(frame)
    if (dotRebind) scopes.pushDot(value)
    try {
      out += renderNodes(node.body, rootVars, scopes)
    } finally {
      if (dotRebind) scopes.popDot()
      scopes.pop()
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Public render entry point
// ---------------------------------------------------------------------------

/**
 * Render a Go text/template string with the given variables.
 *
 * Supported constructs:
 *   - `{{ .path.to.value }}` and `{{ $var }}` / `{{ $value.field }}`
 *   - `{{ if EXPR }}...{{ else if EXPR }}...{{ else }}...{{ end }}`
 *   - `{{ range $k, $v := EXPR }}...{{ end }}` (and 1-var / no-var forms)
 *   - `{{ EXPR | fn arg | fn2 }}` pipes (printf, quote, upper, lower,
 *     hasPrefix, hasSuffix, default; unknown fns pass-through)
 *   - `eq` / `ne` / `not` / `and` / `or` predicates inside conditions
 *   - `fromJson` / `toJson` for JSON-string conversion
 *   - Whitespace trim markers `{{- ... -}}`
 */
function renderGoTemplate(
  content: string,
  vars: Record<string, unknown>,
): string {
  const tokens = tokenize(content)
  const ast = parseBlocks(tokens)
  const scopes = new ScopeStack()
  return renderNodes(ast, vars, scopes)
}

// ---------------------------------------------------------------------------
// Subprocess-backed renderTemplate
// ---------------------------------------------------------------------------

/**
 * Location of the `boilerplate` binary.
 *
 * Resolution order:
 *   1. `BOILERPLATE_BIN` env var (absolute path or bare command name)
 *   2. Bare `boilerplate` — relies on the user's PATH
 *
 * The binary is invoked in non-interactive mode with `--disable-dependency-prompt`,
 * so dependencies (remote templates) are pulled in without any stdin prompts.
 */
function resolveBoilerplateBinary(): string {
  const env = process.env.BOILERPLATE_BIN
  if (env && env.length > 0) return env
  return "boilerplate"
}

/**
 * Write a YAML file containing the rendered variables for `--var-file`.
 *
 * Boilerplate accepts arbitrarily-nested YAML values, so we let the `yaml`
 * package handle all primitives + nested maps/arrays. The file is written to
 * a unique path under `os.tmpdir()` and is the caller's responsibility to rm.
 */
function writeVarFile(
  variables: Record<string, unknown>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem
    const YAML = yield* Effect.promise(() => import("yaml"))
    const yamlText = YAML.stringify(variables ?? {})
    console.log("[boilerplate] var-file YAML (first 1200 chars):\n" + yamlText.slice(0, 1200))
    const tmpDir = yield* fs.mkdtemp("boilerplate-vars-").pipe(
      Effect.mapError(
        (err) =>
          new RenderError({
            message: "Failed to create temp directory for variables file",
            cause: err,
          }),
      ),
    )
    const varFilePath = path.join(tmpDir, "vars.yml")
    yield* fs.writeFile(varFilePath, yamlText).pipe(
      Effect.mapError(
        (err) =>
          new RenderError({
            message: `Failed to write variables file: ${varFilePath}`,
            cause: err,
          }),
      ),
    )
    return { varFilePath, varFileDir: tmpDir }
  })
}

/**
 * Shell out to the boilerplate CLI to render a template tree.
 *
 * Streams stdout/stderr into buffers so that, on non-zero exit, the `stderr`
 * text can be surfaced through the resulting `RenderError` (makes
 * configuration mistakes in templates readable in the UI rather than a bare
 * "exit code 1").
 */
function runBoilerplate(
  templateDir: string,
  outputDir: string,
  varFilePath: string,
) {
  return Effect.gen(function* () {
    const spawner = yield* ProcessSpawner
    const binary = resolveBoilerplateBinary()
    const args = [
      "--template-url", templateDir,
      "--output-folder", outputDir,
      "--var-file", varFilePath,
      "--non-interactive",
      "--disable-dependency-prompt",
    ]

    const proc = yield* spawner.spawn(binary, args).pipe(
      Effect.mapError(
        (err) =>
          new RenderError({
            message: `Failed to spawn boilerplate binary "${binary}". Ensure it is installed and on PATH, or set BOILERPLATE_BIN.`,
            cause: err,
          }),
      ),
    )

    // Wait for the subprocess to finish, but if our fiber is interrupted
    // (e.g. a newer render superseded this one), kill the subprocess so we
    // stop paying for CPU/network we no longer want. Without this, a stale
    // boilerplate CLI run would keep running in the background.
    return yield* Effect.gen(function* () {
      // Drain output (the spawner collects lines and emits them once the
      // process exits; stderr lines carry user-facing error detail).
      const lines = yield* Stream.runCollect(proc.output).pipe(
        Effect.catchAll(() =>
          Effect.succeed<Iterable<{ line: string; source: "stdout" | "stderr" }>>([]),
        ),
      )
      const stderrLines: string[] = []
      for (const l of lines) {
        if (l.source === "stderr") stderrLines.push(l.line)
      }

      const code = yield* proc.exitCode.pipe(
        Effect.catchAll(() => Effect.succeed(1)),
      )
      if (code !== 0) {
        const stderrText = stderrLines.join("\n").trim()
        return yield* Effect.fail(
          new RenderError({
            message: stderrText.length > 0
              ? `boilerplate exited with code ${code}: ${stderrText}`
              : `boilerplate exited with code ${code}`,
          }),
        )
      }
    }).pipe(Effect.onInterrupt(() => proc.kill))
  })
}

// ---------------------------------------------------------------------------
// Service implementation
// ---------------------------------------------------------------------------

/**
 * `renderFile` uses the in-process TS template engine for inline previews —
 * subprocess startup would make per-keystroke rendering intolerable.
 *
 * `renderTemplate` shells out to the real `boilerplate` binary for full
 * feature parity (dependencies, skip_files, hooks, partials, etc).
 */
export const WasmBoilerplateLive = Layer.effect(
  BoilerplateRenderer,
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const spawner = yield* ProcessSpawner

    const impl: BoilerplateRendererShape = {
      renderFile: (templateContent: string, variables: Record<string, unknown>) =>
        Effect.try({
          try: () => renderGoTemplate(templateContent, variables),
          catch: (err) => new RenderError({ message: String(err) }),
        }),

      renderTemplate: (
        templateDir: string,
        outputDir: string,
        variables: Record<string, unknown>,
      ) =>
        Effect.gen(function* () {
          // Ensure output root exists so boilerplate doesn't trip on it.
          yield* fs.mkdir(outputDir, { recursive: true }).pipe(
            Effect.mapError(
              (err) =>
                new RenderError({
                  message: `Failed to create output directory: ${outputDir}`,
                  cause: err,
                }),
            ),
          )

          const { varFilePath, varFileDir } = yield* writeVarFile(variables)
          yield* runBoilerplate(templateDir, outputDir, varFilePath).pipe(
            // Best-effort cleanup — never let a cleanup failure mask a render error.
            Effect.ensuring(fs.rm(varFileDir, { recursive: true, force: true }).pipe(Effect.ignore)),
          )
        }).pipe(
          Effect.provideService(FileSystem, fs),
          Effect.provideService(ProcessSpawner, spawner),
        ),
    }

    return impl
  }),
)
