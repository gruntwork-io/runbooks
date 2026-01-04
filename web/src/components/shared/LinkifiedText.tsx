import React from 'react'
import { stripAnsi } from '@/lib/utils'

/**
 * Regular expression to match URLs in text.
 * Matches http://, https://, and www. URLs.
 */
const URL_REGEX = /(?:https?:\/\/|www\.)[^\s<>"'`]+/gi

interface LinkifiedTextProps {
  text: string
  className?: string
  linkClassName?: string
}

/**
 * Component that renders text with URLs converted to clickable links.
 * URLs are opened in a new window/tab.
 */
export function LinkifiedText({ 
  text, 
  className = '',
  linkClassName = 'text-blue-400 hover:text-blue-300 underline'
}: LinkifiedTextProps) {
  const parts = React.useMemo(() => {
    // Strip ANSI escape codes before processing
    const cleanText = stripAnsi(text)
    
    const result: (string | React.ReactElement)[] = []
    let textProcessedUpTo = 0
    let regexMatch: RegExpExecArray | null

    // Reset regex state to ensure we start from the beginning
    URL_REGEX.lastIndex = 0
    
    while ((regexMatch = URL_REGEX.exec(cleanText)) !== null) {
      const urlStartIndex = regexMatch.index
      const urlText = regexMatch[0]
      const urlEndIndex = urlStartIndex + urlText.length
      
      // Add text before the URL
      if (urlStartIndex > textProcessedUpTo) {
        result.push(cleanText.slice(textProcessedUpTo, urlStartIndex))
      }
      
      // Ensure URL has protocol
      const href = urlText.startsWith('www.') ? `https://${urlText}` : urlText
      
      // Add the URL as a clickable link
      result.push(
        <a
          key={`${urlStartIndex}-${urlText}`}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className={linkClassName}
          onClick={(e) => e.stopPropagation()}
        >
          {urlText}
        </a>
      )
      
      textProcessedUpTo = urlEndIndex
    }
    
    // Add any remaining text after the last URL
    if (textProcessedUpTo < cleanText.length) {
      result.push(cleanText.slice(textProcessedUpTo))
    }
    
    return result
  }, [text, linkClassName])

  if (className) {
    return <span className={className}>{parts}</span>
  }
  
  return <>{parts}</>
}

