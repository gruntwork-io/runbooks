import { test, expect, expectNoConsoleErrors, trustRunbook } from "./fixtures"

/**
 * End-to-end test for the <Chapter> block, on the chapters feature demo.
 *
 * Runs the first chapter's blocks, moves to the next chapter, and runs a
 * command there that reads an output of the first chapter's command, as
 * chapters only change what's on screen, not how blocks reference each other.
 */
test.describe("feature-demos/chapters", () => {
  test("moves between chapters, whose blocks use each other's outputs", async ({
    launchRunbook,
    consoleMessages,
  }) => {
    const page = await launchRunbook("testdata/feature-demos/chapters")
    await expect(page.getByTestId("runbook-content")).toBeVisible({ timeout: 15_000 })
    await trustRunbook(page)

    const bar = page.getByRole("navigation", { name: "Chapters" })
    await expect(bar).toContainText("Chapter 1 of 3 · Set up")
    await expect(page.getByRole("heading", { name: "Deploy the app" })).toBeHidden()

    await page.getByTestId("app").getByRole("button", { name: "Submit" }).click()
    const prepare = page.getByTestId("prepare")
    await expect(prepare.getByRole("button", { name: "Run" })).toBeEnabled({ timeout: 10_000 })
    await prepare.getByRole("button", { name: "Run" }).click()
    await expect(prepare.getByTestId("icon-success")).toBeVisible({ timeout: 15_000 })

    // The table of contents counts each chapter's steps.
    await bar.getByRole("button", { name: "Contents" }).click()
    await expect(page.getByRole("menuitem")).toHaveText([
      /Set up\s*2\/2/,
      /Deploy\s*0\/1/,
      /Verify\s*0\/2/,
    ])
    await page.keyboard.press("Escape")

    await page
      .getByRole("navigation", { name: "Chapter pages" })
      .getByRole("button", { name: /Deploy/ })
      .click()
    await expect(bar).toContainText("Chapter 2 of 3 · Deploy")
    await expect(page.getByRole("heading", { name: "Name the app" })).toBeHidden()

    // The deploy command reads the workspace the Set up chapter's command wrote.
    const deploy = page.getByTestId("deploy")
    await expect(deploy).toContainText("Deploying hello-world from /tmp/hello-world")
    await deploy.getByRole("button", { name: "Run" }).click()
    await expect(deploy.getByTestId("icon-success")).toBeVisible({ timeout: 15_000 })

    await expect(page.getByTestId("mdx-error")).not.toBeVisible()
    expectNoConsoleErrors(consoleMessages)
  })
})
