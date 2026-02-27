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
