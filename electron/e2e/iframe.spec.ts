/**
 * E2E tests for the Iframe block in the built app, where the production CSP
 * applies (electron/main/csp.ts).
 *
 * Opens a throwaway runbook that frames a page from its assets/ folder, whose
 * stylesheet and script load through relative paths, and a page served by a
 * local HTTP server. Also checks what a framed page cannot do: load before
 * the user clicks, or read runbook files outside assets/. Also checks the
 * session's permission handlers (electron/main/permissions.ts) with
 * navigator.permissions.query, which never raises an OS prompt.
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

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-iframe-e2e-"))
  const runbookDir = path.join(tmpDir, "runbook")
  const siteDir = path.join(runbookDir, "assets/site")
  fs.mkdirSync(siteDir, { recursive: true })
  fs.writeFileSync(
    path.join(runbookDir, "runbook.mdx"),
    `# Iframes\n\n<Iframe src="./assets/site/index.html" title="Local" />\n\n<Iframe src="${serverUrl}" title="External" />\n\n` +
      `<Iframe src="${serverUrl.replace("127.0.0.1", "localhost")}" title="Localhost" />\n`,
  )
  fs.writeFileSync(path.join(runbookDir, "secret.txt"), "secret")
  fs.writeFileSync(path.join(siteDir, "index.html"), LOCAL_PAGE)
  fs.writeFileSync(path.join(siteDir, "style.css"), "h1 { color: rgb(37, 99, 235); }\n")
  fs.writeFileSync(path.join(siteDir, "app.js"), 'document.getElementById("status").textContent = "script ran"\n')
})

test.afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    // --user-data-dir isolates the single-instance lock and trust state.
    args: [MAIN_ENTRY, `--user-data-dir=${path.join(tmpDir, "user-data")}`, path.join(tmpDir, "runbook")],
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
async function frameAt(page: Page, url: string): Promise<Frame> {
  await expect.poll(() => page.frames().some((f) => f.url() === url)).toBe(true)
  return page.frames().find((f) => f.url() === url)!
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
      await expect(page.getByRole("button", { name: "Load page" })).toHaveCount(3)
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

      const frame = await frameAt(page, "runbook-asset://assets/site/index.html")
      expect(await canReachAppApi(frame)).toBe(false)
      // secret.txt sits in the runbook directory, next to runbook.mdx.
      const status = await frame.evaluate(async () => (await fetch("runbook-asset://assets/..%2Fsecret.txt")).status)
      expect(status).toBe(403)
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
