import { describe, expect, it } from "bun:test"
import type { TreeNode } from "./document.ts"
import { allowedParts, markdownTree } from "./markdown.ts"
import { MAX_NESTING } from "./mdx.ts"

const text = (value: string): TreeNode => ({ type: "text", value })
const paragraph = (...children: ReadonlyArray<TreeNode>): TreeNode => ({
  type: "paragraph",
  children,
})

/** Each part of `tree`, its root first. */
const partsOf = (tree: TreeNode): ReadonlyArray<TreeNode> => [
  tree,
  ...(tree.children ?? []).flatMap(partsOf),
]

/** How many levels below its root `tree`'s deepest part is. */
const depthOf = (tree: TreeNode): number =>
  Math.max(0, ...(tree.children ?? []).map((child) => 1 + depthOf(child)))

/** Every part markdown and GFM have, each at least once. */
const EVERY_PART = [
  "# Heading",
  "*em* **strong** ~~gone~~ `code` <b>tag</b>  ",
  "after a break",
  "> quoted",
  "- [ ] task",
  "3. third",
  "---",
  "```sh",
  "echo",
  "```",
  "| a | b |",
  "|:-|-:|",
  "| 1 | 2 |",
  "",
  '[link](https://example.com "Title") ![image](assets/a.png) [ref] ![ref] note[^1]',
  "",
  "[ref]: https://example.com/ref",
  "",
  "[^1]: A footnote.",
].join("\n")

describe("markdownTree", () => {
  it("reads plain markdown, not MDX: a tag is html, which the walk shows as text, and braces are text", () => {
    expect(markdownTree("Where to **deploy**, as <b>{region}</b>")).toEqual({
      type: "root",
      children: [
        paragraph(
          text("Where to "),
          { type: "strong", children: [text("deploy")] },
          text(", as "),
          { type: "html", value: "<b>" },
          text("{region}"),
          { type: "html", value: "</b>" },
        ),
      ],
    })
    expect(markdownTree("")).toEqual({ type: "root", children: [] })
  })

  it("keeps of each part only what the walk reads of it, and no part's place in the text", () => {
    const tree = markdownTree(
      '[docs](https://example.com "Docs") ![logo](assets/logo.png "Logo") [ref]\n\n[ref]: https://example.com/ref\n\n```sh title=x\necho\n```',
    )
    expect(tree).toEqual({
      type: "root",
      children: [
        paragraph(
          { type: "link", url: "https://example.com", title: "Docs", children: [text("docs")] },
          text(" "),
          { type: "image", url: "assets/logo.png", alt: "logo" },
          text(" "),
          { type: "linkReference", identifier: "ref", children: [text("ref")] },
        ),
        { type: "definition", identifier: "ref", url: "https://example.com/ref", title: null },
        { type: "code", value: "echo", lang: "sh" },
      ],
    })
  })

  it("builds every part markdown and GFM have as the walk's allowlist takes it", () => {
    const tree = markdownTree(EVERY_PART)
    const types = new Set((tree === undefined ? [] : partsOf(tree)).map((part) => part.type))
    expect([...types].sort()).toEqual([
      "blockquote",
      "break",
      "code",
      "definition",
      "delete",
      "emphasis",
      "footnoteDefinition",
      "footnoteReference",
      "heading",
      "html",
      "image",
      "imageReference",
      "inlineCode",
      "link",
      "linkReference",
      "list",
      "listItem",
      "paragraph",
      "root",
      "strong",
      "table",
      "tableCell",
      "tableRow",
      "text",
      "thematicBreak",
    ])
    expect(JSON.stringify(tree)).not.toContain("position")
  })

  it("nests as deep as the document may, and is undefined deeper, however deep", () => {
    // Each `>` is a quote; the innermost holds a paragraph, which holds the text.
    const quoted = (quotes: number) => `${"> ".repeat(quotes)}x`
    const deepest = markdownTree(quoted(MAX_NESTING - 2))
    expect(deepest === undefined ? undefined : depthOf(deepest)).toBe(MAX_NESTING)
    expect(markdownTree(quoted(MAX_NESTING - 1))).toBeUndefined()
    expect(markdownTree(quoted(10_000))).toBeUndefined()
  })
})

describe("allowedParts", () => {
  it("puts a part the allowlist does not take where it was, as the walk draws it: its children, or its text", () => {
    const sevenDeep: TreeNode = { type: "heading", depth: 7, children: [text("h")] }
    const math: TreeNode = { type: "math", children: [text("x")] }
    const yaml: TreeNode = { type: "yaml", value: "a: 1" }
    const empty: TreeNode = { type: "custom" }
    expect(allowedParts({ type: "emphasis", children: [math, yaml, empty, sevenDeep] })).toEqual([
      { type: "emphasis", children: [text("x"), text("a: 1"), text("h")] },
    ])
  })
})
