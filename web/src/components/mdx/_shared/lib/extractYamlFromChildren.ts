import React from 'react'
import type { ReactNode } from 'react'
import type { AppError } from '@/types/error'

export interface YamlExtractionResult {
  content: string
  error: AppError | null
}

/**
 * Helper function to extract YAML content from React children
 * This handles the case where MDX parses inline content as JSX elements.
 * 
 * Supports two formats:
 * 1. Code fence (RECOMMENDED): ```yaml\n...\n```
 *    - MDX preserves exact formatting
 *    - No reconstruction needed
 * 
 * 2. Inline YAML (LEGACY): Raw YAML text
 *    - MDX parses into HTML-like elements
 *    - Requires reconstruction (fragile)
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
    
    // Handle different JSX element types that MDX might create
    if (element.type === 'br') {
      return '\n'
    }
    
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
    
    // Handle code elements - preserve their content exactly
    if (element.type === 'code') {
      // For code fences, MDX adds a className like "language-yaml"
      // The children contain the exact code content
      const content = extractYamlContent(element.props.children)
      return content
    }
    
    // Handle paragraph elements - they often contain YAML content
    if (element.type === 'p') {
      const content = extractYamlContent(element.props.children)
      // Don't add extra newlines for paragraphs - let the content flow naturally
      return content
    }
    
    // Handle list items - these are important for YAML structure
    if (element.type === 'li') {
      const content = extractYamlContent(element.props.children)
      const cleanContent = content.trim()
      
      if (cleanContent) {
        // Check if this is a malformed case where "default: dev" got merged with "prod"
        if (cleanContent.includes('\ndefault: ')) {
          const parts = cleanContent.split('\ndefault: ')
          if (parts.length === 2) {
            const listItem = parts[0]
            const defaultValue = parts[1]
            return '- ' + listItem + '\n  default: ' + defaultValue + '\n'
          }
        }
        
        // Handle multi-line content (like "name: AccountName\ndescription: ...")
        const lines = cleanContent.split('\n')
        if (lines.length === 1) {
          return '- ' + cleanContent + '\n'
        } else {
          // First line gets the list marker, subsequent lines get proper indentation
          const firstLine = '- ' + lines[0]
          const indentedLines = lines.slice(1).map(line => '    ' + line)
          return [firstLine, ...indentedLines].join('\n') + '\n'
        }
      }
      return ''
    }
    
    // Handle unordered lists - these represent YAML arrays
    if (element.type === 'ul') {
      const content = extractYamlContent(element.props.children)
      // Add 2 spaces of indentation for all non-empty lines
      const lines = content.split('\n')
      const indentedLines = lines.map(line => {
        if (line.trim() === '') return line
        return '  ' + line
      })
      return indentedLines.join('\n')
    }
    
    // Handle div elements - they might contain structured content
    if (element.type === 'div') {
      return extractYamlContent(element.props.children)
    }
    
    // Handle strong/bold elements - they might be used for emphasis
    if (element.type === 'strong' || element.type === 'b') {
      return extractYamlContent(element.props.children)
    }
    
    // Handle em/italic elements
    if (element.type === 'em' || element.type === 'i') {
      return extractYamlContent(element.props.children)
    }
    
    // For other elements, extract children
    return extractYamlContent(element.props.children)
  }
  
  return ''
}
