/**
 * E2E tests for watch mode (`--watch`) and for reloading a script file that
 * changed on disk.
 *
 * Launches the real app on a throwaway runbook, edits runbook.mdx on disk,
 * and checks that the app reloads it. Running a block after the reload shows
 * which executable registry the main process used: rebuilt from the edited
 * file by default, or frozen at open with --disable-live-file-reload.
 *
 * Without --watch, editing runbook.mdx shows a "Runbook changed" notice and
 * the app keeps the loaded version until the user clicks Reload runbook, and
 * editing a block's script file leaves the registry as it is until the user
 * reloads the script from the block.
 *
 * Prerequisites: run `electron-vite build` first (expects ./dist/main/index.js).
 *
 * Run with:
 *   bunx playwright test --config electron/e2e/playwright.config.ts 'watch-mode\.spec'
 */
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page,
} from "@playwright/test"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"
import { fileURLToPath } from "url"
import { INSECURE_SESSION_KEY, MOCK_KEYCHAIN } from "./launch.ts"
import { resizeMainWindow } from "./main-process.ts"

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

  /**
   * Launch with `flags` on the runbook, trust it, and wait for it to render:
   * for `ready`, by default its "Before edit" heading.
   */
  async function launch(
    flags: string[],
    ready: (page: Page) => Locator = (page) => page.getByRole("heading", { name: "Before edit" }),
  ): Promise<{ app: ElectronApplication; page: Page }> {
    const app = await electron.launch({
      // --user-data-dir isolates the single-instance lock and trust state.
      args: [
        MAIN_ENTRY,
        MOCK_KEYCHAIN,
        `--user-data-dir=${path.join(tmpDir, "user-data")}`,
        ...flags,
        path.dirname(runbookPath),
      ],
      env: {
        ...process.env,
        // Linux has no keychain: let the session history be saved, so a
        // second launch can resume it (see launch.ts).
        ...INSECURE_SESSION_KEY,
        ELECTRON_NO_UPDATER: "1",
        RUNBOOKS_TELEMETRY_DISABLE: "1",
      },
    })
    const page = await app.firstWindow()
    await page.waitForLoadState("domcontentloaded")
    await expect(ready(page)).toBeVisible({ timeout: 60_000 })

    const trustButton = page.getByRole("button", { name: "I trust this Runbook" })
    if (await trustButton.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await trustButton.click()
      await expect(trustButton).not.toBeVisible({ timeout: 5_000 })
    }
    return { app, page }
  }

  /**
   * Edit runbook.mdx on disk and wait for the app to show the new version.
   * Write again if the first write landed before the watcher was ready.
   */
  async function editRunbook(page: Page): Promise<void> {
    await expect(async () => {
      fs.writeFileSync(runbookPath, runbook("After edit", "watch-after"))
      await expect(page.getByRole("heading", { name: "After edit" })).toBeVisible({
        timeout: 2_000,
      })
    }).toPass({ timeout: 15_000 })
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
      // Watch mode reloads on its own: nothing to offer.
      await expect(page.getByText("Runbook changed")).toHaveCount(0)
    } finally {
      await app.close()
    }
  })

  test("saving runbook.mdx unchanged after a script edit shows and runs the edited script", async () => {
    // A path-based block: the runbook's own text never changes, so the MDX
    // isn't recompiled and the block stays mounted across the reload.
    const scriptPath = path.join(path.dirname(runbookPath), "greet.sh")
    const content = `# Before edit\n\n<Command id="greet" path="greet.sh" />\n`
    fs.writeFileSync(scriptPath, "#!/bin/bash\necho script-before\n")
    fs.writeFileSync(runbookPath, content)
    const { app, page } = await launch(["--watch"])
    try {
      const block = page.locator('[data-testid="greet"]')
      // The metadata row's "View Source Code" opens the collapsed source.
      await block.getByRole("button", { name: "View Source Code" }).first().click()
      await expect(block.getByText("script-before")).toBeVisible()

      fs.writeFileSync(scriptPath, "#!/bin/bash\necho script-after\n")
      // Save runbook.mdx with the same bytes; save again if the first save
      // landed before the watcher was ready.
      // The edit first shows in the block's "Script changed" notice; once the
      // reload has rebuilt the registry, the notice goes and the source shows it.
      await expect(async () => {
        fs.writeFileSync(runbookPath, content)
        await expect(block.getByText("script-after").first()).toBeVisible({ timeout: 2_000 })
        await expect(block.getByText("Script changed")).toHaveCount(0, { timeout: 2_000 })
      }).toPass({ timeout: 15_000 })

      await runGreet(page)
      // The run's log output, not the source view
      await expect(block.locator(".terminal-text", { hasText: /^script-after$/ })).toBeVisible()
      await expect(page.getByText("Runbook changed")).toHaveCount(0)
    } finally {
      await app.close()
    }
  })

  for (const flags of [[], ["--watch", "--disable-live-file-reload"]]) {
    test(`a script edited on disk runs as loaded until it is reloaded from its block (flags: ${flags.join(" ") || "none"})`, async () => {
      const scriptPath = path.join(path.dirname(runbookPath), "greet.sh")
      fs.writeFileSync(scriptPath, "#!/bin/bash\necho script-before\n")
      fs.writeFileSync(runbookPath, `# Before edit\n\n<Command id="greet" path="greet.sh" />\n`)
      const { app, page } = await launch(flags)
      try {
        const block = page.locator('[data-testid="greet"]')
        const output = (line: RegExp) => block.locator(".terminal-text", { hasText: line })

        // Edit again if the first edit landed before the script watcher was ready.
        await expect(async () => {
          fs.writeFileSync(scriptPath, "#!/bin/bash\necho script-after\n")
          await expect(block.getByText("Script changed")).toBeVisible({ timeout: 2_000 })
        }).toPass({ timeout: 15_000 })
        const diff = block.getByTestId("script-change-diff")
        await expect(diff).toContainText("-echo script-before")
        await expect(diff).toContainText("+echo script-after")

        await runGreet(page)
        await expect(output(/^script-before$/)).toBeVisible()

        await block.getByRole("button", { name: "Reload script" }).click()
        await expect(block.getByText("Script changed")).toHaveCount(0)

        await block.getByRole("button", { name: "Run" }).click()
        await expect(output(/^script-after$/)).toBeVisible({ timeout: 30_000 })
      } finally {
        await app.close()
      }
    })
  }

  /**
   * Without --watch: edit runbook.mdx on disk and wait for the app to offer
   * the reload. Write again if the first write landed before the watcher was
   * ready.
   */
  async function editRunbookUntilOffered(page: Page): Promise<void> {
    await expect(async () => {
      fs.writeFileSync(runbookPath, runbook("After edit", "watch-after"))
      await expect(page.getByText("Runbook changed")).toBeVisible({ timeout: 2_000 })
    }).toPass({ timeout: 15_000 })
  }

  /** The session name the title bar shows. */
  async function sessionName(page: Page): Promise<string> {
    const name = page.getByTestId("session-name")
    await expect(name).toHaveText(/^[a-z]+-[a-z]+$/)
    return name.innerText()
  }

  test("without --watch, a saved runbook.mdx offers a reload and runs the loaded version until it is reloaded", async () => {
    const { app, page } = await launch([])
    try {
      const session = await sessionName(page)
      await editRunbookUntilOffered(page)
      await expect(page.getByRole("heading", { name: "Before edit" })).toBeVisible()

      const block = await runGreet(page)
      await expect(block.getByText("watch-before", { exact: true })).toBeVisible()

      await page.getByRole("button", { name: "Reload runbook" }).click()
      await expect(page.getByRole("heading", { name: "After edit" })).toBeVisible()
      await expect(page.getByText("Runbook changed")).toHaveCount(0)
      expect(await sessionName(page)).toBe(session)

      await block.getByRole("button", { name: "Run" }).click()
      await expect(block.getByText("watch-after", { exact: true })).toBeVisible({ timeout: 30_000 })
      await expect(block.getByText("Script changed")).toHaveCount(0)
    } finally {
      await app.close()
    }
  })

  test("without --watch, the notice shows with the session notice and scrolls away with it", async () => {
    // A first run, so the second launch resumes its session.
    const first = await launch([])
    try {
      await runGreet(first.page)
    } finally {
      await first.app.close()
    }
    const { app, page } = await launch([])
    try {
      const sessionNotice = page.getByRole("status").filter({ hasText: "Resumed session" })
      await expect(sessionNotice).toBeVisible()
      await editRunbookUntilOffered(page)

      const notice = page.getByRole("status").filter({ hasText: "Runbook changed" })
      await expect(sessionNotice).toBeVisible()
      // Above the session notice, in the runbook's own scroll area.
      const noticeBox = (await notice.boundingBox())!
      expect((await sessionNotice.boundingBox())!.y).toBeGreaterThan(noticeBox.y)
      const scroller = page.getByTestId("runbook-content")
      await resizeMainWindow(app, 1280, 400)
      await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }))
      await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
      expect((await notice.boundingBox())!.y).toBeLessThan(noticeBox.y)
    } finally {
      await app.close()
    }
  })

  /** A runbook in two chapters, the first long enough to scroll well past the window. */
  function chapterRunbook(lastLine: string): string {
    const steps = Array.from(
      { length: 60 },
      (_, i) => `Step ${i + 1}: a paragraph long enough to take up a line or two of the runbook.`,
    ).join("\n\n")
    return `# Before edit\n\n<Chapter title="First">\n\n${steps}\n\n${lastLine}\n\n</Chapter>\n\n<Chapter title="Second">\n\nThe second chapter.\n\n</Chapter>\n`
  }

  test("without --watch, a runbook with chapters shows the notice at the top of each chapter until dismissed", async () => {
    fs.writeFileSync(runbookPath, chapterRunbook("The last line."))
    const { app, page } = await launch([])
    try {
      await resizeMainWindow(app, 1280, 800)
      const chapterBar = page.getByRole("navigation", { name: "Chapters" })
      const first = page.getByRole("region", { name: "First" })
      const second = page.getByRole("region", { name: "Second" })
      const changed = page.getByRole("status").filter({ hasText: "Runbook changed" })
      await expect(chapterBar).toBeVisible()

      await expect(async () => {
        fs.writeFileSync(runbookPath, chapterRunbook("The last line, edited."))
        await expect(changed).toBeVisible({ timeout: 2_000 })
      }).toPass({ timeout: 15_000 })

      // Once, at the top of the chapter on screen, below its bar and above its content.
      await expect(changed).toHaveCount(1)
      await expect(first.getByRole("status").filter({ hasText: "Runbook changed" })).toBeVisible()
      const noticeBox = (await changed.boundingBox())!
      expect(noticeBox.y).toBeGreaterThan((await chapterBar.boundingBox())!.y)
      expect((await page.getByText("Step 1:").boundingBox())!.y).toBeGreaterThan(noticeBox.y)

      // Next at the end of the chapter lands on the top of the next one, with the notice.
      const scroller = page.getByTestId("runbook-content")
      await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }))
      await page
        .getByRole("navigation", { name: "Chapter pages" })
        .getByRole("button", { name: /Next/ })
        .click()
      const secondNotice = second.getByRole("status").filter({ hasText: "Runbook changed" })
      await expect(secondNotice).toBeInViewport()
      await expect(changed).toHaveCount(1)
      expect((await page.getByText("The second chapter.").boundingBox())!.y).toBeGreaterThan(
        (await secondNotice.boundingBox())!.y,
      )

      // Dismissed on one chapter, it is gone from every chapter.
      await secondNotice.getByRole("button", { name: "Dismiss" }).click()
      await expect(changed).toHaveCount(0)
      await chapterBar.getByRole("button", { name: "Previous chapter: First" }).click()
      await expect(page.getByText("Step 1:")).toBeVisible()
      await expect(changed).toHaveCount(0)
    } finally {
      await app.close()
    }
  })

  test("without --watch, a runbook that fails to compile offers a reload once a save fixes it", async () => {
    fs.writeFileSync(runbookPath, "# Broken\n\n<Command\n")
    const { app, page } = await launch([], (p) => p.getByTestId("mdx-error"))
    try {
      await editRunbookUntilOffered(page)
      await expect(page.getByTestId("mdx-error")).toBeVisible()
      // The notice sits above the compile error, not hidden below it.
      const noticeBox = (await page
        .getByRole("status")
        .filter({ hasText: "Runbook changed" })
        .boundingBox())!
      expect((await page.getByTestId("mdx-error").boundingBox())!.y).toBeGreaterThan(noticeBox.y)

      await page.getByRole("button", { name: "Reload runbook" }).click()
      await expect(page.getByRole("heading", { name: "After edit" })).toBeVisible()
      await expect(page.getByTestId("mdx-error")).toHaveCount(0)
      await expect(page.getByText("Runbook changed")).toHaveCount(0)
    } finally {
      await app.close()
    }
  })

  test("without --watch, --disable-live-file-reload reloads the view but keeps running the command approved at open", async () => {
    const { app, page } = await launch(["--disable-live-file-reload"])
    try {
      await editRunbookUntilOffered(page)
      await expect(page.getByText("--disable-live-file-reload")).toBeVisible()

      await page.getByRole("button", { name: "Reload runbook" }).click()
      await expect(page.getByRole("heading", { name: "After edit" })).toBeVisible()
      await expect(page.getByText("Runbook changed")).toHaveCount(0)

      const block = await runGreet(page)
      await expect(block.getByText("watch-before", { exact: true })).toBeVisible()
      await expect(block.getByText("Script changed")).toBeVisible()
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
