/**
 * The trust prompt as the window shows it over the engine: what trusting
 * the runbook lets each block do, and trust taking effect through the
 * session's events, each block's frame then offering what it takes.
 *
 * Runs against the build in app-out/: `just app-test-e2e` builds it first.
 * The engine's hash is always the one the window shows, so the changed
 * runbook case is the fake main's (packages/app-renderer/src/trust.test.ts).
 */
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "./fixtures.ts"

const runbook = (name: string) => path.join(import.meta.dirname, "runbooks", name)

test.describe("the trust prompt", () => {
  test("lists a Command's effects, and once trusted the Command is Ready and offers Run, having run nothing", async ({
    launch,
    userDataDir,
  }) => {
    const { page } = await launch({ args: [runbook("walk")] })
    const prompt = page.getByRole("region", { name: "Trust this runbook" })
    const block = page.getByRole("region", { name: "<Command> block" })
    await expect(prompt.getByRole("listitem")).toHaveText([
      "<Command> setup (Literal title) may run commands and scripts on this computer.",
    ])
    await expect(block.getByText("Waiting for you to trust this runbook.")).toBeVisible()

    await prompt.getByRole("button", { name: "I trust this runbook" }).click()
    await expect(prompt).toHaveCount(0)
    await expect(block.locator(".block-status")).toHaveText("Ready")
    await expect(block.getByRole("button", { name: "Run" })).toBeVisible()
    await expect(block.getByText("Waiting for you to trust this runbook.")).toHaveCount(0)

    // Trusting runs no block: the script would leave this file in the session's working folder.
    const ran = fs
      .readdirSync(userDataDir, { recursive: true, encoding: "utf8" })
      .filter((file) => path.basename(file) === "ran-on-open")
    expect(ran).toEqual([])
  })

  test("is not shown in instruction mode, where nothing runs", async ({ launch }) => {
    const { page } = await launch({ args: [runbook("walk")], settings: { instructionMode: true } })
    // The instruction comes with the block's first read, and the session's trust with it.
    await expect(page.getByText("Run this command:")).toBeVisible()
    await expect(page.getByRole("region", { name: "Trust this runbook" })).toHaveCount(0)
  })

  test("stays on top of a fixed element the runbook styles to cover the window", async ({
    launch,
  }) => {
    const { page } = await launch({ args: [runbook("trust-overlay")] })
    await expect(page.getByText("An overlay that would cover the trust prompt.")).toBeVisible()
    const button = page
      .getByRole("region", { name: "Trust this runbook" })
      .getByRole("button", { name: "I trust this runbook" })
    await expect(button).toBeVisible()
    const hit = await button.evaluate((element) => {
      const { x, y, width, height } = element.getBoundingClientRect()
      const under = document.elementFromPoint(x + width / 2, y + height / 2)
      return element === under ? "the button" : (under?.textContent ?? "nothing")
    })
    expect(hit).toBe("the button")
  })
})
