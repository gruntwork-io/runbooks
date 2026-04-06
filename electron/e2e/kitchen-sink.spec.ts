/**
 * Kitchen Sink E2E tests.
 *
 * Launches the Electron app with the testdata/kitchen-sink runbook and verifies
 * that all major features work end-to-end: markdown rendering, inputs, commands,
 * checks, templates, and the executable registry.
 *
 * Prerequisites:
 *   - Run `electron-vite build` before running these tests
 *
 * Run with:
 *   bunx playwright test --config electron/e2e/playwright.config.ts kitchen-sink
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test"
import * as path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, "../..")
const MAIN_ENTRY = path.join(ROOT, "dist/main/index.js")
const KITCHEN_SINK = path.join(ROOT, "testdata/kitchen-sink")

// Shared state for the test suite — we launch the app once and reuse it.
let app: ElectronApplication
let page: Page

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

  // Wait for the runbook MDX content to compile and render.
  // The kitchen sink runbook is large (600+ lines, many components) so
  // MDX compilation can take a while.
  await page.waitForSelector("h1", { timeout: 60_000 })
})

test.afterAll(async () => {
  if (app) await app.close()
})

// ---------------------------------------------------------------------------
// 1. Markdown Rendering
// ---------------------------------------------------------------------------

test.describe("Markdown Rendering", () => {
  test("renders the runbook title", async () => {
    const heading = page.locator("h1").first()
    await expect(heading).toContainText("Kitchen Sink Test Runbook")
  })

  test("renders text formatting", async () => {
    await expect(page.locator("strong").first()).toBeVisible()
    await expect(page.locator("em").first()).toBeVisible()
    await expect(page.locator("del").first()).toBeVisible()
  })

  test("renders code blocks", async () => {
    // Should have at least the Go, Python, and Bash code blocks
    const codeBlocks = page.locator("pre code")
    await expect(codeBlocks.first()).toBeVisible()
    expect(await codeBlocks.count()).toBeGreaterThanOrEqual(3)
  })

  test("renders tables", async () => {
    const table = page.locator("table").first()
    await expect(table).toBeVisible()
    await expect(table).toContainText("Markdown")
  })

  test("renders blockquotes", async () => {
    const quote = page.locator("blockquote").first()
    await expect(quote).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// 2. Admonitions
// ---------------------------------------------------------------------------

test.describe("Admonitions", () => {
  test("renders all admonition types", async () => {
    // Look for the admonition titles
    await expect(page.getByText("This is a note admonition", { exact: false })).toBeVisible()
    await expect(page.getByText("This is an info admonition", { exact: false })).toBeVisible()
    await expect(page.getByText("This is a warning admonition", { exact: false })).toBeVisible()
    await expect(page.getByText("This is a danger admonition", { exact: false })).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// 3. Inputs
// ---------------------------------------------------------------------------

test.describe("Inputs", () => {
  test("renders the all-types inputs form", async () => {
    // The inputs block should have fields for different types
    await expect(page.getByText("A plain string with a default")).toBeVisible()
    await expect(page.getByText("An integer input")).toBeVisible()
    await expect(page.getByText("A boolean toggle")).toBeVisible()
    await expect(page.getByText("Pick an environment")).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// 4. Commands — No "Executable not found" errors
// ---------------------------------------------------------------------------

test.describe("Commands", () => {
  test("no executable-not-found errors are visible", async () => {
    // The key regression: inline commands should not show
    // "Executable not found for component" errors
    const errorElements = page.getByText("Executable not found", { exact: false })
    await expect(errorElements).toHaveCount(0)
  })

  test("renders the simple inline command", async () => {
    await expect(page.getByText("Simple Inline Command")).toBeVisible()
    await expect(page.getByText("Tests the simplest possible command")).toBeVisible()
  })

  test("renders the script-based command", async () => {
    await expect(page.getByText("Setup Block Outputs")).toBeVisible()
  })

  test("inline command has a Run button", async () => {
    // Find the simple inline command section and its Run button
    const cmdSection = page.locator('[data-testid="simple-inline-cmd"]')
    const runButton = cmdSection.getByRole("button", { name: "Run" })
    await expect(runButton).toBeVisible()
  })

  test("can execute the simple inline command to completion", async () => {
    // Dismiss the trust confirmation if it appears
    const trustButton = page.getByRole("button", { name: "I trust this Runbook" })
    if (await trustButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await trustButton.click()
      await expect(trustButton).not.toBeVisible({ timeout: 5_000 })
    }

    const cmdSection = page.locator('[data-testid="simple-inline-cmd"]')
    await cmdSection.scrollIntoViewIfNeeded()
    const runButton = cmdSection.getByRole("button", { name: "Run" })
    await runButton.click()

    // Wait for the command to complete with a success message
    await expect(cmdSection.getByText("succeeded", { exact: false })).toBeVisible({
      timeout: 15_000,
    })
  })
})

// ---------------------------------------------------------------------------
// 5. No path-related errors
// ---------------------------------------------------------------------------

test.describe("Path Resolution", () => {
  test("no 'Path outside allowed directories' errors", async () => {
    const errors = page.getByText("Path outside allowed directories", { exact: false })
    await expect(errors).toHaveCount(0)
  })

  test("no 'path is outside session working directory' errors", async () => {
    const errors = page.getByText("path is outside session working directory", { exact: false })
    await expect(errors).toHaveCount(0)
  })

  test("script-based commands load without errors", async () => {
    // Script commands should show their script content, not file-read errors
    const cmdSection = page.locator('[data-testid="setup-outputs"]')
    await expect(cmdSection).toBeVisible()
    const errorInSection = cmdSection.getByText("Error", { exact: false })
    // Allow "Error" in description text but not error banners
    const errorBanners = cmdSection.locator(".bg-red-50")
    await expect(errorBanners).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------
// 6. Checks
// ---------------------------------------------------------------------------

test.describe("Check Blocks", () => {
  test("renders check blocks", async () => {
    await expect(page.getByText("Check That Passes")).toBeVisible()
    await expect(page.getByText("Check That Warns")).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// 7. Templates
// ---------------------------------------------------------------------------

test.describe("Templates", () => {
  test("template section heading renders", async () => {
    // Verify the template sections exist in the rendered MDX
    const heading = page.getByText("8. Template Block", { exact: false })
    await heading.scrollIntoViewIfNeeded()
    await expect(heading).toBeVisible()
  })

  test("template inline section heading renders", async () => {
    const heading = page.getByText("9. TemplateInline", { exact: false })
    await heading.scrollIntoViewIfNeeded()
    await expect(heading).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// 8. Error Summary Banner
// ---------------------------------------------------------------------------

test.describe("Error Summary Banner", () => {
  test("no path-related or executable errors remain", async () => {
    // Scroll to top to check for the banner
    await page.evaluate(() => window.scrollTo(0, 0))

    // These critical errors should never appear
    await expect(page.getByText("Path outside allowed directories", { exact: false })).toHaveCount(0)
    await expect(page.getByText("Executable not found", { exact: false })).toHaveCount(0)
    await expect(page.getByText("path is outside session working directory", { exact: false })).toHaveCount(0)
  })
})
