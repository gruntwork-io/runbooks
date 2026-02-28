import { test, expect, expectNoConsoleErrors } from "./fixtures";

/**
 * Phase 1: Smoke-test 2 representative runbooks to validate the Playwright
 * infrastructure. Phase 2 will expand to cover all testdata/ runbooks.
 *
 * Each test starts a fresh server, loads the runbook in a real browser, and
 * verifies the MDX content renders without crashing.
 */

// ---------------------------------------------------------------------------
// Test: markdown-only-simple (pure .md, no MDX blocks)
// ---------------------------------------------------------------------------
test.describe("sample-runbooks/markdown-only-simple", () => {
  test("renders markdown content", async ({ page, startServer, consoleMessages }) => {
    await startServer("testdata/sample-runbooks/markdown-only-simple");
    await page.goto("/");

    // Wait for the markdown body to appear (MDXContainer wraps content in .markdown-body).
    const markdownBody = page.locator(".markdown-body");
    await expect(markdownBody).toBeVisible({ timeout: 15_000 });

    // Verify the H1 heading matches the runbook title.
    await expect(page.locator("h1")).toHaveText("Markdown Examples");

    // Verify some representative markdown elements rendered.
    await expect(page.locator("h2").first()).toBeVisible();
    await expect(page.locator("strong").first()).toBeVisible();

    // No error boundary should be visible.
    await expect(page.getByTestId("mdx-error")).not.toBeVisible();

    expectNoConsoleErrors(consoleMessages);
  });
});

// ---------------------------------------------------------------------------
// Test: my-first-runbook (MDX with Check, Command, Template, Inputs blocks)
// ---------------------------------------------------------------------------
test.describe("sample-runbooks/my-first-runbook", () => {
  test("renders MDX content with blocks", async ({ page, startServer, consoleMessages }) => {
    await startServer("testdata/sample-runbooks/my-first-runbook");
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

// ---------------------------------------------------------------------------
// Test: demo3 — template rendering should not show errors
// ---------------------------------------------------------------------------
test.describe("sample-runbooks/demo3", () => {
  test("renders templates without errors", async ({ page, startServer, consoleMessages }) => {
    await startServer("testdata/sample-runbooks/demo3");
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

  test("runs a command and shows success", async ({ page, startServer, consoleMessages }) => {
    await startServer("testdata/sample-runbooks/demo3");
    await page.goto("/");

    const markdownBody = page.locator(".markdown-body");
    await expect(markdownBody).toBeVisible({ timeout: 15_000 });

    // Dismiss the trust banner so command execution is allowed.
    await page.getByText("I trust this Runbook").click();

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
