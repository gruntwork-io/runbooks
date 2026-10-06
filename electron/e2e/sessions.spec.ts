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
import { execFileSync } from "child_process"
import { fileURLToPath } from "url"
import { INSECURE_SESSION_KEY, MOCK_KEYCHAIN } from "./launch.ts"
import { runInMain } from "./main-process.ts"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, "../..")
const MAIN_ENTRY = path.join(ROOT, "dist/main/index.js")

const RUNBOOK = `# Session runbook

<Command id="save" path="save.sh" />

<Command id="show" path="show.sh" />

<Command id="wait" path="wait.sh" />
`

// A script still running when the user switches sessions.
const WAIT_SCRIPT = `#!/bin/bash
echo waiting
sleep 60
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

// A form, a script that reads it and publishes an output, and a script that
// reads that output.
const HISTORY_RUNBOOK = `# History runbook

<Inputs id="config">
\`\`\`yaml
variables:
  - name: Greeting
    type: string
    description: What the script says
    default: hello
\`\`\`
</Inputs>

<Command id="greet" path="greet.sh" inputsId="config" />

<Command id="reply" path="reply.sh" />
`

const GREET_SCRIPT = `#!/bin/bash
echo "{{ .inputs.Greeting }} from greet"
echo "greeting={{ .inputs.Greeting }}" >> "$RUNBOOK_OUTPUT"
`

const REPLY_SCRIPT = `#!/bin/bash
echo "reply to {{ .outputs.greet.greeting }}"
`

test.describe("Saved sessions", () => {
  let tmpDir: string
  let runbookDir: string
  let userDataDir: string
  /** Where each session gets its own directory. */
  let sessionDirs: string
  /** Stands in for the OS trash (RUNBOOKS_TEST_TRASH_DIR). */
  let trashDir: string

  test.beforeEach(() => {
    // realpath: os.tmpdir() is a symlink on macOS, and a script's $PWD is not.
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-sessions-e2e-")))
    runbookDir = path.join(tmpDir, "runbook")
    // A space in the profile's path, as in macOS's "Application Support":
    // every session directory, and so every script's $PWD, has one.
    userDataDir = path.join(tmpDir, "user data")
    sessionDirs = path.join(userDataDir, "v0", "sessions", "dirs")
    trashDir = path.join(tmpDir, "trash")
    fs.mkdirSync(runbookDir)
    fs.mkdirSync(trashDir)
    fs.writeFileSync(path.join(runbookDir, "runbook.mdx"), RUNBOOK)
    fs.writeFileSync(path.join(runbookDir, "save.sh"), SAVE_SCRIPT)
    fs.writeFileSync(path.join(runbookDir, "show.sh"), SHOW_SCRIPT)
    fs.writeFileSync(path.join(runbookDir, "wait.sh"), WAIT_SCRIPT)
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
        RUNBOOKS_TEST_TRASH_DIR: trashDir,
        ...INSECURE_SESSION_KEY,
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
      await expect(first.page.getByText(/^Resumed session/)).toHaveCount(0)
      sessionDir = await showSession(first.page, "unset")
      expect(path.dirname(sessionDir)).toBe(sessionDirs)
      // The folder button next to the name copies that directory.
      await first.page.getByRole("button", { name: "Copy session directory" }).click()
      await expect(first.page.getByRole("tooltip")).toHaveText("Session directory copied")
      expect(await first.app.evaluate(({ clipboard }) => clipboard.readText())).toBe(sessionDir)
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
      await expect(second.page.getByText(`Resumed session ${name}`)).toBeVisible()
      await second.page.getByRole("button", { name: "Dismiss" }).click()
      // The export and the `cd` of the first run's block are both back.
      expect(await showSession(second.page, "from-first-run")).toBe(path.join(sessionDir, "work"))
    } finally {
      await second.app.close()
    }
    // The runbook's folder got nothing but what the test put there.
    expect(fs.readdirSync(runbookDir).sort()).toEqual([
      "runbook.mdx",
      "save.sh",
      "show.sh",
      "wait.sh",
    ])
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

  test("shows the blocks as they were left on the next launch, and starts them over after a reset", async () => {
    const historyDir = path.join(tmpDir, "history-runbook")
    fs.mkdirSync(historyDir)
    fs.writeFileSync(path.join(historyDir, "runbook.mdx"), HISTORY_RUNBOOK)
    fs.writeFileSync(path.join(historyDir, "greet.sh"), GREET_SCRIPT)
    fs.writeFileSync(path.join(historyDir, "reply.sh"), REPLY_SCRIPT)

    const expectHistoryRunbook = async (page: Page) => {
      await expect(page.getByRole("heading", { name: "History runbook" })).toBeVisible({
        timeout: 60_000,
      })
      const trustButton = page.getByRole("button", { name: "I trust this Runbook" })
      if (await trustButton.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await trustButton.click()
        await expect(trustButton).not.toBeVisible({ timeout: 5_000 })
      }
    }
    const greetingField = (page: Page) =>
      page.locator('[data-testid="config"] [data-testid="field-Greeting"] input')

    const first = await launch(terminalDir("project"), [historyDir])
    try {
      await expectHistoryRunbook(first.page)
      const reply = first.page.locator('[data-testid="reply"]')
      // Nothing has published the output the second script reads.
      await expect(reply.getByRole("button", { name: "Run" })).toBeDisabled()

      await greetingField(first.page).fill("bonjour")
      await first.page
        .locator('[data-testid="config"]')
        .getByRole("button", { name: "Submit" })
        .click()
      const greet = await run(first.page, "greet")
      await expect(greet.getByText("bonjour from greet", { exact: true })).toBeVisible()
    } finally {
      await first.app.close()
    }

    const second = await launch(terminalDir("project"), [historyDir])
    try {
      await expectHistoryRunbook(second.page)
      // The form has what was typed, and is still submitted.
      await expect(greetingField(second.page)).toHaveValue("bonjour")
      await expect(
        second.page.locator('[data-testid="config"]').getByRole("button", { name: "Submit" }),
      ).toHaveCount(0)

      // The script shows as run, with its log and its output.
      const greet = second.page.locator('[data-testid="greet"]')
      await expect(greet.locator('[data-testid="icon-success"]')).toBeVisible()
      await greet.getByRole("button", { name: "View Logs" }).click()
      await expect(greet.getByText("bonjour from greet", { exact: true })).toBeVisible()
      await expect(greet.getByText("greeting", { exact: true })).toBeVisible()

      // The script that reads the output runs without the first running again.
      const reply = await run(second.page, "reply")
      await expect(reply.getByText("reply to bonjour", { exact: true })).toBeVisible()

      await runInMain(
        second.app,
        ({ Menu }) => {
          const item = Menu.getApplicationMenu()?.getMenuItemById("reset-session")
          if (!item) throw new Error("no Reset Session menu item")
          item.click()
        },
        undefined,
      )

      // A reset session has no history: the form and the scripts start over.
      await expect(greetingField(second.page)).toHaveValue("hello")
      await expect(greet.locator('[data-testid="icon-success"]')).toHaveCount(0)
      await expect(
        second.page.locator('[data-testid="reply"]').getByRole("button", { name: "Run" }),
      ).toBeDisabled()
    } finally {
      await second.app.close()
    }
  })

  test("keeps a selected repository on the next launch, and starts the block over once it is gone", async () => {
    // A local checkout outside the session, with one commit
    const repo = path.join(tmpDir, "checkout")
    fs.mkdirSync(repo)
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: repo,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.com",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.com",
        },
      })
    git("init", "-q", "-b", "main")
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n")
    git("add", "README.md")
    git("commit", "-q", "-m", "first")

    const cloneDir = path.join(tmpDir, "clone-runbook")
    fs.mkdirSync(cloneDir)
    fs.writeFileSync(
      path.join(cloneDir, "runbook.mdx"),
      `# Clone runbook

<GitClone id="repo" source="local" hideSourceSelect prefilledRepoDir="${repo}" />

<Command id="where" command="echo repo={{ .outputs.repo.clone_path }}" />
`,
    )
    const expectCloneRunbook = async (page: Page) => {
      await expect(page.getByRole("heading", { name: "Clone runbook" })).toBeVisible({
        timeout: 60_000,
      })
      const trustButton = page.getByRole("button", { name: "I trust this Runbook" })
      if (await trustButton.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await trustButton.click()
        await expect(trustButton).not.toBeVisible({ timeout: 5_000 })
      }
    }

    const first = await launch(terminalDir("project"), [cloneDir])
    try {
      await expectCloneRunbook(first.page)
      const block = first.page.locator('[data-testid="repo"]')
      const use = block.getByRole("button", { name: "Use This Repo" })
      await expect(use).toBeEnabled({ timeout: 30_000 })
      await use.click()
      await expect(block.getByRole("button", { name: "Stop using this repo" })).toBeVisible({
        timeout: 30_000,
      })
    } finally {
      await first.app.close()
    }

    const second = await launch(terminalDir("project"), [cloneDir])
    try {
      await expectCloneRunbook(second.page)
      // The checkout is still in use, and its outputs are there for the next block.
      const block = second.page.locator('[data-testid="repo"]')
      await expect(block.getByRole("button", { name: "Stop using this repo" })).toBeVisible()
      const where = await run(second.page, "where")
      await expect(where.getByText(`repo=${fs.realpathSync(repo)}`, { exact: true })).toBeVisible()
    } finally {
      await second.app.close()
    }

    fs.rmSync(repo, { recursive: true, force: true })
    const third = await launch(terminalDir("project"), [cloneDir])
    try {
      await expectCloneRunbook(third.page)
      const block = third.page.locator('[data-testid="repo"]')
      await expect(block.getByText("This block's repository is gone")).toBeVisible({
        timeout: 30_000,
      })
      await expect(block.getByRole("button", { name: "Stop using this repo" })).toHaveCount(0)
      // Its outputs went with it.
      await expect(
        third.page.locator('[data-testid="where"]').getByRole("button", { name: "Run" }),
      ).toBeDisabled()
    } finally {
      await third.app.close()
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

  test("switches between saved sessions from the header menu, and deletes one", async () => {
    const { app, page } = await launch(terminalDir("project"), [runbookDir])
    try {
      await expectRunbook(page)
      const firstName = await sessionName(page)
      const firstDir = await showSession(page, "unset")
      await run(page, "save")

      await runInMain(
        app,
        ({ Menu }) => {
          Menu.getApplicationMenu()?.getMenuItemById("reset-session")?.click()
        },
        undefined,
      )
      await expect(page.getByTestId("session-name")).not.toHaveText(firstName)
      const secondName = await sessionName(page)
      const secondDir = await showSession(page, "unset")

      /** Open the Sessions dialog from the header's menu. */
      const openSessions = async () => {
        await page.getByRole("button", { name: "Menu" }).click()
        await page.getByRole("menuitem", { name: "Switch Session…" }).click()
        const dialog = page.getByRole("dialog", { name: "Sessions" })
        await expect(dialog).toBeVisible()
        return dialog
      }
      const sessionButton = (dialog: ReturnType<Page["getByRole"]>, name: string) =>
        dialog.getByRole("button", { name: new RegExp(`^${name}`) })

      // Back to the first session: its env and its directory come back.
      let dialog = await openSessions()
      await expect(sessionButton(dialog, secondName)).toBeDisabled()
      await sessionButton(dialog, firstName).click()
      await expect(page.getByTestId("session-name")).toHaveText(firstName)
      expect(await showSession(page, "from-first-run")).toBe(path.join(firstDir, "work"))

      // A running script makes the switch ask first.
      const wait = page.locator('[data-testid="wait"]')
      await wait.getByRole("button", { name: "Run" }).click()
      await expect(wait.getByText("waiting", { exact: true })).toBeVisible({ timeout: 30_000 })
      dialog = await openSessions()
      await sessionButton(dialog, secondName).click()
      const confirm = page.getByRole("alertdialog")
      await expect(confirm).toContainText("Stop the running script?")
      await confirm.getByRole("button", { name: "Stop and switch" }).click()
      await expect(page.getByTestId("session-name")).toHaveText(secondName)
      expect(await showSession(page, "unset")).toBe(secondDir)

      // Delete the first session: it leaves the list, and its directory goes to the trash.
      dialog = await openSessions()
      await dialog.getByRole("button", { name: `Delete ${firstName}` }).click()
      await dialog.getByRole("button", { name: "Delete", exact: true }).click()
      await expect(sessionButton(dialog, firstName)).toHaveCount(0)
      expect(fs.existsSync(firstDir)).toBe(false)
      expect(fs.readdirSync(trashDir)).toEqual([path.basename(firstDir)])
      expect(fs.existsSync(secondDir)).toBe(true)
    } finally {
      await app.close()
    }
  })
})
