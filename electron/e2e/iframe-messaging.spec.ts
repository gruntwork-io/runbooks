/**
 * E2E tests for messaging between the Iframe block and a page it frames from
 * the runbook's assets folder, in the built app.
 *
 * jsdom can't give a frame a runbook-asset:// origin, so these are
 * what check that the block's origin checks match the browser's: the page
 * receives the Inputs values, and the output it sets reaches the runbook.
 *
 * Prerequisites: run `electron-vite build` first (expects ./dist/main/index.js).
 *
 * Run with:
 *   bunx playwright test --config electron/e2e/playwright.config.ts 'iframe-messaging'
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { fileURLToPath } from "url"

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

<Iframe id="picker" src="./assets/picker.html" title="Picker" inputsId="cfg" outputs={["region"]} />
`

// Shows the inputs it receives, asks for them once, and sets an output on click.
const PICKER_PAGE = `<!doctype html>
<p id="inputs">none</p>
<button id="send" type="button">Send region</button>
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

let tmpDir: string

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-iframe-messaging-e2e-"))
  const runbookDir = path.join(tmpDir, "runbook")
  fs.mkdirSync(path.join(runbookDir, "assets"), { recursive: true })
  fs.writeFileSync(path.join(runbookDir, "runbook.mdx"), RUNBOOK)
  fs.writeFileSync(path.join(runbookDir, "assets/picker.html"), PICKER_PAGE)
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
  await expect(page.getByRole("heading", { name: "Messaging" })).toBeVisible({ timeout: 60_000 })
  await page.getByRole("button", { name: "Load page" }).click()
  return { app, page }
}

test.describe("Iframe messaging", () => {
  test("the page receives the Inputs values, and again when they change", async () => {
    const { app, page } = await launch()
    try {
      const frame = page.frameLocator('iframe[title="Picker"]')
      await expect(frame.locator("#inputs")).toHaveText('{"greeting":"hello"}')

      // A standalone Inputs block publishes edits once it has been submitted.
      await page.getByRole("textbox", { name: /greeting/i }).fill("bonjour")
      await page.getByRole("button", { name: "Submit" }).click()

      await expect(frame.locator("#inputs")).toHaveText('{"greeting":"bonjour"}')
    } finally {
      await app.close()
    }
  })

  test("an output the page sets becomes the block's output", async () => {
    const { app, page } = await launch()
    try {
      await page.frameLocator('iframe[title="Picker"]').getByRole("button", { name: "Send region" }).click()

      await page.getByRole("button", { name: "View Outputs (1)" }).click()
      await expect(page.getByRole("cell", { name: "region" })).toBeVisible()
      await expect(page.getByText("eu-west-1")).toBeVisible()
    } finally {
      await app.close()
    }
  })
})
