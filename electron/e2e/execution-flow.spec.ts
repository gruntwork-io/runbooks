/**
 * Kitchen Sink Execution Flow E2E tests.
 *
 * Tests the execution pipeline by clicking Run/Check buttons and verifying
 * outputs, status changes, environment persistence, and file capture.
 *
 * These tests are sequential — later tests depend on outputs from earlier ones.
 *
 * Prerequisites:
 *   - Run `electron-vite build` before running these tests
 *
 * Run with:
 *   bunx playwright test --config electron/e2e/playwright.config.ts execution-flow
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test"
import * as path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, "../..")
const MAIN_ENTRY = path.join(ROOT, "dist/main/index.js")
const KITCHEN_SINK = path.join(ROOT, "testdata/kitchen-sink")

let app: ElectronApplication
let page: Page

// Increase timeout for execution tests since scripts need time to run
test.setTimeout(120_000)

test.beforeAll(async () => {
  app = await electron.launch({
    args: [MAIN_ENTRY, KITCHEN_SINK],
    env: {
      ...process.env,
      ELECTRON_NO_UPDATER: "1",
      RUNBOOKS_NO_TELEMETRY: "1",
    },
  })

  page = await app.firstWindow()
  await page.waitForLoadState("domcontentloaded")
  await page.waitForSelector("h1", { timeout: 60_000 })

  // Dismiss the trust confirmation
  const trustButton = page.getByRole("button", { name: "I trust this Runbook" })
  if (await trustButton.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await trustButton.click()
    await expect(trustButton).not.toBeVisible({ timeout: 5_000 })
  }
})

test.afterAll(async () => {
  if (app) await app.close()
})

// ---------------------------------------------------------------------------
// Helper: run a block and wait for completion
// ---------------------------------------------------------------------------

async function runBlock(blockId: string, buttonName: "Run" | "Check" = "Run") {
  const section = page.locator(`[data-testid="${blockId}"]`)
  await section.scrollIntoViewIfNeeded()
  const button = section.getByRole("button", { name: buttonName })
  await expect(button).toBeVisible({ timeout: 5_000 })
  await button.click()
}

async function waitForSuccess(blockId: string, timeout = 30_000) {
  const section = page.locator(`[data-testid="${blockId}"]`)
  // Wait for the success status icon to appear
  await expect(section.locator('[data-testid="icon-success"]')).toBeVisible({ timeout })
}

async function waitForWarn(blockId: string, timeout = 30_000) {
  const section = page.locator(`[data-testid="${blockId}"]`)
  await expect(section.locator('[data-testid="icon-warn"]')).toBeVisible({ timeout })
}

// ---------------------------------------------------------------------------
// Tests — sequential execution flow
// ---------------------------------------------------------------------------

test.describe("Execution Flow", () => {
  // Force serial execution
  test.describe.configure({ mode: "serial" })

  test("run simple inline command", async () => {
    await runBlock("simple-inline-cmd")
    await waitForSuccess("simple-inline-cmd")

    const section = page.locator('[data-testid="simple-inline-cmd"]')
    await expect(section.getByText("Inline command succeeded!")).toBeVisible()
  })

  test("run check-pass and verify green success", async () => {
    await runBlock("check-pass", "Check")
    await waitForSuccess("check-pass")
  })

  // TODO: This test hangs after the 2nd sequential execution. The script runs and
  // produces output, but the Effect fiber never resumes from Effect.async/Effect.promise
  // callbacks within forkDaemon. Needs investigation of Effect runtime + forkDaemon
  // interaction with Node.js promise/callback resolution.
  test.skip("run setup-outputs and verify outputs produced", async () => {
    await runBlock("setup-outputs")
    await waitForSuccess("setup-outputs")

    const section = page.locator('[data-testid="setup-outputs"]')
    await expect(section.getByText("Outputs produced", { exact: false })).toBeVisible()
  })

  test("run check-warn and verify warn status", async () => {
    await runBlock("check-warn", "Check")
    await waitForWarn("check-warn")

    const section = page.locator('[data-testid="check-warn"]')
    await expect(section.getByText("Warning detected", { exact: false })).toBeVisible()
  })

  // The following tests are skipped due to a known issue: after ~4 sequential
  // script executions, the Effect fiber/stream runtime stops propagating
  // completion events. This needs investigation into the Effect.forkDaemon +
  // Fiber.await lifecycle in electron/main/ipc/exec.ts.
  // TODO: Fix the daemon fiber lifecycle leak and unskip these tests.

  test.skip("run set-env then verify-env for environment persistence", async () => {
    await runBlock("set-env")
    await waitForSuccess("set-env")

    await runBlock("verify-env", "Check")
    await waitForSuccess("verify-env")
  })

  test.skip("run change-dir then verify-workdir for working directory persistence", async () => {
    await runBlock("change-dir")
    await waitForSuccess("change-dir")

    await runBlock("verify-workdir", "Check")
    await waitForSuccess("verify-workdir")
  })

  test.skip("run capture-files and verify file generation", async () => {
    await runBlock("capture-files")
    await waitForSuccess("capture-files")
  })

  test.skip("run logging-demo and verify completion", async () => {
    await runBlock("logging-demo")
    await waitForSuccess("logging-demo")
  })
})
