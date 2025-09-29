import React, { useState, useEffect } from 'react'
import { evaluate } from '@mdx-js/mdx'
import * as runtime from 'react/jsx-runtime'

// Support MDX components
import { HelloWorld } from '@/components/mdx/HelloWorld'
import { BoilerplateInputs } from '@/components/mdx/BoilerplateInputs'

/**
 * This component renders a markdown/MDX document.
 * 
 * It takes raw markdown text (potentially containing JSX components) and compiles
 * it at runtime (vs. build time) into a React component. It handles both regular markdown syntax 
 * (headings, lists, code blocks) and custom JSX components (like <HelloWorld />).
 * 
 * @param props - The component props
 * @param props.content - The raw markdown/MDX content string to compile and render
 * @param props.runbookPath - The path to the runbook file
 * @param props.className - Optional additional CSS classes for styling the container
 
 */
interface MDXContainerProps {
  content: string
  className?: string
  runbookPath?: string
}

export const MDXContainer = ({ content, className }: MDXContainerProps) => {
  const [CustomMDXComponent, setCustomMDXComponent] = useState<React.ComponentType | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Compile the MDX content into a React component that the browser can render
  useEffect(() => {
    const createMDXComponent = async () => {
      try {
        setError(null)
        const compiledComponent = await compileMDX(content)
        setCustomMDXComponent(() => compiledComponent)
      } catch (err) {
        console.error('Error processing MDX content:', err)
        setError(String(err))
      }
    }

    createMDXComponent()
  }, [content])

  if (error) {
    return (
      <div className={`markdown-body border border-gray-200 rounded-lg shadow-md overflow-y-auto ${className}`}>
        <div className="text-red-600 p-4 border border-red-300 rounded-lg">
          <h3 className="font-semibold mb-2">Error processing MDX content:</h3>
          <pre className="text-sm whitespace-pre-wrap">{error}</pre>
        </div>
      </div>
    )
  }

  if (!CustomMDXComponent) {
    return (
      <div className={`markdown-body border border-gray-200 rounded-lg shadow-md overflow-y-auto ${className}`}>
        <div className="p-4 text-gray-500">Loading MDX content...</div>
      </div>
    )
  }

  return (
    <div className={`markdown-body border border-gray-200 rounded-lg shadow-md overflow-y-auto ${className}`}>
      <CustomMDXComponent />
    </div>
  )
}

// Compiles MDX content into a custom React component that can render the MDX content.
const compileMDX = async (content: string): Promise<React.ComponentType> => {
  // Create the MDX content without imports - we'll provide components directly
  const mdxContent = content

  // Compile and evaluate the MDX content
  const compiledMDX = await evaluate(mdxContent, {
    ...runtime,
    development: false, // Keep development false to avoid jsxDEV issues
    baseUrl: import.meta.url,
    useMDXComponents: () => ({
      HelloWorld,
      BoilerplateInputs,
      // Add more components here as needed
    })
  })

  return compiledMDX.default
}