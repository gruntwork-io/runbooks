import ReactMarkdown from 'react-markdown'
import { cn } from '../lib/utils'

interface MarkdownContainerProps {
  content: string
  className?: string
}

/**
 * A reusable container component for rendering markdown content.
 * 
 * This component provides a consistent styling wrapper around ReactMarkdown,
 * including common styles like borders, shadows, and overflow handling.
 * It's designed to be layout-agnostic, allowing parent components to control
 * sizing and positioning through the className prop.
 * 
 * @param props - The component props
 * @param props.content - The markdown content string to render
 * @param props.className - Optional additional CSS classes for layout-specific styling
 * 
 */
export const MarkdownContainer = ({ content, className }: MarkdownContainerProps) => {
  return (
    <div className={cn(
      "markdown-body border border-gray-200 rounded-lg shadow-md overflow-y-auto",
      className
    )}>
      <ReactMarkdown>{content}</ReactMarkdown>
    </div>
  )
}
