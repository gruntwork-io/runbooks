/**
 * A block's frame as the window draws it from the engine: its step mark,
 * its status as the engine has it, and what it waits for, each block it
 * waits for a link that scrolls to it. In instruction mode, set in the
 * settings file, a task's command to copy in place of its view.
 *
 * Runs against the build in app-out/: `just app-test-e2e` builds it first.
 * No test here trusts its runbook, so every session is untrusted
 * (trust.spec.ts trusts one).
 */
import path from "node:path"
import { expect, test } from "./fixtures.ts"

const runbook = (name: string) => path.join(import.meta.dirname, "runbooks", name)

test.describe("a block's frame", () => {
  test("shows a Command's step mark, and that it waits for trust, with no Run", async ({
    launch,
  }) => {
    const { page } = await launch({ args: [runbook("walk")] })
    const block = page.getByRole("region", { name: "<Command> block" })
    await expect(block.getByRole("img", { name: "Step: not done" })).toBeVisible()
    await expect(block.getByText("Waiting for you to trust this runbook.")).toBeVisible()
    await expect(block.getByRole("button", { name: "Run" })).toHaveCount(0)
  })

  test("says which block a Command waits for, and its link scrolls to that block", async ({
    launch,
  }) => {
    const { page } = await launch({ args: [runbook("waiting")] })
    const deploy = page.locator("#runbook-block-deploy")
    const build = page.locator("#runbook-block-build")
    const link = deploy.getByRole("link", { name: "build" })
    await expect(deploy.getByText("Waiting for:")).toBeVisible()
    await expect(link).toHaveAttribute("href", "#runbook-block-build")
    await expect(build).not.toBeInViewport()
    await link.click()
    await expect(build).toBeInViewport()
  })

  test("shows a Command's command to copy in instruction mode, says the mode is on, and offers no Run", async ({
    launch,
  }) => {
    const { page } = await launch({ args: [runbook("walk")], settings: { instructionMode: true } })
    await expect(
      page.getByText(
        "Instruction mode: nothing here runs automatically. Each step shows the exact command to copy and run yourself.",
      ),
    ).toBeVisible()
    const block = page.getByRole("region", { name: "<Command> block" })
    await expect(block.getByText("Run this command:")).toBeVisible()
    await expect(block.locator(".block-command code")).toHaveText("touch ran-on-open")
    await expect(block.locator(".block-command")).toHaveCSS("user-select", "all")
    await expect(block.getByText("Waiting for you to trust this runbook.")).toHaveCount(0)
    await expect(block.getByRole("button", { name: "Run" })).toHaveCount(0)
  })
})
