import { jsxAttributeValue } from "../../../../../src/mdx"
import type { ChapterInfo } from "@/contexts/RunbookChaptersContext.types"

/**
 * The prop rehypeChapters gives each chapter: its index, as a string. Any
 * value the runbook writes for it is dropped first, so only a chapter at the
 * top level of the runbook has one.
 */
export const CHAPTER_INDEX_PROP = "chapterIndex"

// The shape of the MDX hast nodes read here (see mdast-util-mdx-jsx).
interface JsxAttribute {
  type: string
  name?: string
  value?: Parameters<typeof jsxAttributeValue>[0]
}

interface HastNode {
  type?: string
  name?: string | null
  attributes?: JsxAttribute[]
  children?: HastNode[]
}

/**
 * Rehype plugin that finds the runbook's chapters: the <Chapter> blocks at its
 * top level, which it numbers with CHAPTER_INDEX_PROP and lists in
 * `chapters`, in document order. A <Chapter> anywhere else, such as inside
 * another block or chapter, gets no index, and shows a configuration error.
 */
export function rehypeChapters({ chapters }: { chapters: ChapterInfo[] }) {
  return (tree: HastNode) => {
    const strip = (node: HastNode) => {
      if (isChapter(node)) {
        node.attributes = (node.attributes ?? []).filter(
          (attribute) => attribute.name !== CHAPTER_INDEX_PROP,
        )
      }
      node.children?.forEach(strip)
    }
    strip(tree)

    for (const node of tree.children ?? []) {
      if (!isChapter(node)) continue
      // Like the props the renderer passes, a later duplicate wins.
      const title = (node.attributes ?? []).filter((attribute) => attribute.name === "title").at(-1)
      const value = title?.type === "mdxJsxAttribute" ? jsxAttributeValue(title.value) : undefined
      node.attributes?.push({
        type: "mdxJsxAttribute",
        name: CHAPTER_INDEX_PROP,
        value: String(chapters.length),
      })
      chapters.push({ title: typeof value === "string" ? value.trim() : "" })
    }
  }
}

function isChapter(node: HastNode): boolean {
  return node.type === "mdxJsxFlowElement" && node.name === "Chapter"
}
