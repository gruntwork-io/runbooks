/**
 * Launching the rebuilt app as a person does: with a runbook on the command
 * line, with none, and again while it runs.
 *
 * Runs against the build in app-out/: `just app-test-e2e` builds it first.
 * Each test launches it through the shared fixture (fixtures.ts).
 */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import type { Page, TestInfo } from "@playwright/test"
import { readFromMain, runInMain } from "../electron/e2e/main-process.ts"
import { expect, test } from "./fixtures.ts"

/** A runbook folder: the Command block's end-to-end fixture. */
const RUNBOOK_FOLDER = path.resolve(
  import.meta.dirname,
  "..",
  "blocks",
  "command",
  "testdata",
  "end-to-end",
)

/** The e2e runbooks' folder, and the one whose title the tests read. */
const RUNBOOKS = path.join(import.meta.dirname, "runbooks")
const WALK = path.join(RUNBOOKS, "walk")

/** The preload's bridge, as the page holds it. */
interface Bridge {
  readonly send: (message: string) => void
  readonly onMessage: (listener: (message: string) => void) => () => void
}

/** The runbook files of the engine's open sessions, as the page's raw `ListSessions` gets them. */
function openRunbooks(page: Page): Promise<unknown> {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const bridge = Reflect.get(window, "engine") as Bridge
        const stop = bridge.onMessage((text) => {
          const message = JSON.parse(text)
          if (message._tag !== "Exit" || message.requestId !== "list") return
          stop()
          resolve(message.exit.value.map((session: { path: string }) => session.path))
        })
        bridge.send(
          JSON.stringify({
            _tag: "Request",
            id: "list",
            tag: "ListSessions",
            payload: null,
            headers: [],
          }),
        )
      }),
  )
}

/** A GitHub repository on disk, and the app's environment to clone it. */
interface GitHubOnDisk {
  /** Sandboxes git, refuses its http(s) transport, and gives github.com a token that is not real. */
  readonly env: Readonly<Record<string, string>>
  readonly token: string
}

/**
 * github.com/acme/runbooks, with the walk runbook in its walk/ folder, as a
 * repository in the test's output folder. A global git config of the
 * test's own rewrites https://github.com/ to the folder that holds it.
 */
function githubOnDisk(testInfo: TestInfo): GitHubOnDisk {
  const root = testInfo.outputPath("github")
  const remotes = path.join(root, "remotes")
  const repo = path.join(remotes, "acme", "runbooks.git")
  fs.mkdirSync(path.join(repo, "walk"), { recursive: true })
  fs.copyFileSync(path.join(WALK, "runbook.mdx"), path.join(repo, "walk", "runbook.mdx"))
  const home = path.join(root, "home")
  fs.mkdirSync(home)
  const gitconfig = path.join(root, "gitconfig")
  fs.writeFileSync(gitconfig, `[url "file://${remotes}/"]\n\tinsteadOf = https://github.com/\n`)
  // Built at runtime so secret scanners don't flag the fixture.
  const token = ["e2e", "not", "a", "real", "token"].join("-")
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    GH_CONFIG_DIR: path.join(home, ".config", "gh"),
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "file",
    GH_HOST: "github.com",
    GITHUB_TOKEN: token,
    GH_TOKEN: token,
  }
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.email=e2e@example.com",
        "-c",
        "user.name=E2E",
        "-c",
        "commit.gpgsign=false",
      ].concat(args),
      { cwd: repo, stdio: "pipe", env: { ...process.env, ...env } },
    )
  git("init", "-b", "main")
  git("add", ".")
  git("commit", "-m", "The walk runbook")
  return { env, token }
}

/** What is left in the clones folder of `userDataDir`. */
function leftInClones(userDataDir: string): string[] {
  const clones = path.join(userDataDir, "v0", "clones")
  return fs.existsSync(clones) ? fs.readdirSync(clones) : []
}

test.describe("launching the rebuilt app", () => {
  test("with no runbook, shows a welcome screen that says how to open one, and no buttons", async ({
    launch,
  }) => {
    const { page } = await launch()
    const welcome = page.getByRole("region", { name: "Open a runbook" })
    await expect(welcome).toContainText("on the command line")
    await expect(welcome).toContainText("runbook.mdx")
    await expect(page.getByRole("button")).toHaveCount(0)
    expect(await openRunbooks(page)).toEqual([])
  })

  test("with a runbook file's path, opens that runbook", async ({ launch }) => {
    const runbook = path.join(WALK, "runbook.mdx")
    const { page } = await launch({ args: [runbook] })
    await expect(page.getByRole("heading", { level: 1, name: "Walk the document" })).toBeVisible()
    expect(await openRunbooks(page)).toEqual([runbook])
  })

  test("with a relative path, opens the runbook in the folder it names from where it started", async ({
    launch,
  }) => {
    const { page } = await launch({ args: ["walk"], cwd: RUNBOOKS })
    await expect(page.getByRole("heading", { level: 1, name: "Walk the document" })).toBeVisible()
    expect(await openRunbooks(page)).toEqual([path.join(WALK, "runbook.mdx")])
  })

  test("with a path to nothing, says so and shows the welcome screen", async ({ launch }) => {
    const missing = path.join(RUNBOOKS, "missing")
    const { page, output } = await launch({ args: [missing] })
    await expect(page.getByRole("heading", { name: "Open a runbook" })).toBeVisible()
    await expect
      .poll(output)
      .toContain(`Runbooks could not open ${missing}: there is no file or folder there.`)
    expect(await openRunbooks(page)).toEqual([])
  })

  test("with a GitHub URL, clones the repository into its user data folder and shows the runbook", async ({
    launch,
    userDataDir,
  }, testInfo) => {
    const { env } = githubOnDisk(testInfo)
    const { page } = await launch({
      env,
      args: ["https://github.com/acme/runbooks/tree/main/walk"],
    })
    await expect(page.getByRole("heading", { level: 1, name: "Walk the document" })).toBeVisible()
    const [clone] = leftInClones(userDataDir)
    expect(await openRunbooks(page)).toEqual([
      path.join(userDataDir, "v0", "clones", String(clone), "runbooks", "walk", "runbook.mdx"),
    ])
  })

  test("with a URL that can't be cloned, says why in one line without its credentials, and shows the welcome screen", async ({
    launch,
    userDataDir,
  }, testInfo) => {
    const { env, token } = githubOnDisk(testInfo)
    // Built at runtime so secret scanners don't flag the fixture.
    const password = ["e2e", "pass", "word"].join("-")
    const { page, output } = await launch({
      env,
      args: [`https://someone:${password}@github.com/acme/missing/tree/main/walk`],
    })
    await expect(page.getByRole("heading", { name: "Open a runbook" })).toBeVisible()
    await expect
      .poll(output)
      .toContain(
        "Runbooks could not open https://github.com/acme/missing/tree/main/walk: authentication failed for github.com/acme/missing (token may be invalid or expired): verify GITHUB_TOKEN, or re-run 'gh auth login'\n",
      )
    expect(
      output()
        .split("\n")
        .filter((line) => line.startsWith("Runbooks could not open")),
    ).toHaveLength(1)
    expect(output()).not.toContain(password)
    expect(output()).not.toContain(token)
    expect(await openRunbooks(page)).toEqual([])
    expect(leftInClones(userDataDir)).toEqual([])
  })

  test("removes the clones an earlier run left when it starts, and its own when it quits", async ({
    launch,
    userDataDir,
  }, testInfo) => {
    const { env } = githubOnDisk(testInfo)
    const left = path.join(userDataDir, "v0", "clones", "left-by-a-crash", "runbooks")
    fs.mkdirSync(left, { recursive: true })
    fs.writeFileSync(path.join(left, "runbook.mdx"), "# Left behind\n")

    const { app, page } = await launch({
      env,
      args: ["https://github.com/acme/runbooks/tree/main/walk"],
    })
    await expect(page.getByRole("heading", { level: 1, name: "Walk the document" })).toBeVisible()
    const cloned = leftInClones(userDataDir)
    expect(cloned).toHaveLength(1)
    expect(cloned).not.toContain("left-by-a-crash")

    await app.close()
    expect(fs.existsSync(path.join(userDataDir, "v0", "clones"))).toBe(false)
  })

  test("again with a runbook's path, from another folder, shows that runbook in the first window", async ({
    launch,
    launchAgain,
  }) => {
    const { app, page } = await launch({ args: [RUNBOOK_FOLDER] })
    await expect(page.getByRole("heading", { level: 1, name: "Command, end to end" })).toBeVisible()

    const second = await launchAgain(["walk"], { cwd: RUNBOOKS })

    expect(second.code, second.output).toBe(0)
    await expect(page.getByRole("heading", { level: 1, name: "Walk the document" })).toBeVisible()
    expect(app.windows()).toHaveLength(1)
    expect(await openRunbooks(page)).toEqual([
      path.join(RUNBOOK_FOLDER, "runbook.mdx"),
      path.join(WALK, "runbook.mdx"),
    ])
  })

  test("again with no runbook focuses the first window and opens nothing", async ({
    launch,
    launchAgain,
  }) => {
    const { app, page } = await launch()
    await runInMain(
      app,
      ({ BrowserWindow }) => {
        const [appWindow] = BrowserWindow.getAllWindows()
        if (!appWindow) throw new Error("the app has no window")
        const focused: string[] = []
        Object.assign(globalThis, { focused })
        const focus = appWindow.focus.bind(appWindow)
        appWindow.focus = () => {
          focused.push("focus")
          focus()
        }
      },
      undefined,
    )

    const second = await launchAgain([])

    expect(second.code, second.output).toBe(0)
    await expect
      .poll(() => readFromMain(app, () => Reflect.get(globalThis, "focused"), undefined))
      .toEqual(["focus"])
    expect(app.windows()).toHaveLength(1)
    expect(await openRunbooks(page)).toEqual([])
  })
})
