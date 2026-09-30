/**
 * E2E tests for find in page (Edit > Find…, Cmd/Ctrl+F).
 *
 * Opens a throwaway runbook with three "needle"s, one of them in inline code,
 * and drives the find bar through the real Edit menu items in real Chromium:
 * the match count, keeping focus in the input while it searches (which
 * webContents.findInPage would not), the CSS highlights, and closing.
 * The runbook's folder is also named "needle", so the runbook path in the
 * header would be a fourth match if the header weren't left out.
 *
 * Prerequisites: run `electron-vite build` first (expects ./dist/main/index.js).
 *
 * Run with:
 *   bunx playwright test --config electron/e2e/playwright.config.ts find-in-page.spec.ts
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, "../..")
const MAIN_ENTRY = path.join(ROOT, "dist/main/index.js")

const RUNBOOK = `# Find in page

The first needle is in this paragraph.

Some filler text between the matches.

Run \`needle --version\` to check the install.

The last needle is here.
`

test.describe("Find in page", () => {
  let tmpDir: string
  let app: ElectronApplication
  let page: Page

  test.beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-find-e2e-"))
    const runbookDir = path.join(tmpDir, "needle")
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
        RUNBOOKS_NO_TELEMETRY: "1",
      },
    })
    page = await app.firstWindow()
    await page.waitForLoadState("domcontentloaded")
    await expect(page.getByRole("heading", { name: "Find in page" })).toBeVisible({ timeout: 60_000 })
  })

  test.afterEach(async () => {
    await app?.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  /** Click an Edit menu item by id, as its keyboard shortcut would. */
  const clickMenuItem = (id: string) =>
    app.evaluate(({ Menu }, id) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById(id)
      if (!item) throw new Error(`no menu item ${id}`)
      item.click()
    }, id)

  const highlightSize = (name: string) =>
    page.evaluate((name) => (CSS.highlights.get(name) as Set<Range> | undefined)?.size ?? 0, name)

  test("finds, steps through and highlights matches without losing focus", async () => {
    await clickMenuItem("find")

    const input = page.getByRole("textbox", { name: "Find in page" })
    const status = page.getByRole("search").getByRole("status")
    await expect(input).toBeFocused()

    // Typed a key at a time: every keystroke searches, and none may be lost.
    await page.keyboard.type("needle")
    await expect(input).toHaveValue("needle")
    await expect(status).toHaveText("1 of 3")
    expect(await highlightSize("runbooks-find-match")).toBe(3)
    expect(await highlightSize("runbooks-find-active")).toBe(1)

    await page.keyboard.press("Enter")
    await expect(status).toHaveText("2 of 3")
    await expect(input).toBeFocused()

    await clickMenuItem("find-next")
    await expect(status).toHaveText("3 of 3")
    await clickMenuItem("find-next")
    await expect(status).toHaveText("1 of 3")
    await clickMenuItem("find-previous")
    await expect(status).toHaveText("3 of 3")

    await page.keyboard.press("Shift+Enter")
    await expect(status).toHaveText("2 of 3")

    await page.keyboard.press("Escape")
    await expect(page.getByRole("search")).toBeHidden()
    expect(await highlightSize("runbooks-find-match")).toBe(0)
    expect(await highlightSize("runbooks-find-active")).toBe(0)
  })

  test("reopens with the last query and reports no results", async () => {
    await clickMenuItem("find")
    await page.keyboard.type("needle")
    await expect(page.getByRole("search").getByRole("status")).toHaveText("1 of 3")
    await page.keyboard.press("Escape")

    await clickMenuItem("find")
    const input = page.getByRole("textbox", { name: "Find in page" })
    await expect(input).toHaveValue("needle")
    await expect(page.getByRole("search").getByRole("status")).toHaveText("1 of 3")

    // The query is selected, so typing replaces it.
    await page.keyboard.type("haystack")
    await expect(input).toHaveValue("haystack")
    await expect(page.getByRole("search").getByRole("status")).toHaveText("No results")
  })
})
