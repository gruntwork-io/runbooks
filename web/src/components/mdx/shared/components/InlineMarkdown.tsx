import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

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
      }}
    >
      {children}
    </ReactMarkdown>
  )
}

