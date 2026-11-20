import ansiToReact from "ansi-to-react"
import { stripNonColorAnsi } from "@/lib/logs"
import { LinkifiedText } from "../LinkifiedText"
import "./TerminalText.css"

// ansi-to-react is CommonJS that sets __esModule and exports.default. Vite
// gives an importer in a "type": "module" package Node's interop, so in the
// build the default import is module.exports; vitest and tsc see the component.
const Ansi = (ansiToReact as unknown as { default?: typeof ansiToReact }).default ?? ansiToReact

interface TerminalTextProps {
  text: string
  /** If true, also linkify URLs in the text */
  linkify?: boolean
  /**
   * Whether long lines wrap. Defaults to true (preserve existing behavior).
   * When false, whitespace is preserved on a single line so the container
   * can scroll horizontally instead of wrapping.
   */
  wrap?: boolean
}

/**
 * Renders terminal output text, handling both plain text and ANSI escape codes.
 *
 * - Plain text (no ANSI codes): Uses LinkifiedText for clickable URLs
 * - ANSI text (has escape codes): Uses ansi-to-react for colored output, with
 *   its built-in linkify for clickable URLs
 *
 * `linkify` applies to both paths. lib/logs' shownText is the text this
 * shows, for search; change the two together.
 *
 * Usage:
 *   <TerminalText text="Plain text with https://example.com" />
 *   <TerminalText text="\x1b[32mGreen text\x1b[0m" />
 */
export function TerminalText({ text, linkify = true, wrap = true }: TerminalTextProps) {
  // Strip non-color ANSI sequences that ansi-to-react can't handle
  const cleanedText = stripNonColorAnsi(text)

  // Check if text contains color ANSI codes (CSI sequences)
  // eslint-disable-next-line no-control-regex
  const hasAnsi = /\x1b\[/.test(cleanedText)

  const className = wrap ? "terminal-text" : "terminal-text terminal-text--nowrap"

  if (!hasAnsi) {
    // No ANSI codes - use LinkifiedText for URL detection
    return (
      <span className={className}>
        {linkify ? <LinkifiedText text={cleanedText} /> : cleanedText}
      </span>
    )
  }

  // Has ANSI codes - render with ansi-to-react
  // Use useClasses to output CSS class names instead of inline styles (easier to customize)
  // linkify stays a boolean (the library's classic URL regex): "fuzzy" mode would
  // also link bare names with a real TLD, such as main.tf in terraform output
  return (
    <span className={className}>
      <Ansi useClasses linkify={linkify}>
        {cleanedText}
      </Ansi>
    </span>
  )
}
