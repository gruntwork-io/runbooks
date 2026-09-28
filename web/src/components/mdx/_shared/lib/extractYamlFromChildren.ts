import React from 'react'
import type { ReactNode } from 'react'
import type { AppError } from '@/types/error'

export interface YamlExtractionResult {
  content: string
  error: AppError | null
}

/**
 * Helper function to extract YAML content from React children
 *
 * Inline YAML must be wrapped in a code fence (```yaml\n...\n```), which MDX
 * passes through with its exact formatting. Unfenced YAML is rejected with a
 * configuration error: MDX turns it into p/ul/li elements, and the original
 * indentation cannot be recovered from those. That holds at any depth, so YAML
 * inside an author-written wrapper such as <div> gets the same error.
 *
 * @returns Object with content and error (if validation fails)
 */
export function extractYamlFromChildren(children: ReactNode): YamlExtractionResult {
  // Check for missing code fence - detect if MDX parsed YAML as HTML elements
  if (children) {
    if (Array.isArray(children) || containsMarkdownBlocks(children)) {
      return {
        content: '',
        error: {
          message: "Invalid inline boilerplate configuration format",
          details: "Please wrap your YAML content in a code fence (```yaml ... ```). Without code fences, MDX converts YAML into HTML elements, which cannot be parsed correctly."
        }
      }
    }
  }

  const content = extractYamlContent(children)
  return {
    content,
    error: null
  }
}

/** Elements MDX creates from unfenced text (paragraphs and lists). */
const MARKDOWN_BLOCK_TYPES = new Set(['p', 'ul', 'ol', 'li'])

/**
 * True when `children` holds an element MDX made from unfenced text, outside
 * any code fence.
 */
function containsMarkdownBlocks(children: ReactNode): boolean {
  if (Array.isArray(children)) {
    return children.some(containsMarkdownBlocks)
  }
  if (!React.isValidElement(children) || isPreElement(children)) {
    return false
  }
  if (typeof children.type === 'string' && MARKDOWN_BLOCK_TYPES.has(children.type)) {
    return true
  }
  return containsMarkdownBlocks((children.props as { children?: ReactNode }).children)
}

/**
 * True for a code fence: a native pre element, or the CodeBlock component
 * MDXContainer renders pre elements with.
 */
function isPreElement(element: React.ReactElement): boolean {
  if (element.type === 'pre') {
    return true
  }
  if (typeof element.type === 'function' || (typeof element.type === 'object' && element.type !== null)) {
    const componentType = element.type as { name?: string; displayName?: string }
    return componentType.name === 'CodeBlock' || componentType.displayName === 'CodeBlock'
  }
  return false
}

/**
 * Internal helper to recursively extract YAML content from React children
 */
function extractYamlContent(children: ReactNode): string {
  if (typeof children === 'string') {
    return children
  }

  if (Array.isArray(children)) {
    return children.map(extractYamlContent).join('')
  }

  if (React.isValidElement(children)) {
    const element = children as React.ReactElement<{ children?: ReactNode; className?: string }>

    // Handle pre elements - these contain code fences
    if (isPreElement(element)) {
      // Extract the code content from the code element inside pre
      const content = extractYamlContent(element.props.children)
      // Return the content directly - it's already properly formatted
      return content.trim()
    }

    // For other elements (e.g. the code element inside a pre), extract children
    return extractYamlContent(element.props.children)
  }

  return ''
}
