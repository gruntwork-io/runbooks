/**
 * Persists the user's theme preference in the main process.
 *
 * The renderer's localStorage (read by web/public/theme-init.js) is the
 * authoritative store for the in-app `.dark` class. This file is a main-process
 * mirror, written alongside it via the native:set-theme IPC handler, so the
 * BrowserWindow can be created with the correct native chrome (background
 * color, title bar overlay) on the very first frame — before the renderer has
 * mounted and reported its resolved theme over IPC.
 */
import { app } from "electron"
import * as fs from "fs"
import * as path from "path"

export type Theme = "light" | "dark" | "system"

function themeFilePath(): string {
  return path.join(app.getPath("userData"), "theme.json")
}

/** Read the persisted theme preference, defaulting to "system". */
export function getStoredTheme(): Theme {
  try {
    const raw = fs.readFileSync(themeFilePath(), "utf8")
    const parsed = JSON.parse(raw) as { theme?: unknown }
    if (parsed.theme === "light" || parsed.theme === "dark" || parsed.theme === "system") {
      return parsed.theme
    }
  } catch {
    // File missing, unreadable, or malformed — fall back to the default.
  }
  return "system"
}

/** Persist the theme preference. Best-effort; failures are non-fatal. */
export function setStoredTheme(theme: Theme): void {
  try {
    fs.writeFileSync(themeFilePath(), JSON.stringify({ theme }), "utf8")
  } catch (err) {
    // Disk/permission error — the renderer's localStorage still holds the
    // preference; only the first-frame native chrome would be affected. Warn
    // so failures are diagnosable from the main-process log.
    console.warn(`[theme-store] failed to persist theme "${theme}":`, err)
  }
}
