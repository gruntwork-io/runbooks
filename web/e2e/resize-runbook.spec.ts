import { test, expect, expectNoConsoleErrors, drag, showFiles } from "./fixtures"

/**
 * End-to-end test for the handle between the runbook and the files workspace.
 *
 * Runs in the real window, as the widths come from its layout: the runbook
 * follows the dragged handle, the width persists across a reload, and a
 * double-click puts back the width the layout gives the runbook itself.
 */
test.describe("runbook resize handle", () => {
  test("drags the runbook's width beside the files workspace", async ({
    launchRunbook,
    consoleMessages,
  }) => {
    const page = await launchRunbook("testdata/sample-runbooks/my-first-runbook")
    const runbook = page.getByTestId("runbook-content")
    const handle = page.getByRole("separator", { name: "Resize the runbook" })
    const width = async () => (await runbook.boundingBox())?.width

    await showFiles(page)
    const defaultWidth = (await width()) ?? 0
    expect(defaultWidth).toBeGreaterThan(0)

    await drag(page, handle, 120)
    await expect.poll(width).toBeCloseTo(defaultWidth + 120, 0)

    // The arrow keys move a focused handle.
    await handle.focus()
    await page.keyboard.press("ArrowLeft")
    await expect.poll(width).toBeCloseTo(defaultWidth + 104, 0)

    // A click doesn't change the width.
    await handle.click()
    await expect.poll(width).toBeCloseTo(defaultWidth + 104, 0)

    // The runbook can't be dragged narrower than 400px.
    await drag(page, handle, -1000)
    await expect.poll(width).toBe(400)

    // The dragged width comes back after a reload.
    await drag(page, handle, 50)
    await page.reload()
    await showFiles(page)
    expect(await width()).toBeCloseTo(450, 0)

    // Double-clicking the handle puts back the default width.
    await handle.dblclick()
    await expect.poll(width).toBeCloseTo(defaultWidth, 0)

    await page.reload()
    await showFiles(page)
    expect(await width()).toBeCloseTo(defaultWidth, 0)

    expectNoConsoleErrors(consoleMessages)
  })
})
