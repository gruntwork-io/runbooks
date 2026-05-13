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

// Collect console errors during the entire test suite
const consoleErrors: string[] = []

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

  // Capture console errors for the duration of the test suite
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text())
    }
  })

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

  test("renders lists", async () => {
    // Unordered
    const ul = page.locator("ul").first()
    await expect(ul).toBeVisible()
    // Ordered
    const ol = page.locator("ol").first()
    await expect(ol).toBeVisible()
  })

  test("renders links", async () => {
    await expect(page.getByText("Runbooks Documentation")).toBeVisible()
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

  test("danger admonition has confirmation button", async () => {
    await expect(page.getByText("I understand the risks")).toBeVisible()
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

  test("all-types form has default values pre-populated", async () => {
    const allTypesBlock = page.locator('[data-testid="all-types"]')
    await allTypesBlock.scrollIntoViewIfNeeded()

    // String default
    const plainString = allTypesBlock.locator('[data-testid="field-plain_string"] input')
    await expect(plainString).toHaveValue("hello world")

    // Integer default
    const intField = allTypesBlock.locator('[data-testid="field-int_field"] input')
    await expect(intField).toHaveValue("42")

    // Email default
    const emailField = allTypesBlock.locator('[data-testid="field-email_field"] input')
    await expect(emailField).toHaveValue("user@example.com")
  })

  test("sensitive field is masked", async () => {
    const allTypesBlock = page.locator('[data-testid="all-types"]')
    const secretField = allTypesBlock.locator('[data-testid="field-secret_field"] input')
    await expect(secretField).toHaveAttribute("type", "password")
  })

  test("renders merging inputs blocks", async () => {
    await expect(page.locator('[data-testid="defaults-merge"]')).toBeVisible()
    await expect(page.locator('[data-testid="overrides-merge"]')).toBeVisible()
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

  test("renders the command with inputsId", async () => {
    await expect(page.locator('[data-testid="cmd-with-inputs"]')).toBeVisible()
  })

  test("renders the consume-outputs command", async () => {
    await expect(page.locator('[data-testid="consume-outputs"]')).toBeVisible()
  })

  test("renders the inline-inputs command with nested form", async () => {
    const section = page.locator('[data-testid="cmd-inline-inputs"]')
    await expect(section).toBeVisible()
    // Should have the nested Inputs form rendered
    await expect(page.locator('[data-testid="inline-cmd-vars"]')).toBeVisible()
  })

  test("inline command has a Run button", async () => {
    // Find the simple inline command section and its Run button
    const cmdSection = page.locator('[data-testid="simple-inline-cmd"]')
    const runButton = cmdSection.getByRole("button", { name: "Run" })
    await expect(runButton).toBeVisible()
  })

  test("renders complex outputs command", async () => {
    await expect(page.locator('[data-testid="list-complex-data"]')).toBeVisible()
    await expect(page.getByText("Produce Complex Outputs")).toBeVisible()
  })

  test("renders merged-inputs command", async () => {
    await expect(page.locator('[data-testid="merged-inputs-cmd"]')).toBeVisible()
    await expect(page.getByText("Merged Inputs")).toBeVisible()
  })

  test("renders expression-test command", async () => {
    await expect(page.locator('[data-testid="expr-test"]')).toBeVisible()
  })

  test("renders all environment and workdir commands", async () => {
    await expect(page.locator('[data-testid="set-env"]')).toBeVisible()
    await expect(page.locator('[data-testid="change-dir"]')).toBeVisible()
    await expect(page.locator('[data-testid="capture-files"]')).toBeVisible()
    await expect(page.locator('[data-testid="logging-demo"]')).toBeVisible()
  })

  test("auth-gated commands are visible", async () => {
    await expect(page.locator('[data-testid="aws-cmd"]')).toBeVisible()
    await expect(page.locator('[data-testid="gh-cmd"]')).toBeVisible()
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

  test("check blocks have Check buttons", async () => {
    const checkPass = page.locator('[data-testid="check-pass"]')
    await checkPass.scrollIntoViewIfNeeded()
    await expect(checkPass.getByRole("button", { name: "Check" })).toBeVisible()

    const checkWarn = page.locator('[data-testid="check-warn"]')
    await checkWarn.scrollIntoViewIfNeeded()
    await expect(checkWarn.getByRole("button", { name: "Check" })).toBeVisible()
  })

  test("parameterized check renders with inline form", async () => {
    const section = page.locator('[data-testid="check-with-inputs"]')
    await expect(section).toBeVisible()
    await expect(page.locator('[data-testid="check-tool-inputs"]')).toBeVisible()
  })

  test("expression check renders", async () => {
    await expect(page.locator('[data-testid="expr-check"]')).toBeVisible()
  })

  test("verify-env check renders", async () => {
    await expect(page.locator('[data-testid="verify-env"]')).toBeVisible()
  })

  test("verify-workdir check renders", async () => {
    await expect(page.locator('[data-testid="verify-workdir"]')).toBeVisible()
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

  test("template block renders", async () => {
    const tpl = page.locator('[data-testid="sample-config"]')
    await tpl.scrollIntoViewIfNeeded()
    await expect(tpl).toBeVisible()
  })

  test("template inline section heading renders", async () => {
    const heading = page.getByText("9. TemplateInline", { exact: false })
    await heading.scrollIntoViewIfNeeded()
    await expect(heading).toBeVisible()
  })

  test("all template inline blocks render", async () => {
    await expect(page.locator('[data-testid="simple-inline-tpl"]')).toBeVisible()
    await expect(page.locator('[data-testid="output-preview"]')).toBeVisible()
    await expect(page.locator('[data-testid="gen-file-tpl"]')).toBeVisible()
    await expect(page.locator('[data-testid="combined-tpl"]')).toBeVisible()
  })

  test("template inline blocks show no errors", async () => {
    for (const id of ["simple-inline-tpl", "output-preview", "gen-file-tpl", "combined-tpl"]) {
      const block = page.locator(`[data-testid="${id}"]`)
      const errorBanner = block.locator(".bg-red-50")
      await expect(errorBanner).toHaveCount(0)
    }
  })
})

// ---------------------------------------------------------------------------
// 8. Auth Blocks
// ---------------------------------------------------------------------------

test.describe("Auth Blocks", () => {
  test("AwsAuth block renders", async () => {
    const block = page.locator('[data-testid="aws-auth-test"]')
    await block.scrollIntoViewIfNeeded()
    await expect(block).toBeVisible()
    await expect(page.getByText("AWS Authentication (Optional)")).toBeVisible()
  })

  test("GitHubAuth block renders", async () => {
    const block = page.locator('[data-testid="gh-auth-test"]')
    await block.scrollIntoViewIfNeeded()
    await expect(block).toBeVisible()
    await expect(page.getByText("GitHub Authentication (Optional)")).toBeVisible()
  })

  test("AwsAuth block has no errors", async () => {
    const block = page.locator('[data-testid="aws-auth-test"]')
    const errorBanner = block.locator(".bg-red-50")
    await expect(errorBanner).toHaveCount(0)
  })

  test("GitHubAuth block has no errors", async () => {
    const block = page.locator('[data-testid="gh-auth-test"]')
    const errorBanner = block.locator(".bg-red-50")
    await expect(errorBanner).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------
// 9. GitClone
// ---------------------------------------------------------------------------

test.describe("GitClone Block", () => {
  test("renders with prefilled URL", async () => {
    const block = page.locator('[data-testid="clone-test"]')
    await block.scrollIntoViewIfNeeded()
    await expect(block).toBeVisible()
    // Scope to the block to avoid matching hint text elsewhere
    await expect(block.getByText("Clone a Repository")).toBeVisible()
  })

  test("has no errors", async () => {
    const block = page.locator('[data-testid="clone-test"]')
    const errorBanner = block.locator(".bg-red-50")
    await expect(errorBanner).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------
// 10. GitHubPullRequest
// ---------------------------------------------------------------------------

test.describe("GitHubPullRequest Block", () => {
  test("renders", async () => {
    const block = page.locator('[data-testid="pr-test"]')
    await block.scrollIntoViewIfNeeded()
    await expect(block).toBeVisible()
    await expect(page.getByText("Create a Pull Request")).toBeVisible()
  })

  test("has no errors", async () => {
    const block = page.locator('[data-testid="pr-test"]')
    const errorBanner = block.locator(".bg-red-50")
    await expect(errorBanner).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------
// 11. DirPicker
// ---------------------------------------------------------------------------

test.describe("DirPicker Block", () => {
  test("renders with labels", async () => {
    const block = page.locator('[data-testid="dir-picker-test"]')
    await block.scrollIntoViewIfNeeded()
    await expect(block).toBeVisible()
    await expect(page.getByText("Pick a Directory")).toBeVisible()
  })

  test("has no errors", async () => {
    const block = page.locator('[data-testid="dir-picker-test"]')
    const errorBanner = block.locator(".bg-red-50")
    await expect(errorBanner).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------
// 12. All Blocks Present (comprehensive check)
// ---------------------------------------------------------------------------

test.describe("All Blocks Present", () => {
  // Every block ID from the kitchen-sink runbook
  const allBlockIds = [
    // Inputs
    "all-types",
    "defaults-merge",
    "overrides-merge",
    "inline-cmd-vars",
    "check-tool-inputs",
    // Commands
    "simple-inline-cmd",
    "setup-outputs",
    "cmd-with-inputs",
    "consume-outputs",
    "cmd-inline-inputs",
    "list-complex-data",
    "set-env",
    "change-dir",
    "capture-files",
    "logging-demo",
    "merged-inputs-cmd",
    "aws-cmd",
    "gh-cmd",
    "expr-test",
    // Checks
    "check-pass",
    "check-warn",
    "check-with-inputs",
    "verify-env",
    "verify-workdir",
    "expr-check",
    // Templates
    "sample-config",
    "simple-inline-tpl",
    "output-preview",
    "gen-file-tpl",
    "combined-tpl",
    // TemplateInline complex data
    "users-list",
    "teams-list",
    // Auth
    "aws-auth-test",
    "gh-auth-test",
    // Git
    "clone-test",
    "pr-test",
    // DirPicker
    "dir-picker-test",
  ]

  for (const id of allBlockIds) {
    test(`block "${id}" is present`, async () => {
      const block = page.locator(`[data-testid="${id}"]`)
      await expect(block).toBeAttached()
    })
  }
})

// ---------------------------------------------------------------------------
// 13. No Errors (comprehensive)
// ---------------------------------------------------------------------------

test.describe("Error-Free Rendering", () => {
  test("no 'Executable not found' errors", async () => {
    await expect(page.getByText("Executable not found", { exact: false })).toHaveCount(0)
  })

  test("no 'Path outside allowed directories' errors", async () => {
    await expect(page.getByText("Path outside allowed directories", { exact: false })).toHaveCount(0)
  })

  test("no 'path is outside session working directory' errors", async () => {
    await expect(page.getByText("path is outside session working directory", { exact: false })).toHaveCount(0)
  })

  test("no MDX compilation errors", async () => {
    await expect(page.locator('[data-testid="mdx-error"]')).toHaveCount(0)
  })

  test("no inline error banners across any block", async () => {
    // Error display components use a specific test ID pattern
    const errorDisplays = page.locator('[data-testid^="error-"]')
    await expect(errorDisplays).toHaveCount(0)
  })

  test("error summary banner shows zero issues", async () => {
    // Scroll to top to check for the banner
    await page.evaluate(() => window.scrollTo(0, 0))
    // The banner only renders when there are errors/warnings.
    // If it's not present at all, that means 0 issues — which is the happy path.
    const banner = page.getByText("This runbook has issues:", { exact: false })
    await expect(banner).toHaveCount(0)
  })

  test("no console errors during rendering", async () => {
    // Filter out known non-critical errors (e.g., favicon 404, CSP for external images)
    const critical = consoleErrors.filter(
      (err) =>
        !err.includes("favicon") &&
        !err.includes("DevTools") &&
        !err.includes("Electron Security Warning") &&
        !err.includes("Content Security Policy"),
    )
    expect(critical).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 14. Command Execution (smoke test)
// ---------------------------------------------------------------------------

test.describe("Command Execution", () => {
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
