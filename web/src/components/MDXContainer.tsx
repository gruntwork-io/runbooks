import { useState, useEffect } from 'react'
import { evaluate } from '@mdx-js/mdx'
import * as runtime from 'react/jsx-runtime'

// Support MDX components
import { HelloWorld } from '@/components/mdx/HelloWorld'
import { BoilerplateInputs } from '@/components/mdx/BoilerplateInputs'

interface MDXContainerProps {
  content: string
  className?: string
}

/**
 * This component renders a markdown/MDX document..
 * 
 * The component takes raw markdown text (potentially containing JSX components) and compiles
 * it at runtime (vs. build time) into a React component. It handles both regular markdown syntax 
 * (headings, lists, code blocks) and custom JSX components (like <HelloWorld />).
 * 
 * @param props - The component props
 * @param props.content - The raw markdown/MDX content string to compile and render
 * @param props.className - Optional additional CSS classes for styling the container
 */
export const MDXContainer = ({ content, className }: MDXContainerProps) => {
  const [MDXContent, setMDXContent] = useState<React.ComponentType | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Compile the MDX content into a React component that the browser can render
  useEffect(() => {
    const compileMDX = async () => {
      try {
        setError(null)
        
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

        setMDXContent(() => compiledMDX.default)
      } catch (err) {
        console.error('Error processing MDX content:', err)
        setError(String(err))
      }
    }

    compileMDX()
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

  if (!MDXContent) {
    return (
      <div className={`markdown-body border border-gray-200 rounded-lg shadow-md overflow-y-auto ${className}`}>
        <div className="p-4 text-gray-500">Loading MDX content...</div>
      </div>
    )
  }

  return (
    <div className={`markdown-body border border-gray-200 rounded-lg shadow-md overflow-y-auto ${className}`}>
      <MDXContent />
    </div>
  )
}
