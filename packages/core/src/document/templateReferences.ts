/**
 * The one template-reference extractor: the `{{ .inputs.X }}` and
 * `{{ .outputs.B.K }}` references in a Go template, each with where it is
 * written and whether a `hasKey` guard covers it. The parser makes the
 * document's edges from it, and every other reader of a template (the
 * blockers, the script warning, a Template block's files) uses it too.
 *
 * Only references inside `{{ }}` actions count, not ones in comments or text.
 *
 * Templates render with missing-key-action=error, so reading an output its
 * block did not emit fails the render. A block that emits an output only
 * sometimes is read behind a guard:
 *
 *   {{ if hasKey .outputs.clone_repo "org_id" }}--org {{ .outputs.clone_repo.org_id }}{{ end }}
 *
 * A guard covers only the branch it opens. This follows `if`/`else`/`end`
 * nesting, so a reference outside that branch stays unguarded. Anything not
 * recognised as a guard leaves its references unguarded too: that keeps the
 * block waiting, where a wrong guess would let the render fail.
 */
import { Schema } from "effect"
import { BlockId } from "@runbooks/blocks-core/contract"
import type { Position, Span } from "./configError.ts"

/** `{{ .inputs.region }}`. A Map input's key keeps its dots: `.inputs.tags.env`. */
export interface InputReference {
  readonly _tag: "Input"
  readonly path: string
  readonly span: Span
}

/** `{{ .outputs.create_account.account_id }}`. */
export interface OutputReference {
  readonly _tag: "Output"
  readonly block: BlockId
  /** The id as written, which may have hyphens. */
  readonly blockAsWritten: string
  /** An identifier, like every key a block can output, so `.outputs.b.k.x` reads `k`. */
  readonly key: string
  /** Behind a `hasKey` guard for this key: the block must have run, the key may be absent. */
  readonly guarded: boolean
  readonly span: Span
}

export type TemplateReference = InputReference | OutputReference

/** An output that a set of templates reads, once. */
export interface OutputRead {
  readonly block: BlockId
  readonly blockAsWritten: string
  readonly key: string
  /** Every read of it is guarded. */
  readonly optional: boolean
}

/** Every reference in `template`, in the order written. Spans are 1-based, end exclusive. */
export function templateReferences(template: string): ReadonlyArray<TemplateReference> {
  const position = positionsIn(template)
  return scanGuarded(template).flatMap(({ code, guarded }) =>
    Array.from(code.text.matchAll(REFERENCE_PATTERN), (match): TemplateReference => {
      const start = code.at + match.index
      const span = { start: position(start), end: position(start + match[0].length) }
      const [, path, written, key] = match
      if (path !== undefined) return { _tag: "Input", path, span }
      const block = toBlockId(written!)
      return {
        _tag: "Output",
        block,
        blockAsWritten: written!,
        key: key!,
        guarded: guarded.has(guardKey(block, key!)),
        span,
      }
    }),
  )
}

/**
 * The outputs `templates` read, each once, in the order first read. A guard
 * covers only the template it is in, so pass each file or prop separately:
 * one unguarded read in any of them makes the output required.
 */
export function outputsRead(...templates: ReadonlyArray<string>): ReadonlyArray<OutputRead> {
  const reads = new Map<string, OutputRead>()
  for (const template of templates) {
    for (const ref of templateReferences(template)) {
      if (ref._tag !== "Output") continue
      const id = guardKey(ref.block, ref.key)
      const seen = reads.get(id)
      reads.set(
        id,
        seen
          ? { ...seen, optional: seen.optional && ref.guarded }
          : {
              block: ref.block,
              blockAsWritten: ref.blockAsWritten,
              key: ref.key,
              optional: ref.guarded,
            },
      )
    }
  }
  return [...reads.values()]
}

const toBlockId = Schema.decodeSync(BlockId)

const REFERENCE_PATTERN =
  /\.inputs\.([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*)|\.outputs\.([a-zA-Z0-9_-]+)\.(\w+)/g
const ACTION_PATTERN = /\{\{-?([\s\S]*?)-?\}\}/g
const KEYWORD_PATTERN = /^(if|else|end|with|range|block|define)\b\s*([\s\S]*)$/
const ELSE_IF_PATTERN = /^if\b\s*([\s\S]*)$/
const GUARDED_MAP_PATTERN = /^\$?\.outputs\.([a-zA-Z0-9_-]+)$/
const GUARDED_KEY_PATTERN = /^(?:"([a-zA-Z0-9_-]+)"|`([a-zA-Z0-9_-]+)`)$/

const guardKey = (block: BlockId, key: string) => `${block}.${key}`

/** The 1-based line and column of each index into `text`. */
function positionsIn(text: string): (index: number) => Position {
  const lineStarts = [0]
  for (const match of text.matchAll(/\n/g)) lineStarts.push(match.index + 1)
  return (index) => {
    let line = lineStarts.length - 1
    while (lineStarts[line]! > index) line--
    return { line: line + 1, column: index - lineStarts[line]! + 1 }
  }
}

/** Part of the template, and the index it starts at. */
interface Slice {
  readonly text: string
  readonly at: number
}

const sliceOf = (s: Slice, start: number, end = s.text.length): Slice => ({
  text: s.text.slice(start, end),
  at: s.at + start,
})

function trimmed(s: Slice): Slice {
  const start = s.text.length - s.text.trimStart().length
  return sliceOf(s, start, start + s.text.trim().length)
}

/** The tail of `s` whose text is `tail`. */
const suffix = (s: Slice, tail: string): Slice => sliceOf(s, s.text.length - tail.length)

/** Template code, and the guard keys a guard guarantees exist where it runs. */
interface GuardedCode {
  readonly code: Slice
  readonly guarded: ReadonlySet<string>
}

const NONE: ReadonlySet<string> = new Set()

interface Branch {
  /** Guards in force in the branch being scanned. */
  current: ReadonlySet<string>
  /** Guards in force in a following `else` branch. */
  otherwise: ReadonlySet<string>
}

interface Condition {
  /** The condition's own code, each part with the guards in force where it runs. */
  readonly parts: ReadonlyArray<GuardedCode>
  /** What the condition guarantees when it holds. */
  readonly holds: ReadonlySet<string>
  /** What the condition guarantees when it fails. */
  readonly fails: ReadonlySet<string>
}

/** The code inside the template's actions, split by the guards in force. Comments are dropped. */
function scanGuarded(template: string): GuardedCode[] {
  const parts: GuardedCode[] = []
  const branches: Branch[] = []
  const inForce = () => branches.at(-1)?.current ?? NONE

  for (const match of template.matchAll(ACTION_PATTERN)) {
    const opener = match[0].startsWith("{{-") ? 3 : 2
    const code = trimmed({ text: match[1] ?? "", at: match.index + opener })
    if (code.text.startsWith("/*")) continue

    const [, keyword = "", restText = ""] = KEYWORD_PATTERN.exec(code.text) ?? []
    const rest = suffix(code, restText)
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
        const elseIf = ELSE_IF_PATTERN.exec(rest.text)
        if (elseIf) {
          // `else if` runs only once every earlier condition has failed.
          const condition = parseCondition(suffix(rest, elseIf[1] ?? ""), branch.otherwise)
          parts.push(...condition.parts)
          branch.current = union(branch.otherwise, condition.holds)
          branch.otherwise = union(branch.otherwise, condition.fails)
        } else {
          // A plain `else`, or `else with <pipeline>`
          if (rest.text) parts.push({ code: rest, guarded: branch.otherwise })
          branch.current = branch.otherwise
        }
        break
      }
      case "end":
        branches.pop()
        break
      case "define":
        // The body runs wherever the template is called, so no guard around it applies.
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
function parseCondition(pipeline: Slice, outer: ReadonlySet<string>): Condition {
  const guard = guardOf(pipeline)
  if (guard) return { parts: [], holds: new Set([guard]), fails: NONE }

  const args = splitArgs(unwrap(pipeline))
  if (args?.[0]?.text === "not" && args.length === 2) {
    const negated = guardOf(args[1]!)
    if (negated) return { parts: [], holds: NONE, fails: new Set([negated]) }
  }
  if (args?.[0]?.text === "and") {
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

/** The guard key `hasKey <outputs map> "<key>"` checks, if `expr` is one. */
function guardOf(expr: Slice): string | undefined {
  const args = splitArgs(unwrap(expr))
  if (args?.length !== 3 || args[0]!.text !== "hasKey") return undefined
  const [, written] = GUARDED_MAP_PATTERN.exec(unwrap(args[1]!).text) ?? []
  const [, quoted, backquoted] = GUARDED_KEY_PATTERN.exec(args[2]!.text) ?? []
  const key = quoted ?? backquoted
  if (!written || !key) return undefined
  return guardKey(toBlockId(written), key)
}

/**
 * Split a pipeline into its top-level arguments: `hasKey (.outputs.x) "y"`
 * gives `hasKey`, `(.outputs.x)`, `"y"`. Undefined for a pipeline with a
 * top-level `|`, or one whose parentheses or quotes don't balance.
 */
function splitArgs(pipeline: Slice): Slice[] | undefined {
  const { text } = pipeline
  const args: Slice[] = []
  let depth = 0
  let start = -1
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (depth === 0 && /\s/.test(char)) {
      if (start >= 0) args.push(sliceOf(pipeline, start, i))
      start = -1
      continue
    }
    if (depth === 0 && char === "|") return undefined
    if (start < 0) start = i
    if (char === '"' || char === "`" || char === "'") {
      i = closingQuote(text, i)
      if (i < 0) return undefined
    } else if (char === "(") {
      depth++
    } else if (char === ")" && --depth < 0) {
      return undefined
    }
  }
  if (depth !== 0) return undefined
  if (start >= 0) args.push(sliceOf(pipeline, start))
  return args
}

/** Strip parentheses that wrap the whole expression: `((x y))` gives `x y`. */
function unwrap(expr: Slice): Slice {
  let inner = trimmed(expr)
  while (inner.text.startsWith("(") && closingParen(inner.text) === inner.text.length - 1) {
    inner = trimmed(sliceOf(inner, 1, inner.text.length - 1))
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
