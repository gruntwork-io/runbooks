import { useCallback, useContext } from "react"
import ReactMarkdown, { defaultUrlTransform } from "react-markdown"
import type { Components, UrlTransform } from "react-markdown"
import remarkGfm from "remark-gfm"
import type { Processor } from "unified"
import { SmartLink } from "./SmartLink"
import { RunbookContext } from "@/contexts/RunbookContext"
import { rewriteAssetUrl } from "@/lib/assetPaths"
import { cn } from "@/lib/utils"

interface InlineMarkdownProps {
  children: string
}

const inlineComponents: Components = {
  p: ({ children }) => <>{children}</>, // Unwrap paragraphs for inline rendering
  a: SmartLink, // Handle links intelligently (external open in new tab, anchors smooth scroll)
}

/**
 * ./assets/ URLs get the same runbook-asset:// rewrite as the runbook body
 * (MDXContainer). Every other URL keeps react-markdown's default sanitizing,
 * which would also blank the runbook-asset: scheme, so it only sees the rest.
 */
function useUrlTransform(): UrlTransform {
  const assetHost = useContext(RunbookContext)?.assetHost
  return useCallback<UrlTransform>(
    (url, key, node) => {
      const assetUrl = rewriteAssetUrl(node.tagName, key, url, assetHost)
      return assetUrl !== url ? assetUrl : defaultUrlTransform(url)
    },
    [assetHost],
  )
}

/**
 * A simplified wrapper around ReactMarkdown that handles inline markdown formatting.
 * Unwraps paragraph tags to allow inline rendering within other components.
 */
export const InlineMarkdown = ({ children }: InlineMarkdownProps) => {
  const urlTransform = useUrlTransform()

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      urlTransform={urlTransform}
      components={inlineComponents}
    >
      {children}
    </ReactMarkdown>
  )
}

interface MdastNode {
  type: string
  value?: string
  children?: MdastNode[]
}

/** Each line break in a paragraph becomes a <br>, so a YAML block scalar's lines stay lines. */
function keepLineBreaks(node: MdastNode) {
  if (!node.children) return
  node.children = node.children.flatMap((child) => {
    if (child.type !== "text" || !child.value?.includes("\n")) {
      keepLineBreaks(child)
      return [child]
    }
    return child.value
      .split("\n")
      .flatMap((line, index) =>
        index === 0
          ? [{ type: "text", value: line }]
          : [{ type: "break" }, { type: "text", value: line }],
      )
  })
}

/**
 * Markdown for a field description: inline formatting, links, line breaks
 * and lists. Raw HTML, headings, block quotes, rules and code blocks aren't
 * parsed, so `modules/<name>` or `# of replicas` reads as written, and an
 * indented line in a YAML block scalar isn't a code block.
 */
function remarkDescription(this: Processor) {
  const data = this.data()
  ;(data.micromarkExtensions ??= []).push({
    disable: {
      null: [
        "htmlFlow",
        "htmlText",
        "headingAtx",
        "setextUnderline",
        "thematicBreak",
        "blockQuote",
        "codeIndented",
        "codeFenced",
      ],
    },
  })
  return (tree: MdastNode) => keepLineBreaks(tree)
}

// Anything else (an image, a GFM table) is dropped and its text kept
const descriptionElements = ["p", "br", "strong", "em", "del", "code", "a", "ul", "ol", "li"]

const descriptionComponents: Components = { a: SmartLink }

interface DescriptionMarkdownProps {
  children: string
  className?: string
}

/**
 * A form field's description, in the muted small text it has always had. A
 * one-line description renders as a single paragraph, so it looks as it did
 * as plain text. App.css strips list markers and margins inside a runbook
 * block, so lists get theirs back here.
 */
export const DescriptionMarkdown = ({ children, className }: DescriptionMarkdownProps) => {
  const urlTransform = useUrlTransform()

  return (
    <div
      className={cn(
        "space-y-1 text-sm text-muted-foreground [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkDescription]}
        urlTransform={urlTransform}
        allowedElements={descriptionElements}
        unwrapDisallowed
        components={descriptionComponents}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
