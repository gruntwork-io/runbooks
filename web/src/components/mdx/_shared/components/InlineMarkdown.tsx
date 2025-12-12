import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { SmartLink } from "./SmartLink"

interface InlineMarkdownProps {
  children: string
}

/**
 * A simplified wrapper around ReactMarkdown that handles inline markdown formatting.
 * Unwraps paragraph tags to allow inline rendering within other components.
 */
export const InlineMarkdown = ({ children }: InlineMarkdownProps) => {
  return (
    <ReactMarkdown 
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({children}) => <>{children}</>, // Unwrap paragraphs for inline rendering
        a: SmartLink, // Handle links intelligently (external open in new tab, anchors smooth scroll)
      }}
    >
      {children}
    </ReactMarkdown>
  )
}

