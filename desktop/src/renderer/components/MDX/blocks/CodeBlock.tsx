import React, { useState } from 'react'

interface CodeBlockProps {
  children?: React.ReactNode
  className?: string
  [key: string]: unknown
}

/**
 * CodeBlock renders <pre> elements with syntax highlighting and copy button.
 * This replaces the default <pre> in MDX rendering.
 */
export function CodeBlock({ children, ...props }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)

  // Extract text content and language from child <code> element
  let text = ''
  let language = ''

  if (React.isValidElement(children)) {
    const childProps = children.props as Record<string, unknown>
    if (typeof childProps.children === 'string') {
      text = childProps.children
    }
    if (typeof childProps.className === 'string') {
      const match = childProps.className.match(/language-(\w+)/)
      if (match) language = match[1]
    }
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="relative group mb-4">
      {language && (
        <div className="absolute top-0 left-0 px-2 py-0.5 text-[10px] font-mono text-neutral-400 bg-neutral-800 rounded-tl-md rounded-br-md">
          {language}
        </div>
      )}
      <button
        onClick={handleCopy}
        className="absolute top-1 right-1 px-2 py-0.5 text-[10px] font-mono text-neutral-400 bg-neutral-700 hover:bg-neutral-600 rounded opacity-0 group-hover:opacity-100 transition-opacity"
      >
        {copied ? 'Copied!' : 'Copy'}
      </button>
      <pre
        className="bg-neutral-900 rounded-md p-4 text-sm font-mono text-neutral-100 overflow-x-auto"
        {...props}
      >
        {children}
      </pre>
    </div>
  )
}
