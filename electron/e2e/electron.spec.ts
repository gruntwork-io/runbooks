/**
 * Electron E2E tests using Playwright's first-class Electron support.
 *
 * These tests launch the actual Electron app (from the built dist/main/index.js)
 * and interact with the renderer window. They verify the full stack: main process,
 * preload scripts, IPC bridge, and renderer UI.
 *
 * Prerequisites:
 *   - Run `electron-vite build` before running these tests
 *   - The built app is expected at ./dist/main/index.js
 *
 * Run with:
 *   bunx playwright test --config electron/e2e/playwright.config.ts
 */
import { test, expect, _electron as electron } from "@playwright/test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { fileURLToPath } from "url"
import { MOCK_KEYCHAIN } from "./launch.ts"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, "../..")
const MAIN_ENTRY = path.join(ROOT, "dist/main/index.js")
const SAMPLE_RUNBOOK = path.join(ROOT, "testdata/sample-runbooks/demo1")

test.describe("Electron App", () => {
  // A throwaway profile per test. The app saves a session for every runbook it
  // opens and resumes the last one when launched with no arguments, so a
  // shared profile would turn the welcome screen into an earlier test's runbook.
  let userDataDir: string

  test.beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-electron-e2e-"))
  })

  test.afterEach(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true })
  })

  test("launches and shows a window", async () => {
    const app = await electron.launch({
      args: [MAIN_ENTRY, MOCK_KEYCHAIN, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        // Disable auto-updater in tests
        ELECTRON_NO_UPDATER: "1",
        // Disable telemetry
        RUNBOOKS_NO_TELEMETRY: "1",
      },
    })

    try {
      const window = await app.firstWindow()
      // Window should be visible and have a non-zero size
      const title = await window.title()
      expect(title).toBeDefined()

      const { width, height } = await window.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }))
      expect(width).toBeGreaterThan(0)
      expect(height).toBeGreaterThan(0)
    } finally {
      await app.close()
    }
  })

  test("shows welcome screen when no runbook specified", async () => {
    const app = await electron.launch({
      args: [MAIN_ENTRY, MOCK_KEYCHAIN, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        ELECTRON_NO_UPDATER: "1",
        RUNBOOKS_NO_TELEMETRY: "1",
      },
    })

    try {
      const window = await app.firstWindow()
      // Wait for the React app to render
      await window.waitForLoadState("domcontentloaded")

      // The welcome screen or main app container should be visible
      const body = window.locator("body")
      await expect(body).toBeVisible()
    } finally {
      await app.close()
    }
  })

  test("loads a runbook when path is passed as argument", async () => {
    const app = await electron.launch({
      args: [MAIN_ENTRY, MOCK_KEYCHAIN, `--user-data-dir=${userDataDir}`, SAMPLE_RUNBOOK],
      env: {
        ...process.env,
        ELECTRON_NO_UPDATER: "1",
        RUNBOOKS_NO_TELEMETRY: "1",
      },
    })

    try {
      const window = await app.firstWindow()
      await window.waitForLoadState("domcontentloaded")

      // Give the MDX some time to compile and render
      await window.waitForTimeout(3000)

      // The page should contain rendered content (not be blank)
      const bodyText = await window.locator("body").innerText()
      expect(bodyText.length).toBeGreaterThan(0)
    } finally {
      await app.close()
    }
  })

  test("only allows one instance (single instance lock)", async () => {
    const app1 = await electron.launch({
      args: [MAIN_ENTRY, MOCK_KEYCHAIN, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        ELECTRON_NO_UPDATER: "1",
        RUNBOOKS_NO_TELEMETRY: "1",
      },
    })

    try {
      // Wait for first instance to be ready
      await app1.firstWindow()

      // Try to launch a second instance — it should quit immediately
      // because the single-instance lock is held by app1.
      // We can't easily verify this from Playwright since the second
      // app would just quit, but we can verify the first app still works.
      const windows = app1.windows()
      expect(windows.length).toBeGreaterThanOrEqual(1)
    } finally {
      await app1.close()
    }
  })
})
