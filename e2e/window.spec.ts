/**
 * The rebuilt app's window, as its page and its user can find it: it shows
 * the renderer, runs no string as code, has no Node, runs in the OS sandbox,
 * stays on its page, opens no other window, denies every permission, and
 * keeps nothing in storage across a restart.
 *
 * Runs against the build in app-out/: `just app-test-e2e` builds it first.
 * Each test launches it through the shared fixture (fixtures.ts).
 */
import fs from "node:fs"
import path from "node:path"
import type { ElectronApplication } from "@playwright/test"
import { readFromMain, runInMain } from "../electron/e2e/main-process.ts"
import { expect, PAGE, runAsPage, test } from "./fixtures.ts"

/** Has the app record each URL it would open in the browser, and returns a reader of that list. */
async function recordBrowserOpens(app: ElectronApplication): Promise<() => Promise<unknown>> {
  await runInMain(
    app,
    ({ shell }) => {
      const opened: string[] = []
      Object.assign(globalThis, { opened })
      shell.openExternal = async (url) => void opened.push(url)
    },
    undefined,
  )
  return () => readFromMain(app, () => Reflect.get(globalThis, "opened"), undefined)
}

/**
 * How the OS confines the window's renderer process. macOS and Windows say
 * whether they sandbox it. Linux doesn't, so on Linux this reads the
 * process's type and its seccomp mode: Chromium's sandbox runs a renderer
 * under a seccomp-bpf filter (mode 2), and an unsandboxed one under none (0).
 * `seen` holds what was read, for a failure's message.
 */
async function rendererConfinement(
  app: ElectronApplication,
): Promise<{ readonly confinement: object; readonly seen: string }> {
  const { pid, sandboxed } = await readFromMain(
    app,
    ({ app: electronApp, BrowserWindow }) => {
      const [appWindow] = BrowserWindow.getAllWindows()
      if (!appWindow) throw new Error("the app has no window")
      const rendererPid = appWindow.webContents.getOSProcessId()
      const metric = electronApp.getAppMetrics().find((m) => m.pid === rendererPid)
      return { pid: rendererPid, sandboxed: metric?.sandboxed }
    },
    undefined,
  )
  if (process.platform !== "linux") return { confinement: { sandboxed }, seen: `pid ${pid}` }
  const status = fs.readFileSync(`/proc/${pid}/status`, "utf8")
  // Chromium rewrites a child's title over its arguments, as one line split by spaces.
  const args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split(/[\0 ]/)
  const type = args.find((arg) => arg.startsWith("--type="))?.slice("--type=".length)
  const seccomp = /^Seccomp:\s+(\d+)$/m.exec(status)?.[1]
  const seen = [
    `pid ${pid}`,
    ...status.split("\n").filter((line) => /^(Name|Seccomp|NoNewPrivs|NSpid):/.test(line)),
    ...args.filter((arg) =>
      /^--(type|no-sandbox|no-zygote|enable-sandbox|disable-seccomp)/.test(arg),
    ),
  ].join("; ")
  return { confinement: { type, seccomp }, seen }
}

test.describe("the rebuilt app's window", () => {
  test("shows the renderer's page", async ({ launch }) => {
    const { page } = await launch()
    expect(page.url()).toBe(PAGE)
    await expect(page).toHaveTitle("Runbooks")
  })

  test("refuses to run a string as code: eval, Function and an inline script", async ({
    launch,
  }) => {
    const { app } = await launch()
    const refused = await runAsPage(
      app,
      `(() => {
        const run = (code) => { try { code(); return "ran" } catch (error) { return error.constructor.name } }
        const inline = document.createElement("script")
        inline.textContent = "window.inlineRan = true"
        document.head.append(inline)
        return {
          eval: run(() => eval("1")),
          Function: run(() => new Function("return 1")),
          inlineScript: window.inlineRan === true ? "ran" : "refused",
        }
      })()`,
    )
    expect(refused).toEqual({ eval: "EvalError", Function: "EvalError", inlineScript: "refused" })
  })

  test("styles its page from its own stylesheet, and refuses an inline one", async ({ launch }) => {
    const { app, page } = await launch()
    // Tailwind's preflight, in the app's stylesheet, takes the body's margin away.
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).margin)).toBe("0px")
    const inline = await runAsPage(
      app,
      `(() => {
        const style = document.createElement("style")
        style.textContent = "body { margin: 77px }"
        document.head.append(style)
        const attribute = document.createElement("p")
        attribute.setAttribute("style", "margin: 77px")
        document.body.append(attribute)
        return [getComputedStyle(document.body).margin, getComputedStyle(attribute).margin]
      })()`,
    )
    expect(inline).toEqual(["0px", "0px"])
  })

  test("has no require or process", async ({ launch }) => {
    const { page } = await launch()
    expect(await page.evaluate(() => [typeof require, typeof process])).toEqual([
      "undefined",
      "undefined",
    ])
  })

  test("runs its renderer in the OS sandbox", async ({ launch }) => {
    const { app } = await launch()
    const { confinement, seen } = await rendererConfinement(app)
    expect(confinement, seen).toEqual(
      process.platform === "linux" ? { type: "renderer", seccomp: "2" } : { sandboxed: true },
    )
  })

  test("stays on its page, and opens an https link in the browser instead", async ({ launch }) => {
    const { app, page } = await launch()
    const opened = await recordBrowserOpens(app)
    await page.evaluate(() => {
      location.href = "https://example.invalid/away"
    })
    await expect.poll(opened).toEqual(["https://example.invalid/away"])
    // Locators would wait for the refused navigation to finish, and it never does.
    const shown = await page.evaluate(() => [
      location.href,
      document.querySelector("header")?.textContent,
    ])
    expect(shown).toEqual([PAGE, "Runbooks"])
  })

  test("opens no other window, and opens only an http, https or mailto URL outside the app", async ({
    launch,
  }) => {
    const { app, page } = await launch()
    const opened = await recordBrowserOpens(app)
    const windows = await page.evaluate(() =>
      ["file:///etc/hosts", "https://example.invalid/new", "mailto:ops@example.invalid"].map(
        (url) => window.open(url),
      ),
    )
    expect(windows).toEqual([null, null, null])
    await expect.poll(opened).toEqual(["https://example.invalid/new", "mailto:ops@example.invalid"])
    expect(app.windows()).toHaveLength(1)
  })

  test("opens a mailto link it follows in the mail app, and stays on its page", async ({
    launch,
  }) => {
    const { app, page } = await launch()
    const opened = await recordBrowserOpens(app)
    await page.evaluate(() => {
      location.href = "mailto:ops@example.invalid?subject=Runbook"
    })
    await expect.poll(opened).toEqual(["mailto:ops@example.invalid?subject=Runbook"])
    expect(await page.evaluate(() => location.href)).toBe(PAGE)
  })

  test("denies the page every permission it asks for", async ({ launch }) => {
    const { page } = await launch()
    const answers = await page.evaluate(async () => ({
      request: await Notification.requestPermission(),
      check: (await navigator.permissions.query({ name: "geolocation" })).state,
    }))
    expect(answers).toEqual({ request: "denied", check: "denied" })
  })

  test("keeps nothing in localStorage across a restart", async ({ launch }) => {
    const first = await launch()
    await first.page.evaluate(() => localStorage.setItem("probe", "kept"))
    expect(await first.page.evaluate(() => localStorage.getItem("probe"))).toBe("kept")
    await first.app.close()

    const second = await launch()
    expect(await second.page.evaluate(() => localStorage.getItem("probe"))).toBeNull()
  })

  test("keeps its user data in runbooks-rebuild, in the app data folder, when no folder is named", async ({
    launch,
    userDataDir,
  }) => {
    // Electron's app data folder is $XDG_CONFIG_HOME on Linux. On macOS and
    // Windows nothing in the environment moves it, so the app would write in
    // the real one: the test runs where CI runs it, on Linux.
    test.skip(process.platform !== "linux", "only Linux's environment can move the app data folder")
    const { app } = await launch({ defaultUserData: { env: { XDG_CONFIG_HOME: userDataDir } } })
    const folders = await readFromMain(
      app,
      ({ app: electronApp }) => ({
        appData: electronApp.getPath("appData"),
        userData: electronApp.getPath("userData"),
      }),
      undefined,
    )
    expect(folders).toEqual({
      appData: userDataDir,
      userData: path.join(userDataDir, "runbooks-rebuild"),
    })
  })

  test("keeps its user data in the folder --user-data-dir names", async ({
    launch,
    userDataDir,
  }) => {
    const { app } = await launch()
    const folder = await readFromMain(
      app,
      ({ app: electronApp }) => electronApp.getPath("userData"),
      undefined,
    )
    expect(folder).toBe(userDataDir)
  })
})
