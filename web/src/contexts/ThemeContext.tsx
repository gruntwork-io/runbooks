import { useState, useEffect, useCallback, useMemo, type ReactNode } from 'react'
import {
  ThemeContext,
  THEME_STORAGE_KEY,
  type Theme,
  type ResolvedTheme,
} from './ThemeContext.types'

const DARK_QUERY = '(prefers-color-scheme: dark)'

/** Read the persisted preference, defaulting to 'system'. */
function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      return stored
    }
  } catch {
    /* localStorage unavailable (e.g. private mode) */
  }
  return 'system'
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(DARK_QUERY).matches
}

function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme === 'system') return systemPrefersDark() ? 'dark' : 'light'
  return theme
}

/** Toggle the `.dark` class on <html> — the hook for the `dark:` Tailwind variant. */
function applyThemeClass(resolved: ResolvedTheme): void {
  document.documentElement.classList.toggle('dark', resolved === 'dark')
}

/**
 * Provides the app's theme state. The `.dark` class is applied to <html>
 * before this mounts by web/public/theme-init.js (preventing a flash); this
 * provider keeps it in sync afterwards and notifies the main process so it can
 * update native window chrome.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme)
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    resolveTheme(readStoredTheme()),
  )

  // Apply the resolved theme whenever the preference changes, and tell the main
  // process so it can update native chrome (title bar, nativeTheme.themeSource).
  useEffect(() => {
    const resolved = resolveTheme(theme)
    setResolvedTheme(resolved)
    applyThemeClass(resolved)
    // window.api is absent when opened in a plain browser (see main.tsx).
    window.api?.invoke('native:set-theme', { theme }).catch(() => {
      /* native chrome update is best-effort */
    })
  }, [theme])

  // In 'system' mode, follow live OS theme changes.
  useEffect(() => {
    if (theme !== 'system') return
    const mq = window.matchMedia(DARK_QUERY)
    const onChange = () => {
      const resolved: ResolvedTheme = mq.matches ? 'dark' : 'light'
      setResolvedTheme(resolved)
      applyThemeClass(resolved)
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme])

  const setTheme = useCallback((next: Theme) => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next)
    } catch {
      /* localStorage unavailable — preference won't persist across launches */
    }
    setThemeState(next)
  }, [])

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}
