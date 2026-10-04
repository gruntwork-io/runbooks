/**
 * E2E tests for messaging between the Iframe block and a page it embeds from
 * the runbook's assets folder, in the built app.
 *
 * The page runs in a `<webview>` guest, whose preload relays the messages
 * (electron/preload/embed-relay.ts), and jsdom has neither. These check that
 * a page using the documented protocol reaches the runbook: it receives the
 * Inputs values, the output it sets reaches the runbook, and a frame inside
 * the page can't set outputs.
 *
 * Prerequisites: run `electron-vite build` first (expects ./dist/main/index.js).
 *
 * Run with:
 *   bunx playwright test --config electron/e2e/playwright.config.ts 'iframe-messaging'
 */
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { fileURLToPath } from "url"
import { inGuest } from "./webview-guests.ts"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, "../..")
const MAIN_ENTRY = path.join(ROOT, "dist/main/index.js")

const RUNBOOK = `# Messaging

<Inputs id="cfg">
\`\`\`yaml
variables:
  - name: greeting
    type: string
    default: hello
\`\`\`
</Inputs>

<Iframe id="picker" src="./assets/picker.html" title="Picker" inputsId="cfg" outputs={["region", "zone"]} />
`

// Shows the inputs it receives, asks for them once, and sets an output on
// click, as the Iframe docs describe. It also frames nested.html.
const PICKER_PAGE = `<!doctype html>
<p id="inputs">none</p>
<button id="send" type="button">Send region</button>
<iframe src="./nested.html"></iframe>
<script>
  window.addEventListener("message", (event) => {
    if (event.source !== parent) return
    if (event.data && event.data.type === "runbooks:inputs") {
      document.getElementById("inputs").textContent = JSON.stringify(event.data.inputs)
    }
  })
  parent.postMessage({ type: "runbooks:get-inputs" }, "*")
  document.getElementById("send").addEventListener("click", () => {
    parent.postMessage({ type: "runbooks:set-outputs", outputs: { region: "eu-west-1" } }, "*")
  })
</script>
`

// A frame inside the picker page that tries to set an output through it.
const NESTED_PAGE = `<!doctype html>
<script>
  parent.postMessage({ type: "runbooks:set-outputs", outputs: { zone: "nested" } }, "*")
  parent.nestedPosted = true
</script>
`

const PICKER_URL = /^runbook-asset:\/\/r[0-9a-f]{32}\/picker\.html$/

let tmpDir: string

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-iframe-messaging-e2e-"))
  const runbookDir = path.join(tmpDir, "runbook")
  fs.mkdirSync(path.join(runbookDir, "assets"), { recursive: true })
  fs.writeFileSync(path.join(runbookDir, "runbook.mdx"), RUNBOOK)
  fs.writeFileSync(path.join(runbookDir, "assets/picker.html"), PICKER_PAGE)
  fs.writeFileSync(path.join(runbookDir, "assets/nested.html"), NESTED_PAGE)
})

test.afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    // --user-data-dir isolates the single-instance lock and trust state.
    args: [
      MAIN_ENTRY,
      `--user-data-dir=${path.join(tmpDir, "user-data")}`,
      path.join(tmpDir, "runbook"),
    ],
    env: {
      ...process.env,
      ELECTRON_NO_UPDATER: "1",
      RUNBOOKS_NO_TELEMETRY: "1",
    },
  })
  const page = await app.firstWindow()
  await page.waitForLoadState("domcontentloaded")
  await expect(page.getByRole("heading", { name: "Messaging" })).toBeVisible({ timeout: 60_000 })
  await page.getByRole("button", { name: "Load page" }).click()
  return { app, page }
}

/** The picker page's #inputs text. */
const shownInputs = (app: ElectronApplication) =>
  inGuest<string>(app, PICKER_URL, `document.getElementById("inputs").textContent`)

test.describe("Iframe messaging", () => {
  test("the page receives the Inputs values, and again when they change", async () => {
    const { app, page } = await launch()
    try {
      await expect.poll(() => shownInputs(app)).toBe('{"greeting":"hello"}')

      // A standalone Inputs block publishes edits once it has been submitted.
      await page.getByRole("textbox", { name: /greeting/i }).fill("bonjour")
      await page.getByRole("button", { name: "Submit" }).click()

      await expect.poll(() => shownInputs(app)).toBe('{"greeting":"bonjour"}')
    } finally {
      await app.close()
    }
  })

  test("an output the page sets becomes the block's output, and a frame inside it sets none", async () => {
    const { app, page } = await launch()
    try {
      // The nested frame posts first, so had it got through, its output
      // would be there before the page's.
      await expect.poll(() => inGuest(app, PICKER_URL, "window.nestedPosted === true")).toBe(true)
      await inGuest(app, PICKER_URL, `document.getElementById("send").click()`)

      await page.getByRole("button", { name: "View Outputs (1)" }).click()
      await expect(page.getByRole("cell", { name: "region", exact: true })).toBeVisible()
      await expect(page.getByText("eu-west-1")).toBeVisible()
      await expect(page.getByText("nested")).toHaveCount(0)
    } finally {
      await app.close()
    }
  })
})
