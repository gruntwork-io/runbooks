/**
 * IPC handler for theme changes.
 *
 * The renderer owns the theme preference (persisted in localStorage); this
 * handler mirrors the choice into the pieces the main process controls:
 *   - nativeTheme.themeSource, so 'system' truly follows the OS and native
 *     dialogs / context menus match the app. Assigning themeSource also fires
 *     nativeTheme's 'updated' event, which the listener in index.ts uses to
 *     recolor the title bar overlay.
 *   - theme-store.ts, a main-process mirror of the preference so the next
 *     launch can create the window with the correct native chrome immediately.
 */
import { ipcMain, nativeTheme } from "electron"
import { setStoredTheme, type Theme } from "../theme-store.ts"

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark" || value === "system"
}

export function registerThemeHandlers(): void {
  ipcMain.handle("native:set-theme", async (_event, payload: unknown) => {
    const theme = (payload as { theme?: unknown } | null)?.theme
    if (!isTheme(theme)) {
      throw new Error(`Invalid theme: ${String(theme)}`)
    }
    nativeTheme.themeSource = theme
    setStoredTheme(theme)
    return { ok: true } as const
  })
}
