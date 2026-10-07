/**
 * E2E tests for the command palette (View > Command Palette…, Cmd/Ctrl+K).
 *
 * Opens a throwaway runbook with a few sections and drives the palette
 * through the real View menu item in real Chromium: the menu item toggles
 * it, Jump to section scrolls the runbook, Find in page hands focus to the
 * find bar while the palette is still closing, and a theme command applies.
 *
 * Prerequisites: run `electron-vite build` first (expects ./dist/main/index.js).
 *
 * Run with:
 *   bunx playwright test --config electron/e2e/playwright.config.ts command-palette.spec.ts
 */
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"
import { fileURLToPath } from "url"
import { runInMain } from "./main-process.ts"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, "../..")
const MAIN_ENTRY = path.join(ROOT, "dist/main/index.js")

/** Sections far enough apart that the last one starts off screen. */
const RUNBOOK = [
  "# Command palette",
  "## Prepare",
  ...Array.from({ length: 30 }, (_, i) => `Preparation step ${i + 1}.`),
  "## Deploy",
  ...Array.from({ length: 30 }, (_, i) => `Deployment step ${i + 1}.`),
  "## Verify",
  "Verify that the deployment worked.",
].join("\n\n")

test.describe("Command palette", () => {
  let tmpDir: string
  let app: ElectronApplication | undefined
  let page: Page

  test.beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-palette-e2e-"))
    const runbookDir = path.join(tmpDir, "runbook")
    fs.mkdirSync(runbookDir)
    fs.writeFileSync(path.join(runbookDir, "runbook.mdx"), RUNBOOK)
    const home = path.join(tmpDir, "home")
    fs.mkdirSync(home)
    app = await electron.launch({
      // --user-data-dir isolates the single-instance lock and trust state; a
      // throwaway HOME keeps the app away from the real one.
      args: [MAIN_ENTRY, `--user-data-dir=${path.join(tmpDir, "user-data")}`, runbookDir],
      env: {
        ...process.env,
        HOME: home,
        ELECTRON_NO_UPDATER: "1",
        RUNBOOKS_TELEMETRY_DISABLE: "1",
      },
    })
    page = await app.firstWindow()
    await page.waitForLoadState("domcontentloaded")
    await expect(page.getByRole("heading", { name: "Command palette" })).toBeVisible({
      timeout: 60_000,
    })
  })

  test.afterEach(async () => {
    await app?.close()
    app = undefined
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  /** View > Command Palette…, as Cmd/Ctrl+K would. */
  const clickPaletteMenuItem = () =>
    runInMain(
      app!,
      ({ Menu }) => {
        const item = Menu.getApplicationMenu()?.getMenuItemById("command-palette")
        if (!item) throw new Error("no Command Palette menu item")
        item.click()
      },
      undefined,
    )

  const palette = () => page.getByRole("dialog", { name: "Command Palette" })

  /** Open the palette and wait for its search box to take focus. */
  async function openPalette() {
    await clickPaletteMenuItem()
    await expect(palette()).toBeVisible()
    await expect(palette().getByRole("combobox")).toBeFocused()
  }

  /** Type `query` and run the first matching command. */
  async function run(query: string) {
    await page.keyboard.type(query)
    await page.keyboard.press("Enter")
  }

  test("the menu item opens and closes it, and Escape closes it", async () => {
    await openPalette()
    await expect(palette().getByRole("option", { name: /Jump to section/ })).toBeVisible()

    await clickPaletteMenuItem()
    await expect(palette()).toBeHidden()

    await openPalette()
    await page.keyboard.press("Escape")
    await expect(palette()).toBeHidden()
  })

  test("the Header menu's Command Palette… item opens it with focus", async () => {
    await page.getByRole("button", { name: "Menu" }).click()
    await page.getByRole("menuitem", { name: /Command Palette/ }).click()
    await expect(palette()).toBeVisible()
    await expect(palette().getByRole("combobox")).toBeFocused()
  })

  test("Jump to section scrolls the runbook to the chosen heading", async () => {
    const runbook = page.getByTestId("runbook-content")
    const verify = page.getByRole("heading", { name: "Verify" })
    expect(await runbook.evaluate((el) => el.scrollTop)).toBe(0)

    await openPalette()
    await run("jump")
    await expect(palette().getByRole("option", { name: "Verify" })).toBeVisible()
    await run("verify")

    await expect(palette()).toBeHidden()
    await expect(verify).toBeInViewport()
    await expect.poll(() => runbook.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  })

  test("Find in page opens the find bar with focus", async () => {
    await openPalette()
    await run("find")
    await expect(palette()).toBeHidden()
    await expect(page.getByRole("textbox", { name: "Find in page" })).toBeFocused()

    // Keys typed right away land in the find bar, not on the page.
    await page.keyboard.type("Verify")
    await expect(page.getByRole("search").getByRole("status")).toHaveText("1 of 2")
  })

  test("switches the theme", async () => {
    const html = page.locator("html")
    await expect(html).not.toHaveClass(/dark/)

    await openPalette()
    await run("theme dark")
    await expect(palette()).toBeHidden()
    await expect(html).toHaveClass(/dark/)
  })
})
