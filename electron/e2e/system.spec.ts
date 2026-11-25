/**
 * E2E tests for how the app fits into the user's system: installing the
 * `runbooks` command, the native application menu, the updater, and the
 * environment that scripts start from. The custom CA setting and the theme
 * have their own specs.
 *
 * These launch an unpackaged build, which limits what can be driven:
 *
 * - Installing the command writes /usr/local/bin/runbooks, a location the app
 *   has no setting for, and an unpackaged build refuses to install it at all.
 *   The tests pin that refusal and every way of asking for the install.
 * - Uninstalling acts on the real /usr/local/bin/runbooks in an unpackaged
 *   build too, so no test asks for it.
 * - The updater only runs in a packaged build, whose feed is the GitHub
 *   release. The test pins that an unpackaged launch never asks that feed.
 *
 * No network beyond loopback, no credentials, and a sandboxed HOME.
 *
 * Prerequisites: run `electron-vite build` first (expects ./dist/main/index.js).
 *
 * Run with:
 *   bunx playwright test --config electron/e2e/playwright.config.ts system.spec.ts
 */
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test"
import * as fs from "node:fs"
import * as net from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { MOCK_KEYCHAIN } from "./launch.ts"
import { readFromMain, runInMain } from "./main-process.ts"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const MAIN_ENTRY = path.join(ROOT, "dist/main/index.js")

/** Where the docs say the command is installed on macOS and Linux. */
const UNIX_LAUNCHER_PATH = "/usr/local/bin/runbooks"
const INSTALL_CLI = "Install 'runbooks' command in PATH"

const ISSUES_URL = "https://github.com/gruntwork-io/runbooks/issues"
/** What electron-updater's GitHub provider fetches first. */
const RELEASE_FEED_URL = "https://github.com/gruntwork-io/runbooks/releases.atom"
/**
 * How long to watch for an update check: a packaged build makes its first one
 * 10 seconds after the window opens.
 */
const UPDATE_CHECK_WINDOW_MS = 15_000

/** Variables a terminal sets, which tell the app it was started from one. */
const TERMINAL_VARS = new Set(["TERM", "TERM_PROGRAM", "ITERM_SESSION_ID"])

const PROFILE_GREETING = "E2E_PROFILE_GREETING"

let tmpDir: string
let home: string
let userDataDir: string
/** The app a test launched, which afterEach quits. */
let running: ElectronApplication | undefined

test.beforeEach(() => {
  // realpath: macOS tmpdir is a /var symlink.
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-system-e2e-")))
  home = path.join(tmpDir, "home")
  userDataDir = path.join(tmpDir, "user-data")
  fs.mkdirSync(home)
  fs.mkdirSync(userDataDir)
})

test.afterEach(async () => {
  await running?.close()
  running = undefined
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** This process's env without the variables in `drop`. */
function envWithout(drop: ReadonlySet<string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !drop.has(entry[0]),
    ),
  )
}

/** The env of a launch from a terminal, whose env the app already has. */
function terminalEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...envWithout(new Set([PROFILE_GREETING])),
    HOME: home,
    TERM: "xterm-256color",
    TERM_PROGRAM: "runbooks-e2e",
    ...extra,
  }
}

/**
 * The env of a launch from Finder, the Dock or a desktop entry: no terminal
 * variables, and bash as the login shell, whose profile is in the sandboxed
 * HOME.
 */
function desktopEnv(): Record<string, string> {
  return {
    ...envWithout(new Set([...TERMINAL_VARS, PROFILE_GREETING])),
    HOME: home,
    SHELL: "/bin/bash",
  }
}

async function launch(
  args: string[],
  env: Record<string, string>,
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    cwd: tmpDir,
    args: [MAIN_ENTRY, MOCK_KEYCHAIN, `--user-data-dir=${userDataDir}`, ...args],
    env,
  })
  running = app
  const page = await app.firstWindow()
  await page.waitForLoadState("domcontentloaded")
  return { app, page }
}

/** Write a runbook with `content` as its runbook.mdx, plus `files`, and return its directory. */
function writeRunbook(name: string, content: string, files: Record<string, string> = {}): string {
  const dir = path.join(tmpDir, name)
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, "runbook.mdx"), content)
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), text)
  return dir
}

async function expectRunbook(page: Page, heading: string): Promise<void> {
  await expect(page.getByRole("heading", { name: heading })).toBeVisible({ timeout: 60_000 })
}

/**
 * Click the native menu item at `labels`, a top-level menu and then an item in
 * it, as a click in the menu bar does: with the app's window focused.
 */
function clickMenuItem(app: ElectronApplication, labels: readonly string[]): Promise<void> {
  return runInMain(
    app,
    ({ BrowserWindow, Menu }, itemPath) => {
      let items = Menu.getApplicationMenu()?.items ?? []
      let item: Electron.MenuItem | undefined
      for (const label of itemPath) {
        item = items.find((candidate) => candidate.label === label)
        if (!item) throw new Error(`no menu item ${itemPath.join(" > ")}`)
        items = item.submenu?.items ?? []
      }
      const [win] = BrowserWindow.getAllWindows()
      if (!item || !win) throw new Error(`no window to click ${itemPath.join(" > ")} in`)
      item.click(undefined, win, win.webContents)
    },
    labels,
  )
}

/** The menu the docs put the command's items in: the app menu on macOS, Help elsewhere. */
async function cliMenu(app: ElectronApplication): Promise<string> {
  if (process.platform !== "darwin") return "Help"
  return readFromMain(app, ({ app: electronApp }) => electronApp.name, undefined)
}

interface ShownDialog {
  /** "error" for an error box, otherwise the message box's type. */
  kind: string
  text: string
}

/** Replace main's native dialogs, which a test can't click, with a record of what they showed. */
async function recordDialogs(app: ElectronApplication): Promise<void> {
  await runInMain(
    app,
    ({ dialog }) => {
      const shown: ShownDialog[] = []
      Object.assign(globalThis, { shownDialogs: shown })
      dialog.showErrorBox = (title, content) =>
        void shown.push({ kind: "error", text: `${title}\n${content}` })
      dialog.showMessageBox = (async (
        ...args: [Electron.MessageBoxOptions] | [Electron.BaseWindow, Electron.MessageBoxOptions]
      ) => {
        const options = args.length === 1 ? args[0] : args[1]
        shown.push({
          kind: options.type ?? "none",
          text: [options.title, options.message, options.detail].join("\n"),
        })
        return { response: 0, checkboxChecked: false }
      }) as never
    },
    undefined,
  )
}

function shownDialogs(app: ElectronApplication): Promise<ShownDialog[]> {
  return readFromMain(
    app,
    // recordDialogs put `shownDialogs` on main's globalThis, whose type doesn't have it.
    () => (globalThis as unknown as { shownDialogs: ShownDialog[] }).shownDialogs,
    undefined,
  )
}

/** What is at the launcher path, read without following a link. Null when nothing is. */
function launcherSnapshot(): { ino: number; size: number; mtimeMs: number } | null {
  try {
    const { ino, size, mtimeMs } = fs.lstatSync(UNIX_LAUNCHER_PATH)
    return { ino, size, mtimeMs }
  } catch {
    return null
  }
}

test.describe("the runbooks command", () => {
  test("every way to install it explains that a development build can't, and nothing is written", async () => {
    const before = launcherSnapshot()
    const { app, page } = await launch([], terminalEnv())
    await recordDialogs(app)

    // The welcome screen's button reports the reason in the window, and keeps offering the install.
    await expect(page.getByText("Open a runbook to get started.")).toBeVisible({ timeout: 60_000 })
    const install = page.getByRole("button", { name: /Install command line tool/ })
    await expect(install).toBeEnabled()
    await install.click()
    await expect(page.getByRole("alert")).toContainText("development build")
    await expect(install).toBeEnabled()

    // The menu item and the command palette's command report it in a native error dialog.
    await clickMenuItem(app, [await cliMenu(app), INSTALL_CLI])
    await expect
      .poll(() => shownDialogs(app))
      .toEqual([{ kind: "error", text: expect.stringContaining("development build") }])

    await clickMenuItem(app, ["View", "Command Palette…"])
    const palette = page.getByRole("dialog", { name: "Command Palette" })
    await palette.getByRole("option", { name: INSTALL_CLI }).click()
    await expect.poll(async () => (await shownDialogs(app)).length).toBe(2)
    expect((await shownDialogs(app))[1]).toEqual({
      kind: "error",
      text: expect.stringContaining("development build"),
    })

    expect(launcherSnapshot()).toEqual(before)
  })
})

test.describe("the application menu", () => {
  test("File > Open Runbook… opens the chosen runbook, View > Reload keeps it, and File > Close Runbook closes it", async () => {
    const first = writeRunbook("first", "# First runbook\n\nOpened at launch.\n")
    const second = writeRunbook("second", "# Second runbook\n\nOpened from the menu.\n")
    const { app, page } = await launch([first], terminalEnv())
    await expectRunbook(page, "First runbook")

    // The native file dialog can't be driven: make it pick the second runbook.
    await runInMain(
      app,
      ({ dialog }, dir) => {
        dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as never
      },
      second,
    )
    await clickMenuItem(app, ["File", "Open Runbook…"])
    await expectRunbook(page, "Second runbook")

    const reloaded = page.waitForEvent("domcontentloaded")
    await clickMenuItem(app, ["View", "Reload"])
    await reloaded
    await expectRunbook(page, "Second runbook")
    await expect(page.getByRole("heading", { name: "First runbook" })).toHaveCount(0)

    await clickMenuItem(app, ["File", "Close Runbook"])
    await expect(page.getByText("Open a runbook to get started.")).toBeVisible()
    await expect(page.getByRole("heading", { name: "Second runbook" })).toHaveCount(0)
  })

  test("File > Open from URL…, Switch Session… and Rename Session… open what they name", async () => {
    const dir = writeRunbook("menu", "# Menu runbook\n\nFor the File menu.\n")
    const { app, page } = await launch([dir], terminalEnv())
    await expectRunbook(page, "Menu runbook")

    await clickMenuItem(app, ["File", "Open from URL…"])
    const openUrl = page.getByRole("dialog", { name: "Open from URL" })
    await expect(openUrl.getByRole("textbox")).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(openUrl).toBeHidden()

    await clickMenuItem(app, ["File", "Switch Session…"])
    const sessions = page.getByRole("dialog", { name: "Sessions" })
    // The open runbook's session, grouped under the runbook's path.
    await expect(sessions.getByRole("region", { name: dir })).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(sessions).toBeHidden()

    await clickMenuItem(app, ["File", "Rename Session…"])
    await expect(page.getByRole("textbox", { name: "Session name" })).toBeFocused()
  })

  // Help > Learn More is left out: it opens https://docs.gruntwork.io/runbooks,
  // which is a 404. The docs are at https://runbooks.gruntwork.io.
  test("Help > Report Issue opens the issue tracker in the browser", async () => {
    const { app, page } = await launch([], terminalEnv())
    await expect(page.getByText("Open a runbook to get started.")).toBeVisible({ timeout: 60_000 })
    await runInMain(
      app,
      ({ shell }) => {
        const opened: string[] = []
        Object.assign(globalThis, { opened })
        shell.openExternal = async (url) => void opened.push(url)
      },
      undefined,
    )

    await clickMenuItem(app, ["Help", "Report Issue"])
    await expect
      .poll(() =>
        readFromMain(
          app,
          // The setup above put `opened` on main's globalThis, whose type doesn't have it.
          () => (globalThis as unknown as { opened: string[] }).opened,
          undefined,
        ),
      )
      .toEqual([ISSUES_URL])
  })
})

test.describe("the updater", () => {
  test("an unpackaged build never asks the release feed for an update", async () => {
    // Every session's connections to GitHub, including the session the
    // updater makes its requests in, go to this server, which counts and
    // closes them. --proxy-server would only cover the default session.
    let connections = 0
    const github = net.createServer((socket) => {
      connections++
      socket.destroy()
    })
    await new Promise<void>((resolve) => {
      github.listen(0, "127.0.0.1", resolve)
    })
    try {
      const address = github.address()
      if (address === null || typeof address === "string") throw new Error("server has no port")
      const target = `127.0.0.1:${address.port}`
      const rules = ["github.com", "*.github.com", "*.githubusercontent.com"]
        .map((host) => `MAP ${host} ${target}`)
        .join(", ")
      const { app, page } = await launch([`--host-resolver-rules=${rules}`], terminalEnv())

      // A request from a session of its own reaches the server.
      await runInMain(
        app,
        async ({ session }, url) => {
          await session
            .fromPartition("system-spec-control", { cache: false })
            .fetch(url)
            .catch(() => undefined)
        },
        RELEASE_FEED_URL,
      )
      await expect.poll(() => connections).toBeGreaterThan(0)
      const afterControl = connections

      await page.waitForTimeout(UPDATE_CHECK_WINDOW_MS)
      expect(connections).toBe(afterControl)
    } finally {
      await new Promise<void>((resolve) => {
        github.close(() => resolve())
      })
    }
  })
})

test.describe("the environment scripts start from", () => {
  const OBSERVE_SCRIPT = (observed: string) => `#!/bin/bash
set -euo pipefail
{
  echo "greeting=\${${PROFILE_GREETING}-unset}"
  if command -v runbooks-e2e-profile-tool >/dev/null; then
    runbooks-e2e-profile-tool
  else
    echo "tool=not found"
  fi
} > '${observed}'
`

  let observed: string
  let runbookDir: string

  test.beforeEach(() => {
    observed = path.join(tmpDir, "observed.txt")
    runbookDir = writeRunbook(
      "shell-env",
      `# Shell environment

<Command id="observe" title="Observe the environment" path="observe.sh" successMessage="Observed" />
`,
      { "observe.sh": OBSERVE_SCRIPT(observed) },
    )

    // The login shell's profile exports a variable and puts a tool on PATH.
    const bin = path.join(home, "profile-bin")
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, "runbooks-e2e-profile-tool"), "#!/bin/sh\necho tool=ran\n", {
      mode: 0o755,
    })
    fs.writeFileSync(
      path.join(home, ".bash_profile"),
      `export ${PROFILE_GREETING}=from-profile\nexport PATH="$HOME/profile-bin:$PATH"\n`,
    )
  })

  /** Run the runbook's one script and return the lines it wrote. */
  async function observe(page: Page): Promise<string[]> {
    await expectRunbook(page, "Shell environment")
    const trustButton = page.getByRole("button", { name: "I trust this Runbook" })
    if (await trustButton.isVisible()) await trustButton.click()
    await page.getByRole("button", { name: "Run", exact: true }).click()
    await expect(page.getByText("Observed", { exact: true })).toBeVisible({ timeout: 30_000 })
    return fs.readFileSync(observed, "utf8").trimEnd().split("\n")
  }

  test("a desktop launch gives scripts the variables and PATH of the user's login shell profile", async () => {
    const { page } = await launch([runbookDir], desktopEnv())
    expect(await observe(page)).toEqual(["greeting=from-profile", "tool=ran"])
  })

  test("a terminal launch gives scripts the value it was started with, over the profile's", async () => {
    // SHELL names the shell whose profile sets the variable too: if the app
    // reads the login shell on a terminal launch, the launch's value must still win.
    const env = terminalEnv({ [PROFILE_GREETING]: "from-launch", SHELL: "/bin/bash" })
    const { page } = await launch([runbookDir], env)
    expect((await observe(page))[0]).toBe("greeting=from-launch")
  })
})
