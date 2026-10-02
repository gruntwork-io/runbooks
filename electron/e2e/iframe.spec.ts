/**
 * E2E tests for the Iframe block in the built app, where the production CSP
 * applies (electron/main/csp.ts).
 *
 * Opens a throwaway runbook that embeds a page from its assets/ folder, whose
 * stylesheet and script load through relative paths, and a page served by a
 * local HTTP server. Each runs in a <webview> guest (electron/main/embeds.ts),
 * a web contents of its own that Playwright has no Frame for, so the tests
 * reach into guests through the main process. Also checks what an embedded
 * page cannot do: load before the user clicks, take keyboard focus from the
 * app, read runbook files outside assets/, open windows or dialogs, get
 * permissions, read the storage of another runbook's pages, or (for a web
 * page) load the runbook's assets; and that a <webview> the Iframe block
 * didn't make can't pick its own session or preload. Also checks the app
 * session's permission handlers (electron/main/permissions.ts) with
 * navigator.permissions.query, which never raises an OS prompt, and that the
 * title bar keeps the end of a long host, the part that names the site, in view.
 *
 * Prerequisites: run `electron-vite build` first (expects ./dist/main/index.js).
 *
 * Run with:
 *   bunx playwright test --config electron/e2e/playwright.config.ts 'iframe\.spec'
 */
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test"
import * as fs from "fs"
import * as http from "http"
import type { AddressInfo } from "net"
import * as os from "os"
import * as path from "path"
import { fileURLToPath } from "url"
import { readFromMain, runInMain } from "./main-process.ts"
import { guestUrls, inGuest } from "./webview-guests.ts"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, "../..")
const MAIN_ENTRY = path.join(ROOT, "dist/main/index.js")

const LOCAL_PAGE = `<!doctype html>
<link rel="stylesheet" href="style.css" />
<h1>Local page</h1>
<p id="status">script pending</p>
<script src="app.js"></script>
`

const EXTERNAL_PAGE = "<!doctype html><h1>External page</h1>"

// Shows what the page found in localStorage, then saves `runbook`'s name there.
const STORAGE_PAGE = '<!doctype html><p id="seen"></p><script src="storage.js"></script>\n'
const storageScript = (runbook: string) =>
  `document.getElementById("seen").textContent = localStorage.getItem("token") ?? "nothing"\n` +
  `localStorage.setItem("token", "saved by ${runbook}")\n`

// Takes keyboard focus into its own field every 50ms, without a click, and
// keeps what it gets.
const GRAB_PAGE = `<!doctype html><input id="grab"><script>
  setInterval(() => { window.focus(); document.getElementById("grab").focus() }, 50)
  window.stealing = true
</script>`

// Sets a mark on the page if it runs, which it must not: see the <webview> test.
const PRELOAD =
  'document.addEventListener("DOMContentLoaded", () => { document.documentElement.dataset.preloaded = "yes" })\n'

// A host that starts like AWS's and ends with the site it really is.
const SPOOF_URL = `https://console.aws.amazon.com.signin-verify-session-${"0".repeat(40)}.evil.example/`

let tmpDir: string
let server: http.Server
let serverUrl: string

test.beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" })
    res.end(EXTERNAL_PAGE)
  })
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })
  serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
})

test.afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
  })
})

/** Write runbook `name`, which frames a page that reports and saves localStorage. */
function writeRunbook(name: string, blocks: string): string {
  const runbookDir = path.join(tmpDir, name)
  const storageDir = path.join(runbookDir, "assets/storage")
  fs.mkdirSync(storageDir, { recursive: true })
  fs.writeFileSync(
    path.join(runbookDir, "runbook.mdx"),
    `# Iframes\n\n${blocks}<Iframe src="./assets/storage/index.html" title="Storage" />\n`,
  )
  fs.writeFileSync(path.join(storageDir, "index.html"), STORAGE_PAGE)
  fs.writeFileSync(path.join(storageDir, "storage.js"), storageScript(name))
  return runbookDir
}

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-iframe-e2e-"))
  const runbookDir = writeRunbook(
    "runbook",
    `<Iframe src="./assets/site/index.html" title="Local" />\n\n<Iframe src="${serverUrl}" title="External" />\n\n` +
      `<Iframe src="${serverUrl.replace("127.0.0.1", "localhost")}" title="Localhost" />\n\n` +
      `<Iframe src="${SPOOF_URL}" title="AWS sign-in" />\n\n<Iframe src="./assets/grab/index.html" title="Grabber" />\n\n`,
  )
  fs.mkdirSync(path.join(runbookDir, "assets/grab"))
  fs.writeFileSync(path.join(runbookDir, "assets/grab/index.html"), GRAB_PAGE)
  fs.writeFileSync(path.join(tmpDir, "preload.js"), PRELOAD)
  const siteDir = path.join(runbookDir, "assets/site")
  fs.mkdirSync(siteDir, { recursive: true })
  fs.writeFileSync(path.join(runbookDir, "secret.txt"), "secret")
  fs.writeFileSync(path.join(siteDir, "index.html"), LOCAL_PAGE)
  fs.writeFileSync(path.join(siteDir, "style.css"), "h1 { color: rgb(37, 99, 235); }\n")
  fs.writeFileSync(
    path.join(siteDir, "app.js"),
    'document.getElementById("status").textContent = "script ran"\n',
  )
  writeRunbook("other", "")
})

test.afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** Open runbook `name`. Launches in one test share a user-data dir, and so their storage. */
async function launch(name = "runbook"): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    // --user-data-dir isolates the single-instance lock and trust state.
    args: [
      MAIN_ENTRY,
      `--user-data-dir=${path.join(tmpDir, "user-data")}`,
      path.join(tmpDir, name),
    ],
    env: {
      ...process.env,
      ELECTRON_NO_UPDATER: "1",
      RUNBOOKS_TELEMETRY_DISABLE: "1",
    },
  })
  const page = await app.firstWindow()
  await page.waitForLoadState("domcontentloaded")
  await expect(page.getByRole("heading", { name: "Iframes" })).toBeVisible({ timeout: 60_000 })
  return { app, page }
}

/** Click the Load button of the block titled `title`. */
async function loadFrame(page: Page, title: string): Promise<void> {
  await page
    .locator(".runbook-block")
    .filter({ has: page.getByText(title, { exact: true }) })
    .getByRole("button", { name: "Load page" })
    .click()
}

// The runbook's own runbook-asset:// host, whose root is its assets/ folder.
const LOCAL_SITE = /^runbook-asset:\/\/r[0-9a-f]{32}\/site\/index\.html$/

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Whether the stylesheet at `href` loads in the guest whose URL matches `url`. */
function stylesheetLoads(app: ElectronApplication, url: RegExp, href: string): Promise<boolean> {
  return inGuest(
    app,
    url,
    `new Promise((resolve) => {
      const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: ${JSON.stringify(href)} })
      link.onload = () => resolve(true)
      link.onerror = () => resolve(false)
      document.head.append(link)
    })`,
  )
}

test.describe("Iframe block", () => {
  test("loads nothing until the user clicks Load", async () => {
    const { app, page } = await launch()
    try {
      await expect(page.getByRole("button", { name: "Load page" })).toHaveCount(6)
      expect(await guestUrls(app)).toEqual([])
    } finally {
      await app.close()
    }
  })

  test("loads a page from the assets folder with its relative stylesheet and script", async () => {
    const { app, page } = await launch()
    try {
      await loadFrame(page, "Local")
      await expect
        .poll(() => inGuest(app, LOCAL_SITE, `document.getElementById("status")?.textContent`))
        .toBe("script ran")
      expect(
        await inGuest(app, LOCAL_SITE, `getComputedStyle(document.querySelector("h1")).color`),
      ).toBe("rgb(37, 99, 235)")

      // No preload, so no window.api and nothing of Node.
      expect(
        await inGuest(app, LOCAL_SITE, `[typeof window.api, typeof require, typeof process]`),
      ).toEqual(["undefined", "undefined", "undefined"])
      // secret.txt sits in the runbook directory, next to runbook.mdx.
      expect(
        await inGuest(app, LOCAL_SITE, `fetch("/..%2Fsecret.txt").then((r) => r.status)`),
      ).toBe(403)
      // alert() would open a native dialog over the app. (Calling it here
      // trips Playwright's own dialog handling, so check the preference.)
      const prefs = await readFromMain(
        app,
        ({ webContents }) => {
          const guest = webContents.getAllWebContents().find((c) => c.getType() === "webview")!
          const { disableDialogs, sandbox, contextIsolation, nodeIntegration } =
            guest.getLastWebPreferences()!
          return { disableDialogs, sandbox, contextIsolation, nodeIntegration }
        },
        undefined,
      )
      expect(prefs).toEqual({
        disableDialogs: true,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      })

      // window.open is denied instead of reaching the main process's
      // window-open handler, which would open the URL in the browser without
      // a click.
      await runInMain(
        app,
        ({ shell }) => {
          const opened: string[] = []
          Object.assign(globalThis, { opened })
          shell.openExternal = async (url) => void opened.push(url)
        },
        undefined,
      )
      expect(await inGuest(app, LOCAL_SITE, `window.open("https://example.com/") === null`)).toBe(
        true,
      )
      expect(
        await readFromMain(
          app,
          () => (globalThis as unknown as { opened: string[] }).opened,
          undefined,
        ),
      ).toEqual([])
    } finally {
      await app.close()
    }
  })

  test("keeps keyboard focus in the app while an embedded page tries to take it", async () => {
    const { app, page } = await launch()
    try {
      // Playwright emulates focus for its pages, which also keeps a click
      // from moving keyboard focus into a guest. The real app doesn't.
      const cdp = await page.context().newCDPSession(page)
      await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false })

      await loadFrame(page, "Grabber")
      const grabber = /\/grab\/index\.html$/
      await expect.poll(() => inGuest(app, grabber, "window.stealing === true")).toBe(true)
      // A field in the runbook, like an AwsAuth secret key field.
      await page.evaluate(() => {
        const input = Object.assign(document.createElement("input"), { id: "secret" })
        document.querySelector('[data-testid="runbook-content"]')!.prepend(input)
      })
      await page.locator("#secret").click()
      // The page tries to take focus every 50ms meanwhile.
      await page.waitForTimeout(500)
      await page.keyboard.type("hunter2", { delay: 60 })
      await expect(page.locator("#secret")).toHaveValue("hunter2")
      expect(await inGuest(app, grabber, `document.getElementById("grab").value`)).toBe("")

      // A click into the page does give it the keyboard.
      await page.locator("webview[title=Grabber]").click()
      await page.keyboard.type("ok", { delay: 60 })
      await expect
        .poll(() => inGuest(app, grabber, `document.getElementById("grab").value`))
        .toBe("ok")
    } finally {
      await app.close()
    }
  })

  test("loads plain-http pages on 127.0.0.1 and localhost, without the runbook's assets or permissions", async () => {
    const { app, page } = await launch()
    try {
      await loadFrame(page, "External")
      await loadFrame(page, "Localhost")
      await loadFrame(page, "Local")
      const external = new RegExp(`^${escapeRegExp(serverUrl)}$`)
      const localhost = new RegExp(`^${escapeRegExp(serverUrl.replace("127.0.0.1", "localhost"))}$`)
      for (const url of [external, localhost]) {
        await expect
          .poll(() => inGuest(app, url, `document.querySelector("h1")?.textContent`))
          .toBe("External page")
        expect(await inGuest(app, url, "typeof window.api")).toBe("undefined")
      }

      // Web pages run in a session that doesn't serve runbook-asset://, so a
      // site the runbook embeds can't load its assets; the local page can.
      await expect
        .poll(() => inGuest(app, LOCAL_SITE, `document.getElementById("status")?.textContent`))
        .toBe("script ran")
      const localUrl = (await guestUrls(app)).find((u) => LOCAL_SITE.test(u))!
      const stylesheet = new URL("style.css", localUrl).href
      expect(await stylesheetLoads(app, LOCAL_SITE, stylesheet)).toBe(true)
      expect(await stylesheetLoads(app, external, stylesheet)).toBe(false)

      // Electron's default would answer "granted".
      for (const name of ["camera", "notifications", "clipboard-write"]) {
        expect(
          await inGuest(
            app,
            external,
            `navigator.permissions.query({ name: "${name}" }).then((p) => p.state)`,
          ),
        ).toBe("denied")
      }
    } finally {
      await app.close()
    }
  })

  test("gives each runbook's pages their own storage", async () => {
    /** Open runbook `name`, load its storage page, and return what the page found. */
    const seen = async (name: string) => {
      const { app, page } = await launch(name)
      try {
        await loadFrame(page, "Storage")
        const storage = /\/storage\/index\.html$/
        await expect
          .poll(() => inGuest(app, storage, `document.getElementById("seen")?.textContent ?? ""`))
          .not.toBe("")
        return inGuest(app, storage, `document.getElementById("seen").textContent`)
      } finally {
        await app.close()
      }
    }

    expect(await seen("runbook")).toBe("nothing")
    expect(await seen("other")).toBe("nothing")
    // The page's storage outlives the app, so "nothing" above means the other
    // runbook's page couldn't see it.
    expect(await seen("runbook")).toBe("saved by runbook")
  })

  test("keeps the end of a long host in view in the title bar", async () => {
    const { app, page } = await launch()
    try {
      const location = page
        .locator(".runbook-block")
        .filter({ has: page.getByText("AWS sign-in", { exact: true }) })
        .getByTestId("iframe-location")
      await expect(location).toHaveText(new URL(SPOOF_URL).host)
      const inView = await location.evaluate((el) => {
        const text = el.querySelector("bdi")!.firstChild as Text
        const box = el.getBoundingClientRect()
        const charBox = (i: number) => {
          const range = document.createRange()
          range.setStart(text, i)
          range.setEnd(text, i + 1)
          return range.getBoundingClientRect()
        }
        return {
          first: charBox(0).left >= box.left,
          last: charBox(text.length - 1).right <= box.right + 0.5,
        }
      })
      // Cut from the start: …signin-verify-session-000….evil.example
      expect(inView).toEqual({ first: false, last: true })
    } finally {
      await app.close()
    }
  })

  // Runbook MDX can't write a <webview> (remarkLiteralOnly), so these stand
  // in for a bug or a compromised renderer.
  test("vets every <webview> in the main process, whatever the tag asks for", async () => {
    const { app, page } = await launch()
    try {
      await page.evaluate(
        ({ pageUrl, preload }) => {
          const add = (attributes: Record<string, string>) => {
            const webview = document.createElement("webview")
            for (const [name, value] of Object.entries(attributes))
              webview.setAttribute(name, value)
            document.body.append(webview)
          }
          add({ src: "file:///etc/hosts" })
          add({
            src: `${pageUrl}?asked`,
            partition: "persist:asked",
            preload,
            nodeintegration: "",
            webpreferences: "contextIsolation=no, sandbox=no",
          })
        },
        { pageUrl: serverUrl, preload: `file://${path.join(tmpDir, "preload.js")}` },
      )

      const asked = /\?asked$/
      await expect
        .poll(() => inGuest(app, asked, `document.querySelector("h1")?.textContent`))
        .toBe("External page")
      expect(
        await inGuest(
          app,
          asked,
          `[document.documentElement.dataset.preloaded ?? "none", typeof require]`,
        ),
      ).toEqual(["none", "undefined"])
      const inWebSession = await readFromMain(
        app,
        ({ webContents, session }) => {
          const guest = webContents
            .getAllWebContents()
            .find((c) => c.getType() === "webview" && c.getURL().endsWith("?asked"))!
          return guest.session === session.fromPartition("persist:embed-web")
        },
        undefined,
      )
      expect(inWebSession).toBe(true)
      // The file: one never got a guest.
      expect((await guestUrls(app)).filter((u) => !u.endsWith("?asked"))).toEqual([])
    } finally {
      await app.close()
    }
  })

  // Querying the app frame goes through the default session's check handler,
  // where Electron's default answers "granted". Embedded pages' sessions are
  // checked in the plain-http test.
  test("the app's own frame gets clipboard writes and nothing else", async () => {
    const { app, page } = await launch()
    try {
      const query = (name: string) =>
        page.evaluate(
          async (n) => (await navigator.permissions.query({ name: n as PermissionName })).state,
          name,
        )
      expect(await query("microphone")).toBe("denied")
      expect(await query("camera")).toBe("denied")
      expect(await query("geolocation")).toBe("denied")
      expect(await query("clipboard-write")).toBe("granted")
    } finally {
      await app.close()
    }
  })
})
