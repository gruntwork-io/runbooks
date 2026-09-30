/**
 * E2E tests for the Iframe block in the built app, where the production CSP
 * applies (electron/main/csp.ts).
 *
 * Opens a throwaway runbook that frames a page from its assets/ folder, whose
 * stylesheet and script load through relative paths, and a page served by a
 * local HTTP server. Also checks what a framed page cannot do: load before
 * the user clicks, read runbook files outside assets/, open windows, or read
 * the storage of another runbook's pages. Also checks the session's
 * permission handlers (electron/main/permissions.ts) with
 * navigator.permissions.query, which never raises an OS prompt, and that the
 * title bar keeps the end of a long host, the part that names the site, in view.
 *
 * Prerequisites: run `electron-vite build` first (expects ./dist/main/index.js).
 *
 * Run with:
 *   bunx playwright test --config electron/e2e/playwright.config.ts 'iframe\.spec'
 */
import { test, expect, _electron as electron, type ElectronApplication, type Frame, type Page } from "@playwright/test"
import * as fs from "fs"
import * as http from "http"
import type { AddressInfo } from "net"
import * as os from "os"
import * as path from "path"
import { fileURLToPath } from "url"

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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
})

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** Write runbook `name`, which frames a page that reports and saves localStorage. */
function writeRunbook(name: string, blocks: string): string {
  const runbookDir = path.join(tmpDir, name)
  const storageDir = path.join(runbookDir, "assets/storage")
  fs.mkdirSync(storageDir, { recursive: true })
  fs.writeFileSync(path.join(runbookDir, "runbook.mdx"), `# Iframes\n\n${blocks}<Iframe src="./assets/storage/index.html" title="Storage" />\n`)
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
      `<Iframe src="${SPOOF_URL}" title="AWS sign-in" />\n\n`,
  )
  const siteDir = path.join(runbookDir, "assets/site")
  fs.mkdirSync(siteDir, { recursive: true })
  fs.writeFileSync(path.join(runbookDir, "secret.txt"), "secret")
  fs.writeFileSync(path.join(siteDir, "index.html"), LOCAL_PAGE)
  fs.writeFileSync(path.join(siteDir, "style.css"), "h1 { color: rgb(37, 99, 235); }\n")
  fs.writeFileSync(path.join(siteDir, "app.js"), 'document.getElementById("status").textContent = "script ran"\n')
  writeRunbook("other", "")
})

test.afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** Open runbook `name`. Launches in one test share a user-data dir, and so their storage. */
async function launch(name = "runbook"): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    // --user-data-dir isolates the single-instance lock and trust state.
    args: [MAIN_ENTRY, `--user-data-dir=${path.join(tmpDir, "user-data")}`, path.join(tmpDir, name)],
    env: {
      ...process.env,
      ELECTRON_NO_UPDATER: "1",
      RUNBOOKS_NO_TELEMETRY: "1",
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

/** The frame that has loaded `url`, once it has. */
async function frameAt(page: Page, url: string | RegExp): Promise<Frame> {
  const matches = (f: Frame) => (typeof url === "string" ? f.url() === url : url.test(f.url()))
  await expect.poll(() => page.frames().some(matches)).toBe(true)
  return page.frames().find(matches)!
}

/** Whether a script in `frame` can read the app's preload API through `parent`. */
function canReachAppApi(frame: Frame): Promise<boolean> {
  return frame.evaluate(() => {
    try {
      return (window.parent as unknown as { api?: unknown }).api !== undefined
    } catch {
      return false
    }
  })
}

test.describe("Iframe block", () => {
  test("loads nothing until the user clicks Load", async () => {
    const { app, page } = await launch()
    try {
      await expect(page.getByRole("button", { name: "Load page" })).toHaveCount(5)
      expect(page.frames()).toHaveLength(1)
    } finally {
      await app.close()
    }
  })

  test("loads a page from the assets folder with its relative stylesheet and script", async () => {
    const { app, page } = await launch()
    try {
      await loadFrame(page, "Local")
      const local = page.frameLocator('iframe[title="Local"]')
      await expect(local.getByRole("heading", { name: "Local page" })).toHaveCSS("color", "rgb(37, 99, 235)")
      await expect(local.locator("#status")).toHaveText("script ran")

      // The runbook's own host, whose root is its assets/ folder.
      const frame = await frameAt(page, /^runbook-asset:\/\/r[0-9a-f]{32}\/site\/index\.html$/)
      expect(await canReachAppApi(frame)).toBe(false)
      // secret.txt sits in the runbook directory, next to runbook.mdx.
      const status = await frame.evaluate(async () => (await fetch("/..%2Fsecret.txt")).status)
      expect(status).toBe(403)
      // No allow-popups: window.open fails in the frame instead of reaching
      // the main process's window-open handler, which would open the URL in
      // the browser without a click.
      await app.evaluate(({ shell }) => {
        const opened: string[] = []
        Object.assign(globalThis, { opened })
        shell.openExternal = async (url) => void opened.push(url)
      })
      await frame.evaluate(() => window.open("https://example.com/"))
      expect(await app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened)).toEqual([])
    } finally {
      await app.close()
    }
  })

  test("loads plain-http pages on 127.0.0.1 and localhost", async () => {
    const { app, page } = await launch()
    try {
      await loadFrame(page, "External")
      await loadFrame(page, "Localhost")
      await expect(page.frameLocator('iframe[title="External"]').getByRole("heading", { name: "External page" })).toBeVisible()
      await expect(page.frameLocator('iframe[title="Localhost"]').getByRole("heading", { name: "External page" })).toBeVisible()

      expect(await canReachAppApi(await frameAt(page, serverUrl))).toBe(false)
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
        const text = page.frameLocator('iframe[title="Storage"]').locator("#seen")
        await expect(text).toHaveText(/./)
        return await text.textContent()
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
        return { first: charBox(0).left >= box.left, last: charBox(text.length - 1).right <= box.right + 0.5 }
      })
      // Cut from the start: …signin-verify-session-000….evil.example
      expect(inView).toEqual({ first: false, last: true })
    } finally {
      await app.close()
    }
  })

  // Checked from the app's own frame: a framed page's permissions.query reads
  // "denied" whether or not the handlers are installed, because the frame's
  // permissions policy answers first, while its getUserMedia still reaches
  // the request handler. Querying the app frame goes through the check
  // handler, where Electron's default answers "granted".
  test("the app's own frame gets clipboard writes and nothing else", async () => {
    const { app, page } = await launch()
    try {
      const query = (name: string) =>
        page.evaluate(async (n) => (await navigator.permissions.query({ name: n as PermissionName })).state, name)
      expect(await query("microphone")).toBe("denied")
      expect(await query("camera")).toBe("denied")
      expect(await query("geolocation")).toBe("denied")
      expect(await query("clipboard-write")).toBe("granted")
    } finally {
      await app.close()
    }
  })
})
