import { test, expect, expectNoConsoleErrors, trustRunbook } from "./fixtures"

/**
 * End-to-end test for entering an output by hand, on the script-env feature
 * demo: print-title's env reads fetch-title's title, which the user can give
 * the block themselves, run with, and reset.
 */
test.describe("feature-demos/script-env", () => {
  test("runs a block with an output entered by hand, then goes back to the output", async ({
    launchRunbook,
    consoleMessages,
  }) => {
    const page = await launchRunbook("testdata/feature-demos/script-env")
    await expect(page.getByTestId("runbook-content")).toBeVisible({ timeout: 15_000 })
    await trustRunbook(page)

    const block = page.getByTestId("print-title")
    const env = block.getByTestId("print-title-env")
    const check = block.getByRole("button", { name: "Check", exact: true })

    // Before fetch-title runs, the chip names the output the block waits for
    const waiting = env.getByRole("button", { name: /^fetch_title\.title: Waiting for/ })
    await expect(waiting).toHaveText("fetch_title.title")
    await expect(check).toBeDisabled()

    // Clicking it puts a field in its place
    await waiting.click()
    const field = env.getByLabel("Value for fetch_title.title")
    await expect(field).toBeFocused()
    await field.fill("Typed by hand")
    await field.press("Enter")

    await expect(field).toHaveValue("Typed by hand")
    await expect(field).toHaveAttribute("data-state", "entered")
    await expect(check).toBeEnabled({ timeout: 10_000 })
    await check.click()
    await expect(block.getByTestId("icon-success")).toBeVisible({ timeout: 15_000 })
    await expect(block.getByText("Title: Typed by hand")).toBeVisible()

    // Reset goes back to waiting for fetch-title, then to its output
    await env.getByRole("button", { name: "Reset fetch_title.title" }).click()
    await expect(waiting).toBeVisible()
    await expect(check).toBeDisabled()

    const fetch = page.getByTestId("fetch-title")
    await fetch.getByRole("button", { name: "Run" }).click()
    await expect(fetch.getByTestId("icon-success")).toBeVisible({ timeout: 15_000 })
    await expect(env.getByRole("button", { name: /^fetch_title\.title: Fix typo/ })).toBeVisible()
    await expect(check).toBeEnabled({ timeout: 10_000 })

    expectNoConsoleErrors(consoleMessages)
  })
})
