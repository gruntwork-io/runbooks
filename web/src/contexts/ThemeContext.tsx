import { useState, useEffect, useCallback, useMemo, type ReactNode } from "react"
import { useApi } from "./ApiContext"
import { useMediaQuery } from "@/hooks/useMediaQuery"
import {
  ThemeContext,
  THEME_STORAGE_KEY,
  type Theme,
  type ResolvedTheme,
} from "./ThemeContext.types"

/** The OS theme, which 'system' mode follows live. */
const DARK_QUERY = "(prefers-color-scheme: dark)"

/** Read the persisted preference, defaulting to 'system'. */
function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored
    }
  } catch {
    /* localStorage unavailable (e.g. private mode) */
  }
  return "system"
}

/** Toggle the `.dark` class on <html> — the hook for the `dark:` Tailwind variant. */
function applyThemeClass(resolved: ResolvedTheme): void {
  document.documentElement.classList.toggle("dark", resolved === "dark")
}

/**
 * Provides the app's theme state. The `.dark` class is applied to <html>
 * before this mounts by web/public/theme-init.js (preventing a flash); this
 * provider keeps it in sync afterwards and notifies the main process so it can
 * update native window chrome.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const api = useApi()
  const [theme, setThemeState] = useState<Theme>(readStoredTheme)
  const systemDark = useMediaQuery(DARK_QUERY)
  const resolvedTheme: ResolvedTheme = theme === "system" ? (systemDark ? "dark" : "light") : theme

  useEffect(() => {
    applyThemeClass(resolvedTheme)
  }, [resolvedTheme])

  // Tell the main process about the preference so it can update native chrome
  // (title bar, nativeTheme.themeSource).
  useEffect(() => {
    // api is null when ThemeProvider is rendered outside ApiProvider (e.g.
    // tests that don't bridge IPC). Native chrome sync is best-effort.
    api?.invoke("native:set-theme", { theme }).catch(() => {
      /* native chrome update is best-effort */
    })
  }, [theme, api])

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
