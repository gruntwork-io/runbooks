/**
 * E2E tests for the dark-mode theme toggle.
 *
 * Launches the real Electron app with a throwaway --user-data-dir so each test
 * gets an isolated theme.json (and its own single-instance lock). Verifies the
 * full loop: Header menu → ThemeContext → `.dark` class + localStorage, the
 * theme-init.js persistence path across a reload, and the main-process
 * persistence (theme.json → nativeTheme.themeSource) across a relaunch.
 *
 * Prerequisites: run `electron-vite build` first (expects ./dist/main/index.js).
 *
 * Run with:
 *   bunx playwright test --config electron/e2e/playwright.config.ts theme.spec.ts
 */
import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, "../..")
const MAIN_ENTRY = path.join(ROOT, "dist/main/index.js")

function launch(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    // --user-data-dir isolates theme.json + the single-instance lock per test.
    // parseCliArgs ignores it (it skips anything starting with "-").
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      ELECTRON_NO_UPDATER: "1",
      RUNBOOKS_NO_TELEMETRY: "1",
    },
  })
}

const isDark = () =>
  document.documentElement.classList.contains("dark")

test.describe("Theme toggle", () => {
  let userDataDir: string

  test.beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-theme-e2e-"))
  })

  test.afterEach(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true })
  })

  test("toggles dark mode from the Header menu and persists across reload", async () => {
    const app = await launch(userDataDir)
    try {
      const window = await app.firstWindow()
      await window.waitForLoadState("domcontentloaded")

      // Pick Dark from the Header "Menu" dropdown.
      await window.getByRole("button", { name: "Menu" }).click()
      await window.getByRole("menuitemradio", { name: "Dark" }).click()

      await expect.poll(() => window.evaluate(isDark)).toBe(true)
      expect(await window.evaluate(() => localStorage.getItem("runbooks-theme"))).toBe("dark")

      // Reload — theme-init.js should re-apply `.dark` before React mounts.
      await window.reload()
      await window.waitForLoadState("domcontentloaded")
      await expect.poll(() => window.evaluate(isDark)).toBe(true)

      // Switch back to Light.
      await window.getByRole("button", { name: "Menu" }).click()
      await window.getByRole("menuitemradio", { name: "Light" }).click()
      await expect.poll(() => window.evaluate(isDark)).toBe(false)
      expect(await window.evaluate(() => localStorage.getItem("runbooks-theme"))).toBe("light")
    } finally {
      await app.close()
    }
  })

  test("persists the theme to the main process across a relaunch", async () => {
    // First launch: choose Dark.
    const app1 = await launch(userDataDir)
    try {
      const w1 = await app1.firstWindow()
      await w1.waitForLoadState("domcontentloaded")
      await w1.getByRole("button", { name: "Menu" }).click()
      await w1.getByRole("menuitemradio", { name: "Dark" }).click()
      await expect.poll(() => w1.evaluate(isDark)).toBe(true)
    } finally {
      await app1.close()
    }

    // The main process mirrored the choice to theme.json.
    const themeFile = path.join(userDataDir, "theme.json")
    expect(fs.existsSync(themeFile)).toBe(true)
    expect(JSON.parse(fs.readFileSync(themeFile, "utf8"))).toEqual({ theme: "dark" })

    // Second launch with the same user-data dir: the main process restores
    // nativeTheme.themeSource before creating the window.
    const app2 = await launch(userDataDir)
    try {
      await app2.firstWindow()
      const themeSource = await app2.evaluate(({ nativeTheme }) => nativeTheme.themeSource)
      expect(themeSource).toBe("dark")
    } finally {
      await app2.close()
    }
  })
})
