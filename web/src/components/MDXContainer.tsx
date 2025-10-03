import React, { useState, useEffect } from 'react'
import { evaluate } from '@mdx-js/mdx'
import * as runtime from 'react/jsx-runtime'
import type { AppError } from '@/types/error'

// Support MDX components
import { HelloWorld } from '@/components/mdx/HelloWorld'
import { BoilerplateInputs } from '@/components/mdx/BoilerplateInputs'
import { BoilerplateTemplate } from '@/components/mdx/BoilerplateTemplate'
import { BoilerplateVariablesProvider } from '@/contexts/BoilerplateVariablesContext'
import { BoilerplateRenderCoordinatorProvider } from '@/contexts/BoilerplateRenderCoordinator'
import { Check } from '@/components/mdx/Check'
import { Command } from '@/components/mdx/Command'
import { Admonition } from '@/components/mdx/Admonition'

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
      <BoilerplateVariablesProvider>
        <BoilerplateRenderCoordinatorProvider>
          <CustomMDXComponentErrorBoundary 
            onError={(error) => setError(error)}
          >
            {/* Security banner displayed at the top of every runbook */}
            <div className="mb-4">
              <Admonition 
                type="warning" 
                title="**Make sure you trust this Runbook!**" 
                confirmationText="I trust this Runbook and understand the security implications"
                allowPermanentHide={true}
                storageKey="security-banner"
              >
                <p>Runbooks can execute <span className="italic">arbitrary code</span> directly in your environment. Please make sure you trust the author of this Runbook and carefully review embedded code snippets before running them.</p>
                <p>If you do not trust this Runbook, do not run it.</p>
              </Admonition>
            </div>
            <CustomMDXComponent />
          </CustomMDXComponentErrorBoundary>
        </BoilerplateRenderCoordinatorProvider>
      </BoilerplateVariablesProvider>
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
      BoilerplateTemplate,
      Check,
      Command,
      Admonition,
      // Add more components here as needed
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