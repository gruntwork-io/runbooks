import type { Locator } from "@playwright/test"
import { test, expect, expectNoConsoleErrors, trustRunbook } from "./fixtures"

/**
 * End-to-end test for the <Prerequisites> block, on the prerequisites feature
 * demo: the check fails, the demo installs the missing tools, and the check
 * warns, as only the optional tool is missing. The block keeps space for what
 * each state shows, so it never changes size and its tools never move.
 */
test.describe("feature-demos/prerequisites", () => {
  test("keeps its size, and its tools in place, as checks run and end", async ({
    launchRunbook,
    consoleMessages,
  }) => {
    const page = await launchRunbook("testdata/feature-demos/prerequisites")
    await expect(page.getByTestId("runbook-content")).toBeVisible({ timeout: 15_000 })
    await trustRunbook(page)

    const block = page.getByTestId("tools")
    await recordLayouts(block)

    await block.getByRole("button", { name: "Check", exact: true }).click()
    await expect(block.getByTestId("icon-fail")).toBeVisible({ timeout: 15_000 })
    await expect(block.getByTestId("tool-runbooks-demo-tool")).toContainText("Not found on PATH.")

    const install = page.getByTestId("install-demo-tools")
    await install.getByRole("button", { name: "Run" }).click()
    await expect(install.getByTestId("icon-success")).toBeVisible({ timeout: 15_000 })

    await block.getByRole("button", { name: "Check again" }).click()
    await expect(block.getByTestId("icon-warn")).toBeVisible({ timeout: 15_000 })
    await expect(block.getByTestId("tool-runbooks-demo-tool")).toContainText("1.2.3 at ")

    const layouts = await block.evaluate(() => window.layouts)
    expect(layouts).toEqual([layouts[0]])

    expectNoConsoleErrors(consoleMessages)
  })
})

interface Layout {
  height: number
  /** Each tool's offset from the top of the block. */
  tools: Record<string, number>
}

declare global {
  interface Window {
    layouts: Layout[]
  }
}

/**
 * Records each layout the block takes from now on, in `window.layouts`: its
 * height, and where each of its tools is in it.
 */
async function recordLayouts(block: Locator) {
  await block.evaluate((el) => {
    window.layouts = []
    const record = () => {
      const box = el.getBoundingClientRect()
      const layout: Layout = {
        height: box.height,
        tools: Object.fromEntries(
          Array.from(el.querySelectorAll<HTMLElement>('[data-testid^="tool-"]'), (tool) => [
            tool.dataset.testid,
            tool.getBoundingClientRect().top - box.top,
          ]),
        ),
      }
      if (JSON.stringify(layout) !== JSON.stringify(window.layouts.at(-1))) {
        window.layouts.push(layout)
      }
    }
    record()
    new MutationObserver(record).observe(el, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    })
  })
}
