import React, { useState, useEffect, useMemo } from 'react'
import { evaluate } from '@mdx-js/mdx'
import * as runtime from 'react/jsx-runtime'
import remarkGfm from 'remark-gfm'
import type { AppError } from '@/types/error'

// Support MDX components
import { Inputs } from '@/components/mdx/Inputs'
import { Template } from '@/components/mdx/Template'
import { TemplateInline } from '@/components/mdx/TemplateInline'
import { ComponentIdRegistryProvider } from '@/contexts/ComponentIdRegistry'
import { RunbookContextProvider } from '@/contexts/RunbookContext'
import { Check } from '@/components/mdx/Check'
import { Command } from '@/components/mdx/Command'
import { Admonition } from '@/components/mdx/Admonition'
import { AwsAuth } from '@/components/mdx/AwsAuth'
import { GoogleAuth } from '@/components/mdx/GoogleAuth'
import { GitAuth } from '@/components/mdx/GitAuth'
import { GitHubAuth } from '@/components/mdx/GitHubAuth'
import { GitLabAuth } from '@/components/mdx/GitLabAuth'
import { GitClone } from '@/components/mdx/GitClone'
import { GitPullRequest } from '@/components/mdx/GitPullRequest'
import { GitHubPullRequest } from '@/components/mdx/GitHubPullRequest'
import { GitLabMergeRequest } from '@/components/mdx/GitLabMergeRequest'
import { DirPicker } from '@/components/mdx/DirPicker'
import { SmartLink } from '@/components/mdx/_shared/components/SmartLink'
import { CodeBlock } from '@/components/mdx/_shared/components/CodeBlock'
import { InstructionModeBanner } from '@/components/mdx/_shared/components/InstructionModeBanner'
import { TaskListCheckbox } from '@/components/mdx/_shared/components/TaskListCheckbox'

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
  remoteSource?: string
}

function MDXContainer({ content, runbookPath, remoteSource, className }: MDXContainerProps) {
  const [CustomMDXComponent, setCustomMDXComponent] = useState<React.ComponentType | null>(null)
  const [error, setError] = useState<AppError | null>(null)

  // Extract runbook name from its directory path (last segment)
  // e.g., "testdata/feature-demos/github-pull-request" → "github-pull-request"
  const runbookName = useMemo(() => {
    if (!runbookPath) return undefined
    const segments = runbookPath.replace(/[\\/]+$/, '').split(/[\\/]/)
    return segments[segments.length - 1] || undefined
  }, [runbookPath])

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
      <div className={`markdown-body border border-border rounded-lg shadow-md overflow-y-auto ${className}`}>
        <div data-testid="mdx-error" className="text-destructive p-4 border border-destructive/30 rounded-lg">
          <h3 className="font-semibold mb-2">{error.message}</h3>
          <pre className="text-sm whitespace-pre-wrap">{error.details}</pre>
        </div>
      </div>
    )
  }

  if (!CustomMDXComponent) {
    return (
      <div className={`markdown-body border border-border rounded-lg shadow-md overflow-y-auto ${className}`}>
        <div className="p-4 text-muted-foreground">Loading MDX content...</div>
      </div>
    )
  }

  return (
    <div data-testid="runbook-content" className={`markdown-body border border-border rounded-lg shadow-md overflow-y-auto ${className}`}>
      <ComponentIdRegistryProvider>
        <RunbookContextProvider runbookName={runbookName} remoteSource={remoteSource}>
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
                storageKey={`security-banner-${runbookPath || 'default'}`}
              >
                <p>Runbooks can execute <span className="italic">arbitrary code</span> directly in your environment. Please make sure you trust the author of this Runbook and carefully review embedded code snippets before running them.</p>
                <p>If you do not trust this Runbook, do not run it.</p>
              </Admonition>
            </div>
            {/* Instruction-mode indicator — renders only when the mode is on */}
            <div className="mb-4 empty:mb-0">
              <InstructionModeBanner />
            </div>
            <CustomMDXComponent />
          </CustomMDXComponentErrorBoundary>
        </RunbookContextProvider>
      </ComponentIdRegistryProvider>
    </div>
  )
}

// Attribute on an MDX JSX node. Literal attributes (`src="./a.png"`) have a
// string `value`; `src={expr}` has an expression object instead, and spread
// attributes (`{...props}`) have type 'mdxJsxExpressionAttribute'.
interface MdxJsxAttribute {
  type: string
  name?: string
  value?: unknown
}

// Type for rehype tree nodes
interface RehypeNode {
  type?: string
  tagName?: string
  properties?: {
    src?: string
    [key: string]: unknown
  }
  // Set on mdxJsxFlowElement / mdxJsxTextElement nodes (JSX written in the MDX)
  name?: string | null
  attributes?: MdxJsxAttribute[]
  children?: RehypeNode[]
  [key: string]: unknown
}

// The URL attributes, per HTML tag, that may reference a runbook asset. Shared
// by markdown-generated elements and HTML tags written directly in the MDX so
// the two can't drift apart. Only lowercase HTML tags are listed, so props on
// capitalized block components (<Command>, <Template>, ...) are never touched.
const ASSET_ATTRS = new Map<string, readonly string[]>([
  ['img', ['src']], // <img src="./assets/image.png">
  ['video', ['src', 'poster']], // <video src="./assets/video.mp4" poster="./assets/poster.png">
  ['audio', ['src']], // <audio src="./assets/audio.mp3">
  ['source', ['src']], // <source src="./assets/video.webm"> (child of video/audio)
  ['a', ['href']], // <a href="./assets/document.pdf">
  ['embed', ['src']], // <embed src="./assets/document.pdf">
  ['object', ['data']], // <object data="./assets/document.pdf">
])

// Custom rehype plugin to transform asset paths for all media types.
// Transforms ./assets/file.ext to runbook-asset://assets/file.ext so that
// Electron's custom protocol handler can serve them from the local filesystem.
// Exported for tests.
export function rehypeTransformAssetPaths() {
  return (tree: RehypeNode) => {
    // Helper function to transform a path if it starts with ./assets/
    const transformPath = (path: string): string => {
      if (!path.startsWith('./assets/')) {
        return path
      }
      // Remove the ./ prefix and use the runbook-asset:// protocol
      const assetPath = path.substring('./'.length)
      return `runbook-asset://${assetPath}`
    }

    // Walk through the tree and transform asset references. Markdown syntax
    // (![alt](./assets/a.png), [text](./assets/a.pdf)) produces hast `element`
    // nodes with a `properties` object. HTML written directly in the MDX
    // (<img>, <video>, <source>, ...) arrives instead as mdxJsxFlowElement
    // (block) or mdxJsxTextElement (inline) nodes with an `attributes` array.
    const visit = (node: RehypeNode) => {
      if (node.type === 'element' && node.tagName && node.properties) {
        for (const attr of ASSET_ATTRS.get(node.tagName) ?? []) {
          const value = node.properties[attr]
          if (typeof value === 'string') {
            node.properties[attr] = transformPath(value)
          }
        }
      } else if (
        (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') &&
        typeof node.name === 'string'
      ) {
        const attrs = ASSET_ATTRS.get(node.name) ?? []
        // Only string literals are rewritten; `src={expr}` is left as written.
        for (const attribute of node.attributes ?? []) {
          if (
            attribute.type === 'mdxJsxAttribute' &&
            attribute.name !== undefined &&
            attrs.includes(attribute.name) &&
            typeof attribute.value === 'string'
          ) {
            attribute.value = transformPath(attribute.value)
          }
        }
      }

      // Recursively visit children
      if (node.children) {
        node.children.forEach(visit)
      }
    }

    visit(tree)
  }
}

// Custom rehype plugin that gives every GitHub-flavored-markdown task-list
// checkbox a stable identity so the TaskListCheckbox override can persist its
// toggled state. GFM renders `- [ ]` / `- [x]` as a disabled
// `<input type="checkbox">` with no inherent identity; here we derive a key from
// the item's label text (with an ordinal suffix to disambiguate duplicate or
// empty labels) and attach it as `data-task-key`. Deriving from text — rather
// than a bare render index — keeps a checkbox's saved state aligned with its
// step even if other items are added or reordered.
function rehypeTaskListIds() {
  return (tree: RehypeNode) => {
    const slugCounts = new Map<string, number>()

    const getText = (node: RehypeNode): string => {
      if (node.type === 'text') return (node.value as string) || ''
      if (node.children) return node.children.map(getText).join('')
      return ''
    }

    const slugify = (text: string): string =>
      text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64)

    // Walk the tree, tracking each node's parent so we can read a checkbox's
    // sibling label text (the checkbox is the first child of its paragraph).
    const visit = (node: RehypeNode, parent: RehypeNode | undefined) => {
      if (
        node.type === 'element' &&
        node.tagName === 'input' &&
        node.properties?.type === 'checkbox'
      ) {
        const labelText = parent
          ? parent.children
              ?.filter((child) => child !== node)
              .map(getText)
              .join('')
              .trim() ?? ''
          : ''
        const slug = slugify(labelText) || 'task'
        const ordinal = slugCounts.get(slug) ?? 0
        slugCounts.set(slug, ordinal + 1)
        node.properties = node.properties || {}
        node.properties['data-task-key'] = ordinal === 0 ? slug : `${slug}-${ordinal}`
      }

      if (node.children) {
        node.children.forEach((child) => visit(child, node))
      }
    }

    visit(tree, undefined)
  }
}

// Strips YAML front matter from MDX content.
// Front matter is YAML metadata between --- delimiters at the start of the file.
// Example:
//   ---
//   title: My Runbook
//   ---
//   # Content here
const stripFrontMatter = (content: string): string => {
  // Front matter must start at the beginning of the file with ---
  if (!content.startsWith('---')) {
    return content
  }
  
  // Find the closing --- delimiter (must be on its own line)
  const endMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  if (!endMatch) {
    return content
  }
  
  // Remove the front matter block
  return content.slice(endMatch[0].length)
}

/**
 * The MDX element → block component registry. Exported so tests can enumerate
 * the exact set of blocks the renderer supports and assert each interactive
 * block honors instruction mode (spec §9/§10) — a new block added here without
 * instruction-mode handling fails that test.
 */
export const MDX_COMPONENTS = {
  // Form and template components
  Inputs,
  Template,
  TemplateInline,
  DirPicker,
  // Script execution components
  Check,
  Command,
  // Authentication components
  AwsAuth,
  GoogleAuth,
  GitAuth,
  GitHubAuth,
  GitLabAuth,
  // Git operations
  GitClone,
  GitPullRequest,
  GitHubPullRequest,
  GitLabMergeRequest,
  // Utility components
  Admonition,
  a: SmartLink, // Handle links intelligently (external open in new tab, anchors smooth scroll)
  pre: CodeBlock, // Code blocks with copy-on-hover button
  input: TaskListCheckbox, // Make GFM task-list checkboxes interactive + persistent
} as const

// Compiles MDX content into a custom React component that can render the MDX content.
const compileMDX = async (content: string): Promise<React.ComponentType> => {
  // Strip front matter before MDX compilation (front matter is metadata, not content)
  const mdxContent = stripFrontMatter(content)

  // Compile and evaluate the MDX content
  const compiledMDX = await evaluate(mdxContent, {
    ...runtime,
    development: false, // Keep development false to avoid jsxDEV issues
    baseUrl: import.meta.url,
    remarkPlugins: [remarkGfm], // Enable GitHub Flavored Markdown (strikethrough, tables, etc.)
    rehypePlugins: [rehypeTransformAssetPaths, rehypeTaskListIds],
    useMDXComponents: () => MDX_COMPONENTS,
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
        <div data-testid="mdx-error" className="text-destructive p-4 border border-destructive/30 rounded-lg bg-destructive-muted">
          <h3 className="font-semibold mb-2">Runtime Error in MDX Component: {this.state.error?.message}</h3>
          <p className="text-sm">{this.state.error?.details}</p>
        </div>
      )
    }

    return this.props.children
  }
}

export default MDXContainer;