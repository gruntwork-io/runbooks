import type { CSSProperties } from 'react'

/**
 * Shared line-number gutter styling for the react-syntax-highlighter usages
 * across the code/file viewers. Per-call `customStyle` overrides (borders,
 * background, whitespace) stay at the call sites — only the identical gutter
 * styling lives here.
 */
export const PRISM_LINE_NUMBER_STYLE: CSSProperties = {
  color: '#999',
  fontSize: '11px',
  paddingRight: '12px',
  borderRight: '1px solid #eee',
  marginRight: '8px',
}
