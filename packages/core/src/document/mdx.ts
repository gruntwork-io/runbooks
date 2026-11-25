/**
 * Runbook MDX as a syntax tree, and the literal values its props hold. The
 * tree is parsed with remark-parse, remark-mdx and remark-gfm, as today's
 * renderer compiles it, so authors write the same syntax. Nothing in it is
 * evaluated: a `{...}` is read as a literal value or refused.
 */
import type { Node as EstreeNode, Program } from "estree"
import remarkGfm from "remark-gfm"
import remarkMdx from "remark-mdx"
import remarkParse from "remark-parse"
import { unified } from "unified"
import type { Position } from "./configError.ts"

/** The fields of the MDX mdast nodes the parser reads (mdast, mdast-util-mdx-jsx, mdast-util-mdx-expression). */
export interface MdxNode {
  readonly type: string
  /** A JSX element's or attribute's name; null for a fragment. */
  readonly name?: string | null
  /** Text, source, or an attribute's value: a string, null for a bare prop, or an expression. */
  readonly value?: string | null | MdxNode
  readonly attributes?: ReadonlyArray<MdxNode>
  readonly data?: { readonly estree?: Program | null }
  readonly children?: ReadonlyArray<MdxNode>
  readonly position?: { readonly start: Point; readonly end: Point }
  /** A code fence's language. */
  readonly lang?: string | null
}

interface Point {
  readonly line: number
  readonly column: number
  readonly offset?: number
}

/** A prop's value as written: what a block's schema decodes. */
export type PropValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<PropValue>
  | { readonly [key: string]: PropValue }

/** Where MDX that does not parse goes wrong, and why. */
export interface SyntaxProblem {
  readonly reason: string
  readonly at: Position
}

/** The tree of `source`, or why it does not parse. */
export function parseMdx(
  source: string,
): { readonly tree: MdxNode } | { readonly problem: SyntaxProblem } {
  try {
    return { tree: processor.parse(source) as MdxNode }
  } catch (error) {
    return { problem: syntaxProblem(error) }
  }
}

const processor = unified().use(remarkParse).use(remarkMdx).use(remarkGfm)

function syntaxProblem(error: unknown): SyntaxProblem {
  // A VFileMessage has its reason and place apart. Under Bun every Error has
  // a `line`, the JavaScript's, so `reason` is what marks one.
  if (error instanceof Error && "reason" in error && typeof error.reason === "string") {
    // A tag left open has no place, only its span at the end of the reason: "(3:1-3:30)".
    const [, inReason = "1", columnInReason = "1"] =
      /\((\d+):(\d+)(?:-\d+:\d+)?\)$/.exec(error.reason) ?? []
    const line = "line" in error && typeof error.line === "number" ? error.line : Number(inReason)
    const column =
      "column" in error && typeof error.column === "number" ? error.column : Number(columnInReason)
    // For JavaScript it cannot parse, MDX says only "Could not parse
    // expression with acorn" and keeps acorn's reason as the cause.
    const reason =
      "ruleId" in error && error.ruleId === "acorn" && error.cause instanceof Error
        ? error.cause.message
        : error.reason
    return { reason, at: { line: Math.max(line, 1), column: Math.max(column, 1) } }
  }
  return { reason: String(error), at: { line: 1, column: 1 } }
}

/**
 * A JSX attribute's value: true for a bare prop, the decoded text of a quoted
 * one, the value of a `{...}` literal. Undefined for a `{...}` that holds no
 * value a block takes: code, which the literal check refuses, or a regex.
 */
export function attributeValue(value: MdxNode["value"]): PropValue | undefined {
  if (value === null || value === undefined) return true
  if (typeof value === "string") return value
  const [statement, ...rest] = value.data?.estree?.body ?? []
  return statement?.type === "ExpressionStatement" && rest.length === 0
    ? literalValue(statement.expression)
    : undefined
}

/**
 * The value of a `{...}` text or flow expression: undefined for `{}` or a
 * comment, which render nothing, and for anything not a literal.
 */
export function expressionValue(node: MdxNode): PropValue | undefined {
  const [statement, ...rest] = node.data?.estree?.body ?? []
  return statement?.type === "ExpressionStatement" && rest.length === 0
    ? literalValue(statement.expression)
    : undefined
}

/**
 * A literal as the literal check allows it: a string, number, boolean or
 * null; a template string without `${...}`; a number with a leading `-` or
 * `+`; an array or object of those. A regex or bigint is allowed there but is
 * no value a block takes.
 */
function literalValue(node: EstreeNode | null): PropValue | undefined {
  if (node?.type === "Literal") {
    return "regex" in node || "bigint" in node ? undefined : node.value
  }
  if (node?.type === "TemplateLiteral") {
    return node.expressions.length === 0 ? (node.quasis[0]?.value.cooked ?? undefined) : undefined
  }
  if (node?.type === "UnaryExpression") {
    const { operator, argument } = node
    if ((operator !== "-" && operator !== "+") || argument.type !== "Literal") return undefined
    if (typeof argument.value !== "number") return undefined
    return operator === "-" ? -argument.value : argument.value
  }
  if (node?.type === "ArrayExpression") {
    const items = node.elements.map(literalValue)
    return items.every((item) => item !== undefined) ? items : undefined
  }
  if (node?.type === "ObjectExpression") {
    const entries: Array<[string, PropValue]> = []
    for (const property of node.properties) {
      if (property.type !== "Property" || property.kind !== "init") return undefined
      if (property.computed || property.method) return undefined
      const { key } = property
      const name =
        key.type === "Identifier"
          ? key.name
          : key.type === "Literal" && !("regex" in key) && !("bigint" in key)
            ? String(key.value)
            : undefined
      if (name === undefined || name === "__proto__") return undefined
      const value = literalValue(property.value)
      if (value === undefined) return undefined
      entries.push([name, value])
    }
    return Object.fromEntries(entries)
  }
  return undefined
}

/**
 * Front matter: a `---` line at the very start of the file, the YAML, if
 * any, and the next line that is just `---`.
 */
const FRONT_MATTER = /^---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)/

/**
 * The front matter's YAML, and the source with the front matter blanked to
 * as many line breaks, so every position in the rest is the file's.
 */
export function splitFrontMatter(source: string): {
  readonly yaml: string | undefined
  readonly body: string
} {
  const match = FRONT_MATTER.exec(source)
  if (!match) return { yaml: undefined, body: source }
  const lineBreaks = match[0].split("\n").length - 1
  return { yaml: match[1] ?? "", body: "\n".repeat(lineBreaks) + source.slice(match[0].length) }
}
