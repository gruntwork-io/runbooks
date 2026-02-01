import Ansi from 'ansi-to-react'
import { LinkifiedText } from './LinkifiedText'
import './AnsiText.css'

interface AnsiTextProps {
  text: string
  /** If true, also linkify URLs in the text */
  linkify?: boolean
}

/**
 * Strip non-color ANSI sequences that ansi-to-react doesn't handle.
 * This includes character set designation sequences like ESC(B from tput sgr0.
 */
function stripNonColorAnsi(text: string): string {
  // Strip character set designation: ESC ( X, ESC ) X, ESC * X, ESC + X
  // These are used by tput sgr0 and similar commands
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b[()*/+-].?/g, '')
}

/**
 * Renders text with ANSI escape codes as colored HTML.
 * Supports standard terminal colors (16-color, 256-color, and 24-bit RGB).
 * 
 * Usage:
 *   <AnsiText text="\x1b[32mGreen text\x1b[0m" />
 */
export function AnsiText({ text, linkify = true }: AnsiTextProps) {
  // Strip non-color ANSI sequences that ansi-to-react can't handle
  const cleanedText = stripNonColorAnsi(text)
  
  // Check if text contains color ANSI codes (CSI sequences)
  // eslint-disable-next-line no-control-regex
  const hasAnsi = /\x1b\[/.test(cleanedText)
  
  if (!hasAnsi) {
    // No ANSI codes - use LinkifiedText for URL detection
    return linkify ? <LinkifiedText text={cleanedText} /> : <span>{cleanedText}</span>
  }
  
  // Has ANSI codes - render with ansi-to-react
  // Note: ansi-to-react handles the conversion, but URLs inside won't be clickable
  // This is a trade-off for supporting colors
  // Use useClasses to output CSS class names instead of inline styles (easier to customize)
  return (
    <span className="ansi-text">
      <Ansi useClasses>{cleanedText}</Ansi>
    </span>
  )
}
