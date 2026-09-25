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
 * indentation cannot be recovered from those.
 * 
 * @returns Object with content and error (if validation fails)
 */
export function extractYamlFromChildren(children: ReactNode): YamlExtractionResult {
  // Check for missing code fence - detect if MDX parsed YAML as HTML elements
  if (children) {
    const isArray = Array.isArray(children)
    const isReactElement = React.isValidElement(children) && 
       (children.type === 'p' || children.type === 'ul' || children.type === 'li')
    
    if (isArray || isReactElement) {
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
    // MDX can use either native 'pre' elements or custom CodeBlock components
    let isPreElement = false;
    if (element.type === 'pre') {
      isPreElement = true;
    } else if (typeof element.type === 'function') {
      const funcType = element.type as { name?: string; displayName?: string };
      isPreElement = funcType.name === 'CodeBlock' || funcType.displayName === 'CodeBlock';
    } else if (typeof element.type === 'object' && element.type !== null) {
      const objType = element.type as { name?: string; displayName?: string };
      isPreElement = objType.name === 'CodeBlock' || objType.displayName === 'CodeBlock';
    }
    
    if (isPreElement) {
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
