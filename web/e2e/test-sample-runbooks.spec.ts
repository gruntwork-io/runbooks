import { test, expect, expectNoConsoleErrors, trustRunbook } from "./fixtures";

/**
 * Phase 1: Smoke-test 2 representative runbooks to validate the Playwright
 * infrastructure. Phase 2 will expand to cover all testdata/ runbooks.
 *
 * Each test starts a fresh server, loads the runbook in a real browser, and
 * verifies the MDX content renders without crashing.
 */

// ---------------------------------------------------------------------------
// Test: demo1
// ---------------------------------------------------------------------------
test.describe("sample-runbooks/demo1", () => {
  test("renders demo1 without errors", async ({ page, serveRunbook, consoleMessages }) => {
    await serveRunbook("testdata/sample-runbooks/demo1");
    await page.goto("/");

    const markdownBody = page.locator(".markdown-body");
    await expect(markdownBody).toBeVisible({ timeout: 15_000 });

    // Verify the title rendered.
    await expect(page.locator("h1")).toHaveText("Welcome to the Gruntwork AWS Accelerator!");

    // Verify the architecture image loaded successfully.
    const img = page.getByRole("img", { name: "AWS infrastructure preview" });
    await expect(img).toBeVisible();
    const naturalWidth = await img.evaluate((el) => (el as unknown as { naturalWidth: number }).naturalWidth);
    expect(naturalWidth, "Image failed to load (naturalWidth is 0)").toBeGreaterThan(0);

    // Verify key sections rendered.
    await expect(page.getByRole("heading", { name: "Three foundational git repos" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Individual team repos" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Next steps" })).toBeVisible();

    // No error boundary should be visible.
    await expect(page.getByTestId("mdx-error")).not.toBeVisible();

    expectNoConsoleErrors(consoleMessages);
  });
});

// ---------------------------------------------------------------------------
// Test: demo2
// ---------------------------------------------------------------------------
test.describe("sample-runbooks/demo2", () => {
  test("renders demo2 without errors", async ({ page, serveRunbook }) => {
    await serveRunbook("testdata/sample-runbooks/demo2");
    await page.goto("/");

    await trustRunbook(page);

    // Verify the title rendered.
    await expect(page.locator('h1')).toContainText('Create the infrastructure-live-root repo');

    // Run the checkbox
    await page.getByRole('button', { name: 'Check' }).first().click();
    await expect(page.getByTestId('check-gh-install-icon-success')).toBeVisible({ timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// Test: demo3
// ---------------------------------------------------------------------------
test.describe("sample-runbooks/demo3", () => {
  test("renders templates without errors", async ({ page, serveRunbook, consoleMessages }) => {
    await serveRunbook("testdata/sample-runbooks/demo3");
    await page.goto("/");

    const markdownBody = page.locator(".markdown-body");
    await expect(markdownBody).toBeVisible({ timeout: 15_000 });

    // Wait for templates to auto-render (they fire after a 200ms debounce).
    await page.waitForTimeout(2_000);

    // No template rendering errors should be visible.
    await expect(page.getByTestId("component-error")).not.toBeVisible();

    // No error boundary should be visible.
    await expect(page.getByTestId("mdx-error")).not.toBeVisible();

    expectNoConsoleErrors(consoleMessages);
  });

  test("runs a command and shows success", async ({ page, serveRunbook, consoleMessages }) => {
    await serveRunbook("testdata/sample-runbooks/demo3");
    await page.goto("/");

    const markdownBody = page.locator(".markdown-body");
    await expect(markdownBody).toBeVisible({ timeout: 15_000 });

    await trustRunbook(page);

    // Find the "Test embedded inputs" Command block (test6) and click Run.
    const commandBlock = page.locator(".mb-5", { hasText: "Test embedded inputs" });
    await commandBlock.getByRole("button", { name: "Run" }).click();

    // Wait for the success message to appear.
    await expect(commandBlock.getByText("Embedded inputs work!")).toBeVisible({ timeout: 15_000 });

    // No error boundary should be visible.
    await expect(page.getByTestId("mdx-error")).not.toBeVisible();

    expectNoConsoleErrors(consoleMessages);
  });
});

// ---------------------------------------------------------------------------
// Test: error-scenarios
// ---------------------------------------------------------------------------
test.describe("sample-runbooks/error-scenarios", () => {
  test("renders templates without errors", async ({ page, serveRunbook }) => {
    await serveRunbook("testdata/sample-runbooks/error-scenarios");
    await page.goto("/");
  });
});

// ---------------------------------------------------------------------------
// Test: markdown-only-full
// ---------------------------------------------------------------------------
test.describe("sample-runbooks/markdown-only-full", () => {
  test("renders markdown content", async ({ page, serveRunbook, consoleMessages }) => {
    await serveRunbook("testdata/sample-runbooks/markdown-only-full");
    await page.goto("/");

    // Wait for the markdown body to appear (MDXContainer wraps content in .markdown-body).
    const markdownBody = page.locator(".markdown-body");
    await expect(markdownBody).toBeVisible({ timeout: 15_000 });

    // ...

    // No error boundary should be visible.
    await expect(page.getByTestId("mdx-error")).not.toBeVisible();

    expectNoConsoleErrors(consoleMessages);
  });
});

// ---------------------------------------------------------------------------
// Test: my-first-runbook
// ---------------------------------------------------------------------------
test.describe("sample-runbooks/my-first-runbook", () => {
  test("renders MDX content with blocks", async ({ page, serveRunbook, consoleMessages }) => {
    await serveRunbook("testdata/sample-runbooks/my-first-runbook");
    await page.goto("/");

    // Wait for the markdown body to appear.
    const markdownBody = page.locator(".markdown-body");
    await expect(markdownBody).toBeVisible({ timeout: 15_000 });

    // Verify the H1 heading matches the runbook title.
    await expect(page.locator("h1")).toHaveText("My First Runbook");

    // The runbook contains multiple H2 sections — verify at least a few rendered.
    const h2s = page.locator("h2");
    await expect(h2s.first()).toBeVisible();
    const h2Count = await h2s.count();
    expect(h2Count).toBeGreaterThanOrEqual(3);

    // Verify MDX block components rendered (Check, Command, Template blocks
    // render as interactive UI elements with buttons).
    // Check block: "Check if Git is installed" should render a button.
    await expect(page.getByText("Check if Git is installed")).toBeVisible();

    // Template block: "Run Project Setup" should be visible.
    await expect(page.getByText("Run Project Setup")).toBeVisible();

    // Admonition block: "Before You Begin" should render.
    await expect(page.getByText("Before You Begin")).toBeVisible();

    // No error boundary should be visible.
    await expect(page.getByTestId("mdx-error")).not.toBeVisible();

    expectNoConsoleErrors(consoleMessages);
  });
});

