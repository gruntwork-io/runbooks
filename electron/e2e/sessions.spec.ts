/**
 * E2E tests for saved sessions.
 *
 * Launches the real app on a throwaway runbook and profile, quits it, and
 * launches it again: a session's directory, environment and working directory
 * come back, `runbooks` with no arguments resumes the session last launched
 * from that directory, and File > Reset Session starts over.
 *
 * Prerequisites: run `electron-vite build` first (expects ./dist/main/index.js).
 *
 * Run with:
 *   bunx playwright test --config electron/e2e/playwright.config.ts 'sessions\.spec'
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
import { MOCK_KEYCHAIN } from "./launch.ts"
import { runInMain } from "./main-process.ts"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, "../..")
const MAIN_ENTRY = path.join(ROOT, "dist/main/index.js")

const RUNBOOK = `# Session runbook

<Command id="save" path="save.sh" />

<Command id="show" path="show.sh" />
`

// What a block leaves in its session: an exported variable and a `cd`.
const SAVE_SCRIPT = `#!/bin/bash
export SAVED=from-first-run
mkdir -p work
cd work
`

const SHOW_SCRIPT = `#!/bin/bash
echo "saved=\${SAVED:-unset}"
echo "pwd=$PWD"
`

test.describe("Saved sessions", () => {
  let tmpDir: string
  let runbookDir: string
  let userDataDir: string
  /** Where each session gets its own directory. */
  let sessionDirs: string

  test.beforeEach(() => {
    // realpath: os.tmpdir() is a symlink on macOS, and a script's $PWD is not.
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-sessions-e2e-")))
    runbookDir = path.join(tmpDir, "runbook")
    // A space in the profile's path, as in macOS's "Application Support":
    // every session directory, and so every script's $PWD, has one.
    userDataDir = path.join(tmpDir, "user data")
    sessionDirs = path.join(userDataDir, "v0", "sessions", "dirs")
    fs.mkdirSync(runbookDir)
    fs.writeFileSync(path.join(runbookDir, "runbook.mdx"), RUNBOOK)
    fs.writeFileSync(path.join(runbookDir, "save.sh"), SAVE_SCRIPT)
    fs.writeFileSync(path.join(runbookDir, "show.sh"), SHOW_SCRIPT)
  })

  test.afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  /** A directory to run the app from, as a terminal's working directory. */
  function terminalDir(name: string): string {
    const dir = path.join(tmpDir, name)
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  /** Launch from `cwd` with `args` after the app's own, and wait for its window. */
  async function launch(
    cwd: string,
    args: string[] = [],
    env: Record<string, string> = {},
  ): Promise<{ app: ElectronApplication; page: Page }> {
    const app = await electron.launch({
      cwd,
      args: [MAIN_ENTRY, MOCK_KEYCHAIN, `--user-data-dir=${userDataDir}`, ...args],
      env: {
        ...(process.env as Record<string, string>),
        ELECTRON_NO_UPDATER: "1",
        RUNBOOKS_NO_TELEMETRY: "1",
        ...env,
      },
    })
    const page = await app.firstWindow()
    await page.waitForLoadState("domcontentloaded")
    return { app, page }
  }

  /** Wait for the runbook to render, and trust it if the app asks. */
  async function expectRunbook(page: Page): Promise<void> {
    await expect(page.getByRole("heading", { name: "Session runbook" })).toBeVisible({
      timeout: 60_000,
    })
    const trustButton = page.getByRole("button", { name: "I trust this Runbook" })
    if (await trustButton.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await trustButton.click()
      await expect(trustButton).not.toBeVisible({ timeout: 5_000 })
    }
  }

  async function run(page: Page, id: string) {
    const block = page.locator(`[data-testid="${id}"]`)
    await block.getByRole("button", { name: "Run" }).click()
    await expect(block.locator('[data-testid="icon-success"]')).toBeVisible({ timeout: 30_000 })
    return block
  }

  /** Run the `show` block and return the directory its script ran in. */
  async function showSession(page: Page, saved: string): Promise<string> {
    const block = await run(page, "show")
    await expect(block.getByText(`saved=${saved}`, { exact: true })).toBeVisible()
    const pwd = await block.getByText(/^pwd=/).innerText()
    return pwd.replace(/^pwd=/, "")
  }

  /** The session name the title bar shows. */
  async function sessionName(page: Page): Promise<string> {
    const name = page.getByTestId("session-name")
    await expect(name).toHaveText(/^[a-z]+-[a-z]+$/)
    return name.innerText()
  }

  test("runs scripts in a directory of the session's own, and resumes it on the next launch", async () => {
    const first = await launch(terminalDir("project"), [runbookDir])
    let sessionDir: string
    let name: string
    try {
      await expectRunbook(first.page)
      name = await sessionName(first.page)
      await expect(first.page).toHaveTitle(`${name} - Gruntwork Runbooks`)
      sessionDir = await showSession(first.page, "unset")
      expect(path.dirname(sessionDir)).toBe(sessionDirs)
      // The folder button next to the name is for copying that directory.
      await first.page.getByRole("button", { name: "Copy session directory" }).first().hover()
      await expect(first.page.getByRole("tooltip")).toContainText(sessionDir)
      // The directory is named after the session's id, a version 7 UUID.
      expect(path.basename(sessionDir)).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      )
      await run(first.page, "save")
    } finally {
      await first.app.close()
    }

    const second = await launch(terminalDir("project"), [runbookDir])
    try {
      await expectRunbook(second.page)
      expect(await sessionName(second.page)).toBe(name)
      // The export and the `cd` of the first run's block are both back.
      expect(await showSession(second.page, "from-first-run")).toBe(path.join(sessionDir, "work"))
    } finally {
      await second.app.close()
    }
    // The runbook's folder got nothing but what the test put there.
    expect(fs.readdirSync(runbookDir).sort()).toEqual(["runbook.mdx", "save.sh", "show.sh"])
  })

  test("with no arguments, resumes the session last launched from that directory", async () => {
    const project = terminalDir("project")
    const first = await launch(project, [runbookDir])
    try {
      await expectRunbook(first.page)
      await run(first.page, "save")
    } finally {
      await first.app.close()
    }

    const resumed = await launch(project)
    try {
      await expectRunbook(resumed.page)
      await showSession(resumed.page, "from-first-run")
    } finally {
      await resumed.app.close()
    }

    // No session was launched from this directory.
    const elsewhere = await launch(terminalDir("elsewhere"))
    try {
      await expect(elsewhere.page.getByText("Open a runbook to get started.")).toBeVisible({
        timeout: 60_000,
      })
    } finally {
      await elsewhere.app.close()
    }

    // The home directory is where a desktop launcher starts the app: a launch
    // from there has no directory of its own and resumes the latest session.
    const home = terminalDir("home")
    const fromDesktop = await launch(home, [], { HOME: home, USERPROFILE: home })
    try {
      await expectRunbook(fromDesktop.page)
      await showSession(fromDesktop.page, "from-first-run")
    } finally {
      await fromDesktop.app.close()
    }
  })

  test("renames the session from the title bar, and keeps the name and the directory on the next launch", async () => {
    const first = await launch(terminalDir("project"), [runbookDir])
    let sessionDir: string
    try {
      await expectRunbook(first.page)
      sessionDir = await showSession(first.page, "unset")
      const field = first.page.getByRole("textbox", { name: "Session name" })

      await first.page.getByTestId("session-name").click()
      await expect(field).toBeFocused()
      // Typed over the selected name, and lowercased as it is typed.
      await first.page.keyboard.type("Prod Deploy")
      await expect(field).toHaveValue("prod deploy")
      await first.page.keyboard.press("Enter")
      await expect(first.page.getByRole("alert")).toContainText(
        "Use lowercase letters, digits and hyphens",
      )

      await field.fill("prod-deploy")
      await first.page.keyboard.press("Enter")
      await expect(first.page.getByTestId("session-name")).toHaveText("prod-deploy")
      await expect(first.page).toHaveTitle("prod-deploy - Gruntwork Runbooks")

      // The header menu's item opens the field too, and the field gets the
      // focus the closing menu would otherwise take back.
      await first.page.getByText("Menu", { exact: true }).click()
      await first.page.getByRole("menuitem", { name: "Rename Session" }).click()
      await expect(field).toBeFocused()
      await first.page.keyboard.press("Escape")
      await expect(first.page.getByTestId("session-name")).toHaveText("prod-deploy")
    } finally {
      await first.app.close()
    }

    const second = await launch(terminalDir("project"), [runbookDir])
    try {
      await expectRunbook(second.page)
      await expect(second.page.getByTestId("session-name")).toHaveText("prod-deploy")
      // A rename changes what the session is called, not where it lives.
      expect(await showSession(second.page, "unset")).toBe(sessionDir)
    } finally {
      await second.app.close()
    }
  })

  test("File > Reset Session starts over in a new directory, and is what the next launch resumes", async () => {
    const first = await launch(terminalDir("project"), [runbookDir])
    let firstDir: string
    let secondDir: string
    let secondName: string
    try {
      await expectRunbook(first.page)
      const firstName = await sessionName(first.page)
      firstDir = await showSession(first.page, "unset")
      await run(first.page, "save")
      await showSession(first.page, "from-first-run")

      await runInMain(
        first.app,
        ({ Menu }) => {
          const item = Menu.getApplicationMenu()?.getMenuItemById("reset-session")
          if (!item) throw new Error("no Reset Session menu item")
          item.click()
        },
        undefined,
      )

      // The title bar shows the session that replaced the first one.
      await expect(first.page.getByTestId("session-name")).not.toHaveText(firstName)
      secondName = await sessionName(first.page)

      // The blocks start over: the earlier run's output is gone.
      const show = first.page.locator('[data-testid="show"]')
      await expect(show.getByText("saved=from-first-run", { exact: true })).toHaveCount(0)
      secondDir = await showSession(first.page, "unset")
      expect(path.dirname(secondDir)).toBe(sessionDirs)
      expect(secondDir).not.toBe(firstDir)
      // The session it replaced keeps its directory.
      expect(fs.existsSync(path.join(firstDir, "work"))).toBe(true)
    } finally {
      await first.app.close()
    }

    const second = await launch(terminalDir("project"), [runbookDir])
    try {
      await expectRunbook(second.page)
      expect(await sessionName(second.page)).toBe(secondName)
      expect(await showSession(second.page, "unset")).toBe(secondDir)
    } finally {
      await second.app.close()
    }
  })
})
