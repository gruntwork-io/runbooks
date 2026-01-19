import React, { useState, useEffect } from 'react'
import { evaluate } from '@mdx-js/mdx'
import * as runtime from 'react/jsx-runtime'
import remarkGfm from 'remark-gfm'
import type { AppError } from '@/types/error'

// Support MDX components
import { Inputs } from '@/components/mdx/Inputs'
import { Template } from '@/components/mdx/Template'
import { TemplateInline } from '@/components/mdx/TemplateInline'
import { ComponentIdRegistryProvider } from '@/contexts/ComponentIdRegistry'
import { RunbookProvider } from '@/contexts/RunbookContext'
import { Check } from '@/components/mdx/Check'
import { Command } from '@/components/mdx/Command'
import { Admonition } from '@/components/mdx/Admonition'
import { AwsAuth } from '@/components/mdx/AwsAuth'
import { SmartLink } from '@/components/mdx/_shared/components/SmartLink'

/**
 * This component renders a markdown/MDX document.
 * 
 * It takes raw markdown text (potentially containing JSX components) and compiles
 * it at runtime (vs. build time) into a React component. It handles both regular markdown syntax 
 * (headings, lists, code blocks) and custom JSX components (like <Check />, <Command />, etc.).
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

function MDXContainer({ content, className }: MDXContainerProps) {
  const [CustomMDXComponent, setCustomMDXComponent] = useState<React.ComponentType | null>(null)
  const [error, setError] = useState<AppError | null>(null)

  // Compile the MDX content into a React component that the browser can render
  useEffect(() => {
    const createMDXComponent = async () => {
      try {
        setError(null)
        const compiledComponent = await compileMDX(content)
        setCustomMDXComponent(() => compiledComponent)
      } catch (err) {
        console.error('Error processing MDX content:', err)
        const errorMessage = err instanceof Error ? err.message : String(err)
        setError({
          message: 'Error processing MDX content',
          details: errorMessage
        })
      }
    }

    createMDXComponent()
  }, [content])

  if (error) {
    return (
      <div className={`markdown-body border border-gray-200 rounded-lg shadow-md overflow-y-auto ${className}`}>
        <div className="text-red-600 p-4 border border-red-300 rounded-lg">
          <h3 className="font-semibold mb-2">{error.message}</h3>
          <pre className="text-sm whitespace-pre-wrap">{error.details}</pre>
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
      <ComponentIdRegistryProvider>
        <RunbookProvider>
          <CustomMDXComponentErrorBoundary 
            onError={(error) => setError(error)}
          >
            {/* Security banner displayed at the top of every runbook */}
            <div className="mb-4">
              <Admonition 
                type="warning" 
                title="**Make sure you trust this Runbook!**" 
                confirmationText="I trust this Runbook"
                allowPermanentHide={true}
                storageKey="security-banner"
              >
                <p>Runbooks can execute <span className="italic">arbitrary code</span> directly in your environment. Please make sure you trust the author of this Runbook and carefully review embedded code snippets before running them.</p>
                <p>If you do not trust this Runbook, do not run it.</p>
              </Admonition>
            </div>
            <CustomMDXComponent />
          </CustomMDXComponentErrorBoundary>
        </RunbookProvider>
      </ComponentIdRegistryProvider>
    </div>
  )
}

// Type for rehype tree nodes
interface RehypeNode {
  type?: string
  tagName?: string
  properties?: {
    src?: string
    [key: string]: unknown
  }
  children?: RehypeNode[]
  [key: string]: unknown
}

// Custom rehype plugin to transform asset paths for all media types
// Transforms ./assets/file.ext to /runbook-assets/file.ext
function rehypeTransformAssetPaths() {
  return (tree: RehypeNode) => {
    // Helper function to transform a path if it starts with ./assets/
    const transformPath = (path: string | undefined): string | undefined => {
      if (!path || !path.startsWith('./assets/')) {
        return path
      }
      // Remove the ./assets/ prefix and prepend /runbook-assets/
      const assetPath = path.substring('./assets/'.length)
      return `/runbook-assets/${assetPath}`
    }

    // Walk through the tree and transform asset nodes
    const visit = (node: RehypeNode) => {
      if (node.type !== 'element') {
        // Recursively visit children first
        if (node.children) {
          node.children.forEach(visit)
        }
        return
      }

      // Handle different element types that can reference assets
      switch (node.tagName) {
        case 'img':
          // Image: <img src="./assets/image.png">
          if (node.properties?.src) {
            node.properties.src = transformPath(node.properties.src as string)
          }
          break

        case 'video':
        case 'audio':
          // Video/Audio: <video src="./assets/video.mp4">
          if (node.properties?.src) {
            node.properties.src = transformPath(node.properties.src as string)
          }
          // Also check poster attribute for video
          if (node.tagName === 'video' && node.properties?.poster) {
            node.properties.poster = transformPath(node.properties.poster as string)
          }
          break

        case 'source':
          // Source: <source src="./assets/video.mp4"> (child of video/audio)
          if (node.properties?.src) {
            node.properties.src = transformPath(node.properties.src as string)
          }
          break

        case 'a':
          // Links: <a href="./assets/document.pdf">
          if (node.properties?.href) {
            node.properties.href = transformPath(node.properties.href as string)
          }
          break

        case 'embed':
        case 'object':
          // Embedded content: <embed src="./assets/document.pdf">
          if (node.properties?.src) {
            node.properties.src = transformPath(node.properties.src as string)
          }
          // Object elements use 'data' attribute
          if (node.tagName === 'object' && node.properties?.data) {
            node.properties.data = transformPath(node.properties.data as string)
          }
          break
      }
      
      // Recursively visit children
      if (node.children) {
        node.children.forEach(visit)
      }
    }
    
    visit(tree)
  }
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
    remarkPlugins: [remarkGfm], // Enable GitHub Flavored Markdown (strikethrough, tables, etc.)
    rehypePlugins: [rehypeTransformAssetPaths],
    useMDXComponents: () => ({
      // Form and template components
      Inputs,
      Template,
      TemplateInline,
      // Script execution components
      Check,
      Command,
      // Authentication components
      AwsAuth,
      // Utility components
      Admonition,
      a: SmartLink, // Handle links intelligently (external open in new tab, anchors smooth scroll)
    })
  })

  return compiledMDX.default
}

// Error boundary for RUNTIME errors in MDX components
// This catches errors that occur during component rendering (e.g., accessing undefined properties)
// It does NOT catch compilation errors (e.g., undefined components) - those are caught in useEffect
class CustomMDXComponentErrorBoundary extends React.Component<
  { children: React.ReactNode; onError?: (error: AppError) => void },
  { hasError: boolean; error: AppError | null }
> {
  constructor(props: { children: React.ReactNode; onError?: (error: AppError) => void }) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error) {
    console.error('Runtime error in MDX component:', error.message)
    const appError: AppError = {
      message: error.message,
      details: error.stack || 'No additional details available'
    }
    if (error.message.includes('Expected component')) {
      appError.message = 'Runtime error in MDX component'
      appError.details = 'Your runbook contains a component that is not supported.\n\n' + error.message
    }
    if (this.props.onError) {
      this.props.onError(appError)
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="text-red-600 p-4 border border-red-300 rounded-lg bg-red-50">
          <h3 className="font-semibold mb-2">Runtime Error in MDX Component: {this.state.error?.message}</h3>
          <p className="text-sm">{this.state.error?.details}</p>
        </div>
      )
    }

    return this.props.children
  }
}

export default MDXContainer;