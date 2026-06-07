import { useState, useRef, type ReactNode, type ReactElement } from 'react'
import { Copy, Check } from "lucide-react"
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard"

interface CodeBlockProps {
  children?: ReactNode
}

/**
 * Custom code block component that wraps <pre> elements with a copy-on-hover button.
 * This component is registered as the MDX override for `pre` elements.
 */
export function CodeBlock({ children, ...props }: CodeBlockProps) {
  const { didCopy: copied, copy: doCopy } = useCopyToClipboard(2000)
  const [isHovered, setIsHovered] = useState(false)
  const preRef = useRef<HTMLPreElement>(null)

  // Extract text content from the code block
  const getCodeText = (): string => {
    if (preRef.current) {
      // Get the text content from the <code> element inside <pre>
      const codeElement = preRef.current.querySelector('code')
      if (codeElement) {
        return codeElement.textContent || ''
      }
      return preRef.current.textContent || ''
    }
    return ''
  }

  const handleCopy = async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const text = getCodeText()
    if (text) await doCopy(text)
  }

  // Check if this is actually a code block (has a <code> child)
  // Some <pre> elements might not contain code
  const hasCodeChild = (() => {
    if (!children) return false
    if (typeof children === 'object' && 'type' in (children as ReactElement)) {
      const element = children as ReactElement
      return element.type === 'code'
    }
    return false
  })()

  // If it doesn't have a code child, just render a plain pre
  if (!hasCodeChild) {
    return <pre {...props}>{children}</pre>
  }

  return (
    <div 
      className="relative group"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <pre ref={preRef} {...props}>
        {children}
      </pre>
      
      {/* Copy button - appears on hover */}
      <button
        onClick={handleCopy}
        className={`
          absolute top-2 right-2
          p-1.5 rounded-md
          bg-muted hover:bg-accent
          border border-border
          text-muted-foreground hover:text-foreground
          transition-opacity duration-150 cursor-pointer
          ${isHovered ? 'opacity-100' : 'opacity-0'}
          focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-ring
        `}
        title={copied ? "Copied!" : "Copy code"}
        aria-label={copied ? "Copied!" : "Copy code"}
      >
        {copied ? (
          <Check className="h-4 w-4 text-success" />
        ) : (
          <Copy className="h-4 w-4" />
        )}
      </button>
    </div>
  )
}

// displayName survives minification and is used by extractTemplateFiles
// to identify code blocks in production builds
CodeBlock.displayName = 'CodeBlock'
