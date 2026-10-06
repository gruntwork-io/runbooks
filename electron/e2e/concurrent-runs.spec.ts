/**
 * Blocks run concurrently unless one has to wait for another: a block waits
 * for a running block whose outputs it uses, for the blocks its `dependsOn`
 * names, and for an `exclusive` block.
 *
 * Most scripts here block until a flag file exists, so the test decides how
 * long each run lasts.
 *
 * Prerequisites: run `electron-vite build` first (expects ./dist/main/index.js).
 *
 * Run with:
 *   bunx playwright test --config electron/e2e/playwright.config.ts concurrent-runs.spec.ts
 */
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page,
} from "@playwright/test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, "../..")
const MAIN_ENTRY = path.join(ROOT, "dist/main/index.js")

let app: ElectronApplication
let page: Page
let workDir: string

function flag(name: string): string {
  return path.join(workDir, `${name}.flag`)
}

/** A command that blocks until the flag file exists. */
function waitFor(name: string): string {
  return `while [ ! -f "${flag(name)}" ]; do sleep 0.1; done`
}

function runbookMdx(): string {
  return `# Concurrent runs

<Command id="waiter" title="Waiter" command='${waitFor("signal")}' />

<Command id="signaller" title="Signaller" command='touch "${flag("signal")}"' />

<Command id="stopped" title="Stopped" command='${waitFor("never")}' />

<Command id="survivor" title="Survivor" command='${waitFor("release")}' />

<Command id="producer" title="Producer" command='echo "value=1" >> "$RUNBOOK_OUTPUT"; ${waitFor("produced")}' />

<Command id="consumer" title="Consumer" command="echo {{ .outputs.producer.value }}" />

<Command id="first" title="First" command="true" />

<Command id="second" title="Second" dependsOn="first" command="true" />

<Command id="alone" title="Alone" exclusive command='${waitFor("alone")}' />

<Check id="bystander" title="Bystander" command="true" />
`
}

function block(id: string): Locator {
  return page.locator(`[data-testid="${id}"]`)
}

function icon(id: string, status: "running" | "success"): Locator {
  return block(id).locator(`[data-testid="icon-${status}"]`)
}

function runButton(id: string, name: "Run" | "Check" = "Run"): Locator {
  return block(id).getByRole("button", { name, exact: true })
}

function warning(id: string): Locator {
  return block(id).locator('[data-testid="run-blocked-warning"]')
}

async function run(id: string): Promise<void> {
  await block(id).scrollIntoViewIfNeeded()
  await runButton(id).click()
  await expect(icon(id, "running")).toBeVisible({ timeout: 10_000 })
}

test.beforeAll(async () => {
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-concurrent-e2e-")))
  const runbookDir = path.join(workDir, "runbook")
  const userDataDir = path.join(workDir, "user-data")
  fs.mkdirSync(runbookDir)
  fs.mkdirSync(userDataDir)
  fs.writeFileSync(path.join(runbookDir, "runbook.mdx"), runbookMdx())

  app = await electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`, runbookDir],
    env: {
      ...process.env,
      ELECTRON_NO_UPDATER: "1",
      RUNBOOKS_NO_TELEMETRY: "1",
    },
  })
  page = await app.firstWindow()
  await page.waitForLoadState("domcontentloaded")
  await page.waitForSelector("h1", { timeout: 60_000 })

  const trustButton = page.getByRole("button", { name: "I trust this Runbook" })
  if (await trustButton.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await trustButton.click()
    await expect(trustButton).not.toBeVisible({ timeout: 5_000 })
  }
})

test.afterAll(async () => {
  if (app) await app.close()
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true })
})

test.describe.configure({ mode: "serial" })

test("running a second block leaves the first block's script running", async () => {
  await run("waiter")

  await block("signaller").scrollIntoViewIfNeeded()
  await runButton("signaller").click()

  await expect(icon("signaller", "success")).toBeVisible({ timeout: 30_000 })
  await expect(icon("waiter", "success")).toBeVisible({ timeout: 30_000 })
})

test("stopping one block leaves another block's script running", async () => {
  await run("stopped")
  await run("survivor")

  await block("stopped").scrollIntoViewIfNeeded()
  await block("stopped").getByRole("button", { name: "Stop", exact: true }).click()
  await expect(icon("stopped", "running")).not.toBeVisible({ timeout: 10_000 })
  await expect(icon("survivor", "running")).toBeVisible()

  fs.writeFileSync(flag("release"), "")

  await expect(icon("survivor", "success")).toBeVisible({ timeout: 30_000 })
  await expect(icon("stopped", "success")).not.toBeVisible()
})

test("a block waits while the block whose outputs it uses runs again", async () => {
  fs.writeFileSync(flag("produced"), "")
  await block("producer").scrollIntoViewIfNeeded()
  await runButton("producer").click()
  await expect(icon("producer", "success")).toBeVisible({ timeout: 30_000 })
  await expect(runButton("consumer")).toBeEnabled()

  fs.rmSync(flag("produced"))
  await run("producer")

  await expect(runButton("consumer")).toBeDisabled()
  await expect(warning("consumer")).toContainText("Waiting for a running block: producer")

  await warning("consumer").getByRole("button", { name: "Stop producer" }).click()

  await expect(icon("producer", "running")).not.toBeVisible({ timeout: 10_000 })
  await expect(runButton("consumer")).toBeEnabled()
})

test("a block waits for the block its dependsOn names to succeed", async () => {
  await block("second").scrollIntoViewIfNeeded()
  await expect(runButton("second")).toBeDisabled()
  await expect(warning("second")).toContainText("Waiting for: first")

  await runButton("first").click()
  await expect(icon("first", "success")).toBeVisible({ timeout: 30_000 })

  await expect(warning("second")).not.toBeVisible()
  await runButton("second").click()
  await expect(icon("second", "success")).toBeVisible({ timeout: 30_000 })
})

test("no other block can start while an exclusive block runs", async () => {
  await run("alone")

  await block("bystander").scrollIntoViewIfNeeded()
  await expect(runButton("bystander", "Check")).toBeDisabled()
  await expect(warning("bystander")).toContainText("Waiting for a running block: alone")

  fs.writeFileSync(flag("alone"), "")

  await expect(icon("alone", "success")).toBeVisible({ timeout: 30_000 })
  await expect(runButton("bystander", "Check")).toBeEnabled()
})
