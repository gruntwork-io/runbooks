import { test, expect, expectNoConsoleErrors, trustRunbook } from "./fixtures"

/**
 * End-to-end test for entering a value in place of a linked default's chip,
 * on the template-defaults feature demo: an Inputs field waiting on a script's
 * output, and a Template field whose value another field links to.
 */
test.describe("feature-demos/template-defaults", () => {
  test("enters values in place of chips, and resets them", async ({
    launchRunbook,
    consoleMessages,
  }) => {
    const page = await launchRunbook("testdata/feature-demos/template-defaults")
    await expect(page.getByTestId("runbook-content")).toBeVisible({ timeout: 15_000 })
    await trustRunbook(page)

    // Before create-account runs, the chip names the output the field waits for
    const alias = page.getByTestId("account").getByTestId("field-AccountAlias")
    const waiting = alias.getByRole("button", { name: /^create_account\.account_id: Waiting for/ })
    await expect(waiting).toHaveText("create_account.account_id")

    // Clicking it puts a field in its place
    await waiting.click()
    const field = alias.getByLabel("Value for create_account.account_id")
    await expect(field).toBeFocused()
    await field.fill("111111111111")
    await field.press("Enter")
    await expect(field).toHaveValue("111111111111")
    await expect(field).toHaveAttribute("data-state", "entered")

    // Reset goes back to waiting for create-account
    await alias.getByRole("button", { name: "Reset create_account.account_id" }).click()
    await expect(waiting).toBeVisible()

    // In the Template, a value entered for Bucket Name's chip is what Replica
    // Bucket, linked to Bucket Name, comes to
    const template = page.getByTestId("linked-defaults")
    const bucket = template.getByTestId("field-BucketName")
    const replica = template.getByTestId("field-ReplicaBucket")
    await expect(replica).toContainText("acme-state", { timeout: 10_000 })
    await bucket.getByRole("button", { name: "Project Name: acme" }).click()
    await bucket.getByLabel("Value for Project Name").fill("globex")
    await bucket.getByLabel("Value for Project Name").press("Enter")
    await expect(replica).toContainText("globex-state", { timeout: 10_000 })

    await bucket.getByRole("button", { name: "Reset Project Name" }).click()
    await expect(bucket.getByRole("button", { name: "Project Name: acme" })).toBeVisible()
    await expect(replica).toContainText("acme-state", { timeout: 10_000 })

    // Cleared for a value of the user's own, Bucket Name resets to its default
    const resetBucket = template.getByRole("button", { name: "Reset Bucket Name to its default" })
    await expect(resetBucket).toHaveCount(0)
    await bucket.getByRole("button", { name: "Clear linked value" }).click()
    await bucket.getByRole("textbox").fill("my-bucket")
    await expect(replica).toContainText("my-bucket", { timeout: 10_000 })
    await resetBucket.click()
    await expect(bucket.getByRole("button", { name: "Project Name: acme" })).toBeVisible()
    await expect(replica).toContainText("acme-state", { timeout: 10_000 })
    await expect(resetBucket).toHaveCount(0)

    expectNoConsoleErrors(consoleMessages)
  })
})
