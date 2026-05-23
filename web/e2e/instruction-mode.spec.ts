import { test, expect, trustRunbook, deleteFilesIfPrompted } from "./fixtures";

/**
 * End-to-end test for instruction mode (spec §10).
 *
 * Toggles the global Instruction mode setting on a real runbook and verifies the
 * interactive blocks are replaced by copy-pasteable instructions: the action
 * buttons disappear, the banner appears, and the command is shown for copying.
 */
test.describe("instruction mode", () => {
  test("toggling instruction mode flattens interactive blocks", async ({ launchRunbook }) => {
    const page = await launchRunbook("testdata/sample-runbooks/my-first-runbook");
    await trustRunbook(page);
    await deleteFilesIfPrompted(page);

    const markdownBody = page.getByTestId("runbook-content");
    await expect(markdownBody).toBeVisible({ timeout: 15_000 });

    // Interactive baseline: the Command block has a Run button, and no banner.
    const interactiveCommand = page.getByTestId("run-setup");
    await expect(interactiveCommand).toBeVisible();
    await expect(interactiveCommand.getByRole("button", { name: /^Run$/ })).toBeVisible();
    await expect(page.getByTestId("instruction-mode-banner")).not.toBeVisible();

    // Turn instruction mode on via the Menu (same surface as the theme control).
    await page.getByRole("button", { name: /Menu/ }).click();
    await page.getByRole("menuitemcheckbox", { name: /Instruction mode/ }).click();

    // The banner appears and the Command block is now an instruction with no Run.
    await expect(page.getByTestId("instruction-mode-banner")).toBeVisible();
    const flattened = page.getByTestId("instruction-run-setup");
    await expect(flattened).toBeVisible();
    await expect(flattened.getByRole("button", { name: /^Run$/ })).toHaveCount(0);

    // The interactive variant is gone.
    await expect(page.getByTestId("run-setup")).toHaveCount(0);

    // Marking the step done highlights the block green (data-completed).
    await expect(flattened).not.toHaveAttribute("data-completed", "true");
    await flattened.getByRole("button", { name: /Mark step as done/ }).click();
    await expect(flattened).toHaveAttribute("data-completed", "true");
  });
});
