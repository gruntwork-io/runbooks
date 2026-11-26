/**
 * How the rebuilt app's specs launch it: the build in app-out/ (`just
 * app-build`), each launch on a user data folder of the test's own
 * (`--user-data-dir`), so no spec reads or writes the real one, and with
 * Chromium's sandbox kept (`chromiumSandbox: true`), so the renderer runs
 * as it does for a user.
 */
import { spawn } from "node:child_process"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"
import {
  _electron as electron,
  expect,
  test as base,
  type ElectronApplication,
  type Page,
} from "@playwright/test"
import { readFromMain } from "../electron/e2e/main-process.ts"

export { expect }

const OUT = path.join(import.meta.dirname, "..", "app-out")
const MAIN = path.join(OUT, "main", "index.js")

/** The renderer's page, as the window shows it. */
export const PAGE = pathToFileURL(path.join(OUT, "renderer", "index.html")).href

export interface Launched {
  readonly app: ElectronApplication
  readonly page: Page
  /** What the main process has written to its standard output and error so far. */
  readonly output: () => string
}

/**
 * How a test launches the app. By default it passes `--user-data-dir`
 * naming the test's folder. `defaultUserData` launches without it, with the
 * environment added, to see where the app keeps its user data by itself.
 * `env` adds to the app's environment, `args` to its command line, as a
 * runbook to open, and `cwd` is the folder it starts in.
 */
export interface LaunchOptions {
  readonly defaultUserData?: { readonly env: Readonly<Record<string, string>> }
  readonly env?: Readonly<Record<string, string>>
  readonly args?: ReadonlyArray<string>
  readonly cwd?: string
}

/** How a launch that opens no window ended. */
export interface Ended {
  /** The exit code, or null when a signal ended it. */
  readonly code: number | null
  /** What it wrote to its standard output and error. */
  readonly output: string
}

/** How long a launch that opens no window may take to end. */
const ENDED_WITHIN = 30_000

export const test = base.extend<{
  /**
   * A user data folder of the test's own, in its output folder, removed
   * after it. A worker killed mid-test (a teardown past its timeout) leaves
   * it to the next run, which empties the output folder.
   */
  userDataDir: string
  /** Launches the app, on `userDataDir` unless told otherwise, and waits for its page. Each app still open is closed after the test. */
  launch: (options?: LaunchOptions) => Promise<Launched>
  /**
   * Launches the app again on `userDataDir` with `args`, as a person would
   * while it runs, and waits for that launch to end. It opens no window, so
   * Playwright does not drive it.
   */
  launchAgain: (args: ReadonlyArray<string>) => Promise<Ended>
}>({
  userDataDir: async ({}, use, testInfo) => {
    const made = testInfo.outputPath("user-data")
    fs.mkdirSync(made, { recursive: true })
    // Electron reports the folder with symlinks resolved.
    const dir = fs.realpathSync(made)
    await use(dir)
    fs.rmSync(dir, { recursive: true, force: true })
  },
  launch: async ({ userDataDir }, use) => {
    const open = new Set<ElectronApplication>()
    await use(async (options = {}) => {
      const { defaultUserData, env, args = [], cwd } = options
      const added = { ...defaultUserData?.env, ...env }
      // On Linux, Playwright adds --no-sandbox unless it's told to keep Chromium's sandbox.
      const app = await electron.launch({
        args: defaultUserData ? [MAIN, ...args] : [MAIN, `--user-data-dir=${userDataDir}`, ...args],
        ...(Object.keys(added).length > 0 && { env: { ...definedEnvironment(), ...added } }),
        ...(cwd !== undefined && { cwd }),
        chromiumSandbox: true,
      })
      open.add(app)
      app.on("close", () => open.delete(app))
      let output = ""
      const keep = (chunk: Buffer) => {
        output += chunk.toString()
      }
      app.process().stdout?.on("data", keep)
      app.process().stderr?.on("data", keep)
      const page = await app.firstWindow()
      await expect(page.getByRole("banner")).toHaveText("Runbooks")
      return { app, page, output: () => output }
    })
    for (const app of open) await app.close()
  },
  launchAgain: async ({ userDataDir }, use) => {
    await use(
      (args) =>
        new Promise((resolve, reject) => {
          // Chromium's sandbox stays on: nothing here passes --no-sandbox.
          const child = spawn(electronBinary(), [MAIN, `--user-data-dir=${userDataDir}`, ...args], {
            stdio: ["ignore", "pipe", "pipe"],
          })
          let output = ""
          child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()))
          child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()))
          const timer = setTimeout(() => {
            child.kill("SIGKILL")
            reject(new Error(`The second launch did not end within ${ENDED_WITHIN} ms:\n${output}`))
          }, ENDED_WITHIN)
          child.on("error", reject)
          child.on("exit", (code) => {
            clearTimeout(timer)
            resolve({ code, output })
          })
        }),
    )
  },
})

/** The Electron binary, as Playwright finds it: the electron package's main export. */
function electronBinary(): string {
  const binary: unknown = createRequire(import.meta.url)("electron")
  if (typeof binary !== "string") throw new Error("The electron package did not name its binary.")
  return binary
}

/** This process's environment, less the names it holds no value for. */
function definedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
}

/**
 * What `script` gives when it runs as the page's own script. Code that
 * page.evaluate runs is DevTools code, which Chromium lets evaluate strings
 * whatever the page's CSP says, so this runs it through the window's
 * executeJavaScript.
 */
export function runAsPage(app: ElectronApplication, script: string): Promise<unknown> {
  return readFromMain(
    app,
    ({ BrowserWindow }, code) => {
      const [appWindow] = BrowserWindow.getAllWindows()
      if (!appWindow) throw new Error("the app has no window")
      return appWindow.webContents.executeJavaScript(code)
    },
    script,
  )
}
