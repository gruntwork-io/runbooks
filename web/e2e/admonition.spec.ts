import { test, expect, expectNoConsoleErrors } from "./fixtures"

/**
 * End-to-end test for markdown in an admonition's body, on the admonition
 * feature demo. App.css strips list markers from everything inside a block,
 * which jsdom can't show, so this checks the styles the app computes.
 */
test.describe("feature-demos/admonition", () => {
  test("shows the lists in an admonition's body with their bullets and numbers", async ({
    launchRunbook,
    consoleMessages,
  }) => {
    const page = await launchRunbook("testdata/feature-demos/admonition")
    await expect(page.getByTestId("runbook-content")).toBeVisible({ timeout: 15_000 })

    const admonition = page.locator(".runbook-block").filter({ hasText: "Before you begin" })
    const bullets = admonition.locator("ul")
    const numbers = admonition.locator("ol")
    await expect(bullets.getByRole("listitem")).toHaveText([
      "The AWS CLI",
      "OpenTofu v1.6 or later",
    ])
    await expect(bullets).toHaveCSS("list-style-type", "disc")
    await expect(numbers).toHaveCSS("list-style-type", "decimal")

    // The markers sit in the list's left padding, outside its text
    await expect(bullets).not.toHaveCSS("padding-left", "0px")
    await expect(numbers).not.toHaveCSS("padding-left", "0px")

    // The paragraph above each list keeps a gap below it
    await expect(admonition.getByText("You need:")).not.toHaveCSS("margin-bottom", "0px")

    expectNoConsoleErrors(consoleMessages)
  })
})
