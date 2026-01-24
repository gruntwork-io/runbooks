import { useState, useRef, type ReactNode, type ReactElement } from 'react'
import { Copy, Check } from "lucide-react"
import { copyTextToClipboard } from "@/lib/utils"

interface CodeBlockProps {
  children?: ReactNode
}

/**
 * Custom code block component that wraps <pre> elements with a copy-on-hover button.
 * This component is registered as the MDX override for `pre` elements.
 */
export function CodeBlock({ children, ...props }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)
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
    if (text) {
      const ok = await copyTextToClipboard(text)
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }
    }
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
          bg-gray-100 hover:bg-gray-200
          border border-gray-300
          text-gray-600 hover:text-gray-800
          transition-opacity duration-150 cursor-pointer
          ${isHovered ? 'opacity-100' : 'opacity-0'}
          focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-gray-400
        `}
        title={copied ? "Copied!" : "Copy code"}
        aria-label={copied ? "Copied!" : "Copy code"}
      >
        {copied ? (
          <Check className="h-4 w-4 text-green-600" />
        ) : (
          <Copy className="h-4 w-4" />
        )}
      </button>
    </div>
  )
}
