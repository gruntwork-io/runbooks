import { createContext } from 'react'

/** The user's theme preference. 'system' follows the OS. */
export type Theme = 'light' | 'dark' | 'system'

/** The actual theme in effect, with 'system' resolved against the OS. */
export type ResolvedTheme = 'light' | 'dark'

export interface ThemeContextValue {
  /** The user's preference: 'light', 'dark', or 'system'. */
  theme: Theme
  /** The theme actually applied — 'system' resolved against the OS. */
  resolvedTheme: ResolvedTheme
  /** Update the preference. Persists to localStorage and updates native chrome. */
  setTheme: (theme: Theme) => void
}

export const ThemeContext = createContext<ThemeContextValue | undefined>(undefined)

/**
 * localStorage key for the persisted theme preference.
 * Mirrored in web/public/theme-init.js — keep the two in sync.
 */
export const THEME_STORAGE_KEY = 'runbooks-theme'
