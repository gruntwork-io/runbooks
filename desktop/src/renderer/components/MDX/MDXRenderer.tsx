import React, { useState, useEffect } from 'react'
import { evaluate } from '@mdx-js/mdx'
import * as runtime from 'react/jsx-runtime'
import remarkGfm from 'remark-gfm'
import { Check } from './blocks/Check'
import { Command } from './blocks/Command'
import { Admonition } from './blocks/Admonition'
import { Inputs, BoilerplateInputs } from './blocks/Inputs'
import { Template } from './blocks/Template'
import { GitHubAuth } from './blocks/GitHubAuth'
import { GitClone } from './blocks/GitClone'
import { CodeBlock } from './blocks/CodeBlock'

interface MDXRendererProps {
  content: string
  runbookFolder: string
  className?: string
}

export function MDXRenderer({ content, runbookFolder, className }: MDXRendererProps) {
  const [MDXContent, setMDXContent] = useState<React.ComponentType | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const compile = async () => {
      try {
        setError(null)
        const compiled = await evaluate(content, {
          ...runtime,
          development: false,
          remarkPlugins: [remarkGfm],
          useMDXComponents: () => ({
            // Runbook block components
            Check: (props: Record<string, unknown>) => <Check {...props} runbookFolder={runbookFolder} />,
            Command: (props: Record<string, unknown>) => <Command {...props} runbookFolder={runbookFolder} />,
            Admonition,
            Inputs,
            BoilerplateInputs,
            Template: (props: Record<string, unknown>) => <Template {...props} runbookFolder={runbookFolder} />,
            TemplateInline: PlaceholderBlock,
            GitHubAuth,
            GitClone,
            // Components not yet supported in desktop - show placeholder
            GitHubPullRequest: PlaceholderBlock,
            AwsAuth: PlaceholderBlock,
            // Override code blocks
            pre: CodeBlock,
          }),
        })

        if (!cancelled) {
          setMDXContent(() => compiled.default)
        }
      } catch (err) {
        if (!cancelled) {
          console.error('MDX compilation error:', err)
          setError(err instanceof Error ? err.message : String(err))
        }
      }
    }

    compile()
    return () => { cancelled = true }
  }, [content, runbookFolder])

  if (error) {
    return (
      <div className={`p-6 ${className || ''}`}>
        <div className="rounded-lg bg-red-50 border border-red-200 p-4">
          <h3 className="text-sm font-medium text-red-800">Error compiling runbook</h3>
          <pre className="mt-2 text-sm text-red-600 whitespace-pre-wrap font-mono">{error}</pre>
        </div>
      </div>
    )
  }

  if (!MDXContent) {
    return (
      <div className={`p-6 ${className || ''}`}>
        <div className="text-neutral-500 text-sm">Loading runbook...</div>
      </div>
    )
  }

  return (
    <div className={`runbook-content p-6 ${className || ''}`}>
      <ErrorBoundary>
        <MDXContent />
      </ErrorBoundary>
    </div>
  )
}

function PlaceholderBlock(props: { id?: string; title?: string; [key: string]: unknown }) {
  const name = props.title || props.id || 'Unknown'
  return (
    <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4 mb-4">
      <div className="text-sm text-neutral-500">
        <span className="font-medium">{name}</span> — Component not yet supported in desktop app
      </div>
    </div>
  )
}

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: string | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error: error.message }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="rounded-lg bg-red-50 border border-red-200 p-4">
          <h3 className="text-sm font-medium text-red-800">Runtime error in runbook</h3>
          <pre className="mt-2 text-sm text-red-600 whitespace-pre-wrap font-mono">
            {this.state.error}
          </pre>
        </div>
      )
    }
    return this.props.children
  }
}
