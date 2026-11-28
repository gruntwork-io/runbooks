/**
 * Author markdown that is not a runbook, such as a field's description, as
 * the tree the window walks. The core parses it, so the window's bundle has
 * no parser and only walks trees: one parser and one allowlist for all of an
 * author's markdown. It is parsed as the runbook's markdown is, with
 * remark-parse and remark-gfm, but as plain markdown, not MDX: a tag is
 * `html`, which the walk shows as text, and `{...}` is text.
 */
import { Option, Schema } from "effect"
import remarkGfm from "remark-gfm"
import remarkParse from "remark-parse"
import { unified } from "unified"
import { MarkdownPart, type TreeNode } from "./document.ts"
import { type MdxNode, nestedTooDeep } from "./mdx.ts"

const processor = unified().use(remarkParse).use(remarkGfm)

const decodePart = Schema.decodeUnknownOption(MarkdownPart)

/** A parsed node, as `allowedParts` reads it. */
interface Parsed {
  readonly type: string
  readonly value?: unknown
  readonly children?: ReadonlyArray<Parsed>
}

/**
 * `source` as the window's walk draws it, or undefined when it nests more
 * than `MAX_NESTING` levels deep, as a runbook may not: the same bound, for
 * the engine's encoding and the window's walk.
 */
export function markdownTree(source: string): TreeNode | undefined {
  const tree = processor.parse(source) as MdxNode
  // Before any walk that recurses, as the runbook's parser checks its own.
  if (nestedTooDeep(tree) !== undefined) return undefined
  return { type: "root", children: (tree.children ?? []).flatMap(allowedParts) }
}

/**
 * `node` as the walk's allowlist (`MarkdownPart`) takes it, with only what
 * the walk reads of it and its children. A part the allowlist does not take
 * is put where it was as the walk draws it: its children, or its text.
 * Plain markdown makes no such part today; one a parser upgrade adds is
 * shown as the walk would show it.
 */
export function allowedParts(node: Parsed): ReadonlyArray<TreeNode> {
  const children = node.children?.flatMap(allowedParts)
  const part = decodePart(node)
  if (Option.isNone(part))
    return children ?? (typeof node.value === "string" ? [{ type: "text", value: node.value }] : [])
  return [{ ...part.value, ...(children === undefined ? {} : { children }) }]
}
