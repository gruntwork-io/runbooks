import ReactMarkdown, { defaultUrlTransform } from "react-markdown"
import type { UrlTransform } from "react-markdown"
import remarkGfm from "remark-gfm"
import { SmartLink } from "./SmartLink"
import { rewriteAssetUrl } from "@/lib/assetPaths"

interface InlineMarkdownProps {
  children: string
}

// ./assets/ URLs get the same runbook-asset:// rewrite as the runbook body
// (MDXContainer). Every other URL keeps react-markdown's default sanitizing,
// which would also blank the runbook-asset: scheme, so it only sees the rest.
const urlTransform: UrlTransform = (url, key, node) => {
  const assetUrl = rewriteAssetUrl(node.tagName, key, url)
  return assetUrl !== url ? assetUrl : defaultUrlTransform(url)
}

/**
 * A simplified wrapper around ReactMarkdown that handles inline markdown formatting.
 * Unwraps paragraph tags to allow inline rendering within other components.
 */
export const InlineMarkdown = ({ children }: InlineMarkdownProps) => {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      urlTransform={urlTransform}
      components={{
        p: ({children}) => <>{children}</>, // Unwrap paragraphs for inline rendering
        a: SmartLink, // Handle links intelligently (external open in new tab, anchors smooth scroll)
      }}
    >
      {children}
    </ReactMarkdown>
  )
}
