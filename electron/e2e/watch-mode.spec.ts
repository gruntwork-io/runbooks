/**
 * E2E tests for watch mode (`--watch`).
 *
 * Launches the real app on a throwaway runbook, edits runbook.mdx on disk,
 * and checks that the app reloads it. Running a block after the reload shows
 * which executable registry the main process used: rebuilt from the edited
 * file by default, or frozen at open with --disable-live-file-reload.
 *
 * Prerequisites: run `electron-vite build` first (expects ./dist/main/index.js).
 *
 * Run with:
 *   bunx playwright test --config electron/e2e/playwright.config.ts 'watch-mode\.spec'
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

function runbook(heading: string, message: string): string {
  return `# ${heading}\n\n<Command id="greet" command="echo ${message}" />\n`
}

test.describe("Watch mode", () => {
  let tmpDir: string
  let runbookPath: string

  test.beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-watch-e2e-"))
    const runbookDir = path.join(tmpDir, "runbook")
    fs.mkdirSync(runbookDir)
    runbookPath = path.join(runbookDir, "runbook.mdx")
    fs.writeFileSync(runbookPath, runbook("Before edit", "watch-before"))
  })

  test.afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  /** Launch with `flags` on the runbook, trust it, and wait for it to render. */
  async function launch(flags: string[]): Promise<{ app: ElectronApplication; page: Page }> {
    const app = await electron.launch({
      // --user-data-dir isolates the single-instance lock and trust state.
      args: [MAIN_ENTRY, `--user-data-dir=${path.join(tmpDir, "user-data")}`, ...flags, path.dirname(runbookPath)],
      env: {
        ...process.env,
        ELECTRON_NO_UPDATER: "1",
        RUNBOOKS_NO_TELEMETRY: "1",
      },
    })
    const page = await app.firstWindow()
    await page.waitForLoadState("domcontentloaded")
    await expect(page.getByRole("heading", { name: "Before edit" })).toBeVisible({ timeout: 60_000 })

    const trustButton = page.getByRole("button", { name: "I trust this Runbook" })
    if (await trustButton.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await trustButton.click()
      await expect(trustButton).not.toBeVisible({ timeout: 5_000 })
    }
    return { app, page }
  }

  /** Edit runbook.mdx on disk and wait for the app to show the new version. */
  async function editRunbook(page: Page): Promise<void> {
    fs.writeFileSync(runbookPath, runbook("After edit", "watch-after"))
    await expect(page.getByRole("heading", { name: "After edit" })).toBeVisible({ timeout: 15_000 })
  }

  async function runGreet(page: Page) {
    const block = page.locator('[data-testid="greet"]')
    await block.getByRole("button", { name: "Run" }).click()
    await expect(block.locator('[data-testid="icon-success"]')).toBeVisible({ timeout: 30_000 })
    return block
  }

  test("reloads the runbook and runs the edited command after runbook.mdx changes", async () => {
    const { app, page } = await launch(["--watch"])
    try {
      await editRunbook(page)

      const block = await runGreet(page)
      await expect(block.getByText("watch-after", { exact: true })).toBeVisible()
      await expect(block.getByText("Script changed")).toHaveCount(0)
    } finally {
      await app.close()
    }
  })

  test("--disable-live-file-reload reloads the view but keeps running the command approved at open", async () => {
    const { app, page } = await launch(["--watch", "--disable-live-file-reload"])
    try {
      await editRunbook(page)

      const block = await runGreet(page)
      await expect(block.getByText("watch-before", { exact: true })).toBeVisible()
      await expect(block.getByText("Script changed")).toBeVisible()
    } finally {
      await app.close()
    }
  })
})
