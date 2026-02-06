import Ansi from 'ansi-to-react'
import { LinkifiedText } from '../LinkifiedText'
import './TerminalText.css'

interface TerminalTextProps {
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
 * Renders terminal output text, handling both plain text and ANSI escape codes.
 * 
 * - Plain text (no ANSI codes): Uses LinkifiedText for clickable URLs
 * - ANSI text (has escape codes): Uses ansi-to-react for colored output
 * 
 * Usage:
 *   <TerminalText text="Plain text with https://example.com" />
 *   <TerminalText text="\x1b[32mGreen text\x1b[0m" />
 */
export function TerminalText({ text, linkify = true }: TerminalTextProps) {
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
    <span className="terminal-text">
      <Ansi useClasses>{cleanedText}</Ansi>
    </span>
  )
}
