import { useContext } from 'react'
import { AuthorModeContext } from './AuthorModeContext'

/**
 * useAuthorMode returns the current Author Mode state and setters.
 *
 * Throws if called outside an AuthorModeProvider — every render path
 * we ship goes through App.tsx, which wraps the tree in the provider,
 * so a missing context here is always a coding mistake.
 */
export function useAuthorMode() {
  const ctx = useContext(AuthorModeContext)
  if (!ctx) {
    throw new Error('useAuthorMode must be used inside an AuthorModeProvider')
  }
  return ctx
}
