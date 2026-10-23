/**
 * Reads a runbook's blocks the way the renderer does.
 *
 * The renderer compiles a runbook with @mdx-js/mdx, which parses it with
 * remark-parse and remark-mdx plus RUNBOOK_REMARK_PLUGINS (compileMDX in
 * MDXContainer). The main process and the test CLI parse it here with the same
 * plugins, so they refuse the runbooks the renderer refuses, and find the
 * blocks it shows, with the props it passes them:
 * - a block in a code fence, in inline code or in a `{/* comment *\/}` is text;
 * - `prop="..."` decodes every HTML character reference and has no backslash
 *   escapes;
 * - `prop={...}` is the value of its JavaScript literal, with JavaScript's
 *   escapes;
 * - a bare `prop` is true.
 *
 * The renderer imports this module too, so it must not import Node.js modules.
 */
import type { Node as EstreeNode, Program } from "estree"
import remarkGfm from "remark-gfm"
import remarkMdx from "remark-mdx"
import remarkParse from "remark-parse"
import { unified } from "unified"
import { errorMessage } from "./errors/message.ts"
import { remarkLiteralOnly } from "./remarkLiteralOnly.ts"

/**
 * The remark plugins compileMDX adds to MDX's own parser, so this parser adds
 * them too: GitHub Flavored Markdown, and remarkLiteralOnly, which refuses a
 * runbook that would run code when it opens.
 */
export const RUNBOOK_REMARK_PLUGINS = [remarkGfm, remarkLiteralOnly] as const

/** A prop's value as the renderer passes it to a block. */
export type PropValue =
  | string
  | number
  | boolean
  | null
  | readonly PropValue[]
  | { readonly [key: string]: PropValue }

/** A block's props by name. */
export type Props = Readonly<Record<string, PropValue>>

/** A JSX element in a runbook, such as a `<Command>` block. */
export interface MdxElement {
  /** The element's name, such as "Command". */
  readonly name: string
  /**
   * The props the renderer passes it, except a prop that holds a regex or
   * bigint literal, which no block takes.
   */
  readonly props: Props
  /** The props as written in the runbook. */
  readonly propsSource: string
  /** The source between the opening and closing tags, as written; "" for a self-closing tag. */
  readonly content: string
  /** The offset of the opening tag in the runbook, after its front matter is blanked out. */
  readonly index: number
}

/** A runbook's JSX elements in document order, or why the renderer refuses it. */
export type ParsedMdx = { ok: true; elements: readonly MdxElement[] } | { ok: false; error: string }

/**
 * Parse a runbook's MDX into its JSX elements, nested ones included. For a
 * runbook the renderer refuses to show, because it isn't valid MDX or
 * remarkLiteralOnly rejects it, it gives the error the renderer shows instead.
 */
export function parseMdx(content: string): ParsedMdx {
  const source = stripFrontMatter(content)
  let tree: MdxNode
  try {
    const processor = unified()
      .use(remarkParse)
      .use(remarkMdx)
      .use([...RUNBOOK_REMARK_PLUGINS])
    tree = processor.runSync(processor.parse(source)) as MdxNode
  } catch (err) {
    return { ok: false, error: mdxErrorMessage(err) }
  }

  const elements: MdxElement[] = []
  const visit = (node: MdxNode) => {
    // A fragment (<>...</>) has no name, only children.
    if ((node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") && node.name) {
      elements.push(toElement(node, node.name, source))
    }
    node.children?.forEach(visit)
  }
  visit(tree)
  return { ok: true, elements }
}

/**
 * The text to show for an error parsing or compiling a runbook: its reason,
 * with the line it's on in the runbook. The renderer's error box shows it and
 * parseMdx gives it, so the app, the main process and the test CLI say the
 * same thing about a runbook they refuse.
 */
export function mdxErrorMessage(err: unknown): string {
  // A parse error, a VFileMessage, has its line and reason apart, and
  // remarkLiteralOnly's message starts with its line. Bun gives every Error a
  // `line` too, but that's a line of the JavaScript that made it.
  if (
    err instanceof Error &&
    "reason" in err &&
    typeof err.reason === "string" &&
    "line" in err &&
    typeof err.line === "number"
  ) {
    // For JavaScript it can't parse, MDX says only "Could not parse expression
    // with acorn", its JavaScript parser, and keeps acorn's own reason, such as
    // "Unterminated string constant", as the cause.
    const reason =
      "ruleId" in err && err.ruleId === "acorn" && err.cause instanceof Error
        ? err.cause.message
        : err.reason
    return `Line ${err.line}: ${reason}`
  }
  return errorMessage(err)
}

/**
 * Front matter: a `---` line at the very start of the file, the YAML, and the
 * next `---` line.
 */
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/**
 * Strips YAML front matter from MDX content.
 * Front matter is YAML metadata between --- delimiters at the start of the file.
 * Example:
 *   ---
 *   title: My Runbook
 *   ---
 *   # Content here
 * The block is replaced with one blank line per line it spanned, so line
 * numbers in compile errors (e.g. remarkLiteralOnly's "Line N: ...") still
 * match the runbook file.
 */
export function stripFrontMatter(content: string): string {
  const match = FRONT_MATTER.exec(content)
  if (!match) {
    return content
  }

  // Replace the front matter block with the same number of line breaks
  const lineBreaks = match[0].split("\n").length - 1
  return "\n".repeat(lineBreaks) + content.slice(match[0].length)
}

/** The YAML of a runbook's front matter, or null when it has none. */
export function frontMatter(content: string): string | null {
  return FRONT_MATTER.exec(content)?.[1] ?? null
}

/** A string prop's value, or "" when the prop is absent or not a string. */
export function stringProp(props: Props, name: string): string {
  const value = props[name]
  return typeof value === "string" ? value : ""
}

/**
 * A prop whose value is an array of strings, such as
 * `outputs={["region", 'zone']}`. Returns undefined when the prop is absent
 * or holds anything else.
 */
export function stringArrayProp(props: Props, name: string): string[] | undefined {
  const value = props[name]
  if (!Array.isArray(value)) return undefined
  return value.every((item) => typeof item === "string") ? [...value] : undefined
}

// ---------------------------------------------------------------------------
// MDX syntax tree
// ---------------------------------------------------------------------------

// Minimal shape of the MDX mdast nodes read here (see mdast-util-mdx-jsx and
// mdast-util-mdx-expression).
interface MdxNode {
  type: string
  // JSX element or attribute name (null for fragments)
  name?: string | null
  // An attribute's value: a string, null for a bare prop, or an expression
  value?: string | null | MdxNode
  attributes?: MdxNode[]
  data?: { estree?: Program | null }
  children?: MdxNode[]
  position?: { start: { offset?: number }; end: { offset?: number } }
}

function toElement(node: MdxNode, name: string, source: string): MdxElement {
  const start = node.position?.start.offset ?? 0
  const end = node.position?.end.offset ?? start
  const attributes = node.attributes ?? []
  const propsStart = attributes[0]?.position?.start.offset
  const propsEnd = attributes.at(-1)?.position?.end.offset

  const props: Array<[string, PropValue]> = []
  for (const attribute of attributes) {
    // A spread ({...props}) is an mdxJsxExpressionAttribute, which the renderer refuses.
    if (attribute.type !== "mdxJsxAttribute" || !attribute.name) continue
    const value = jsxAttributeValue(attribute.value)
    if (value !== undefined) props.push([attribute.name, value])
  }

  // MDX allows only whitespace and the self-closing `/` between the last prop
  // and the `>` that ends the opening tag, and nothing that holds a `<` in
  // the closing tag.
  const openingEnd = source.indexOf(">", propsEnd ?? start) + 1
  const content = openingEnd < end ? source.slice(openingEnd, source.lastIndexOf("<", end - 1)) : ""

  return {
    name,
    // Like the renderer's props object, a later duplicate prop wins.
    props: Object.fromEntries(props),
    propsSource: propsStart === undefined ? "" : source.slice(propsStart, propsEnd),
    content,
    index: start,
  }
}

/**
 * The value the renderer passes a block for one of its JSX attributes, given
 * the attribute's `value` in the MDX syntax tree; undefined for a value that
 * isn't a literal.
 */
export function jsxAttributeValue(value: MdxNode["value"]): PropValue | undefined {
  // A bare prop, such as `usePty`
  if (value === null || value === undefined) return true
  // A quoted value, whose character references the parser has decoded
  if (typeof value === "string") return value
  const [statement, ...rest] = value.data?.estree?.body ?? []
  return statement?.type === "ExpressionStatement" && rest.length === 0
    ? literalValue(statement.expression)
    : undefined
}

// The value of a literal as remarkLiteralOnly allows it: a string, number,
// boolean or null; a template string without ${...}; a number with a leading
// `-` or `+`; or an array or object of those. A regex or bigint literal is
// allowed there but is no value a block takes, so it counts as no literal here.
function literalValue(node: EstreeNode | null): PropValue | undefined {
  switch (node?.type) {
    case "Literal":
      return "regex" in node || "bigint" in node ? undefined : node.value
    case "TemplateLiteral":
      return node.expressions.length === 0 ? (node.quasis[0]?.value.cooked ?? undefined) : undefined
    case "UnaryExpression": {
      const { operator, argument } = node
      if ((operator !== "-" && operator !== "+") || argument.type !== "Literal") return undefined
      if (typeof argument.value !== "number") return undefined
      return operator === "-" ? -argument.value : argument.value
    }
    case "ArrayExpression": {
      const items = node.elements.map(literalValue)
      return items.every((item) => item !== undefined) ? items : undefined
    }
    case "ObjectExpression": {
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
        // `__proto__: x` sets the object's prototype, which remarkLiteralOnly refuses.
        if (name === undefined || name === "__proto__") return undefined
        const value = literalValue(property.value)
        if (value === undefined) return undefined
        entries.push([name, value])
      }
      return Object.fromEntries(entries)
    }
    default:
      return undefined
  }
}
