/**
 * E2E tests for find in page (Edit > Find…, Cmd/Ctrl+F).
 *
 * Opens a throwaway runbook with three "needle"s, one of them in inline code,
 * and drives the find bar through the real Edit menu items in real Chromium:
 * the match count, keeping focus in the input while it searches (which
 * webContents.findInPage would not), the CSS highlights, and closing.
 * The runbook's folder is also named "needle", so the runbook path in the
 * header would be a fourth match if the header weren't left out.
 * A long runbook checks what jsdom can't: that a search starts where the
 * reader is and that every match, even one far along a code line, scrolls
 * into view.
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

/** Needles above, in and below the view once scrolled to paragraph 40, then one at the end of a long code line. */
const LONG_RUNBOOK = [
  "# Long runbook",
  ...Array.from({ length: 90 }, (_, i) => `Paragraph ${i + 1}${[5, 45, 85].includes(i + 1) ? " has a needle" : ""}.`),
  "```\n" + "x".repeat(400) + " needle\n```",
].join("\n\n")

test.describe("Find in page", () => {
  let tmpDir: string
  let app: ElectronApplication | undefined
  let page: Page

  /** Launch the app on `markdown`, saved as runbook.mdx in a folder named `folder`. */
  async function launch(markdown: string, heading: string, folder = "needle"): Promise<ElectronApplication> {
    const runbookDir = path.join(tmpDir, folder)
    fs.mkdirSync(runbookDir)
    fs.writeFileSync(path.join(runbookDir, "runbook.mdx"), markdown)
    const home = path.join(tmpDir, "home")
    fs.mkdirSync(home)
    const launched = await electron.launch({
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
    app = launched
    page = await launched.firstWindow()
    await page.waitForLoadState("domcontentloaded")
    await expect(page.getByRole("heading", { name: heading })).toBeVisible({ timeout: 60_000 })
    return launched
  }

  test.beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-find-e2e-"))
  })

  test.afterEach(async () => {
    await app?.close()
    app = undefined
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  /** Click an Edit menu item by id, as its keyboard shortcut would. */
  const clickMenuItem = (id: string) =>
    app!.evaluate(({ Menu }, id) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById(id)
      if (!item) throw new Error(`no menu item ${id}`)
      item.click()
    }, id)

  const highlightSize = (name: string) =>
    page.evaluate((name) => (CSS.highlights.get(name) as Set<Range> | undefined)?.size ?? 0, name)

  /** Whether the current match is on screen: inside the window and every box that clips it. */
  const currentMatchInView = () =>
    page.evaluate(() => {
      const active = CSS.highlights.get("runbooks-find-active") as Set<Range> | undefined
      const range = active && [...active][0]
      if (!range) return false
      const rect = range.getBoundingClientRect()
      // A pixel of slack for fractional layout.
      const inside = (box: { top: number; bottom: number; left: number; right: number }) =>
        rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1 && rect.left >= box.left - 1 && rect.right <= box.right + 1
      if (!inside({ top: 0, left: 0, bottom: window.innerHeight, right: window.innerWidth })) return false
      for (let el = range.startContainer.parentElement; el; el = el.parentElement) {
        const style = getComputedStyle(el)
        if ((style.overflowX !== "visible" || style.overflowY !== "visible") && !inside(el.getBoundingClientRect())) {
          return false
        }
      }
      return true
    })

  test("finds, steps through and highlights matches without losing focus", async () => {
    await launch(RUNBOOK, "Find in page")
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

    // A button click steps too, and leaves focus in the input for typing.
    await page.getByRole("button", { name: "Next match" }).click()
    await expect(status).toHaveText("3 of 3")
    await expect(input).toBeFocused()

    await page.keyboard.press("Escape")
    await expect(page.getByRole("search")).toBeHidden()
    expect(await highlightSize("runbooks-find-match")).toBe(0)
    expect(await highlightSize("runbooks-find-active")).toBe(0)
  })

  test("reopens with the last query and reports no results", async () => {
    await launch(RUNBOOK, "Find in page")
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

    // The hidden files panel stays mounted at zero width; its placeholder
    // text isn't on screen, so it isn't a match.
    await input.fill("cloned repositories")
    await expect(page.getByRole("search").getByRole("status")).toHaveText("No results")
  })

  test("starts at the first match in view and scrolls each match into view", async () => {
    await launch(LONG_RUNBOOK, "Long runbook", "long")
    // Read from paragraph 40 on: paragraph 5's needle is above the view.
    await page.getByText("Paragraph 40.", { exact: true }).evaluate((p) => p.scrollIntoView({ block: "start" }))

    await clickMenuItem("find")
    await page.keyboard.type("needle")
    const status = page.getByRole("search").getByRole("status")
    await expect(status).toHaveText("2 of 4")
    await expect.poll(currentMatchInView).toBe(true)

    // Down to paragraph 85, across to the end of the code line, then around
    // to paragraph 5 at the top.
    for (const current of [3, 4, 1]) {
      await page.keyboard.press("Enter")
      await expect(status).toHaveText(`${current} of 4`)
      await expect.poll(currentMatchInView).toBe(true)
    }
  })

  test("stays clear of the narrow layout's Markdown/Code toggle", async () => {
    const launched = await launch(RUNBOOK, "Find in page")
    // Below the lg breakpoint, a Markdown/Code toggle floats under the header.
    await (await launched.browserWindow(page)).evaluate((win) => win.setSize(900, 800))
    const codeTab = page.getByRole("button", { name: "Code", exact: true })
    await expect(codeTab).toBeVisible()

    await clickMenuItem("find")
    // The toggle is app chrome, like the header, so its labels aren't matches.
    await page.keyboard.type("markdown")
    await expect(page.getByRole("search").getByRole("status")).toHaveText("No results")

    // The open bar doesn't cover the toggle.
    await codeTab.click({ timeout: 5_000 })
    await expect(page.getByRole("search")).toBeVisible()
  })
})
