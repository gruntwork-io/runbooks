/**
 * Watch mode in the window, end to end: the old app's
 * electron/e2e/watch-mode.spec.ts, its 4th test as #682 patched it
 * (baseline/behaviour-changes/e2e-watch-mode.patch). The app's flags pick
 * the session's watch mode (packages/app-main/src/launch.ts): none
 * `notice`, `--watch` `runbookAndFiles`, and `--watch
 * --disable-live-file-reload` `runbook`.
 *
 * Each test writes a throwaway runbook in its own output folder, launches
 * the app on it with the flags, trusts it through the trust prompt, and
 * edits files on disk. Running a block after shows which text the session
 * runs: the runbook it reloaded, or a script file's text as the session
 * held it until it was reloaded from the block's "Script changed" notice.
 *
 * The old spec's 2nd test, which reads a script through "View Source
 * Code", lands with the window's source view.
 *
 * Runs against the build in app-out/: `just app-test-e2e` builds it first.
 */
import fs from "node:fs"
import path from "node:path"
import type { Locator, Page, TestInfo } from "@playwright/test"
import { expect, type Launched, type LaunchOptions, test } from "./fixtures.ts"

function runbook(heading: string, message: string): string {
  return `# ${heading}\n\n<Command id="greet" command="echo ${message}" />\n`
}

/** The runbook's folder, in the test's output folder, holding `files`. */
function runbookFolder(testInfo: TestInfo, files: Readonly<Record<string, string>>): string {
  const folder = testInfo.outputPath("runbook")
  fs.mkdirSync(folder, { recursive: true })
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(folder, name), text)
  return folder
}

/** Launches the app with `flags` on the runbook in `folder`, waits for it to render, and trusts it. */
async function launchOn(
  launch: (options?: LaunchOptions) => Promise<Launched>,
  flags: ReadonlyArray<string>,
  folder: string,
): Promise<Page> {
  const { page } = await launch({ args: [...flags, folder] })
  await expect(page.getByRole("heading", { name: "Before edit" })).toBeVisible()
  const prompt = page.getByRole("region", { name: "Trust this runbook" })
  await prompt.getByRole("button", { name: "I trust this runbook" }).click()
  await expect(prompt).toHaveCount(0)
  return page
}

/**
 * Edits runbook.mdx on disk and waits for the window to show the new
 * version. Writes again if the first write landed before the watch began.
 */
async function editRunbook(page: Page, file: string): Promise<void> {
  await expect(async () => {
    fs.writeFileSync(file, runbook("After edit", "watch-after"))
    await expect(page.getByRole("heading", { name: "After edit" })).toBeVisible({
      timeout: 2_000,
    })
  }).toPass({ timeout: 15_000 })
}

/** Runs greet and waits for it to be done. */
async function runGreet(page: Page): Promise<Locator> {
  const block = page.locator("#runbook-block-greet")
  await block.getByRole("button", { name: "Run" }).click()
  await expect(block.locator(".block-status")).toHaveText("Done", { timeout: 30_000 })
  return block
}

/** The log of a run that printed `line` alone. */
const printed = (line: string) => new RegExp(`^${line}\\n$`)

test.describe("Watch mode", () => {
  test("reloads the runbook and runs the edited command after runbook.mdx changes", async ({
    launch,
  }, testInfo) => {
    const folder = runbookFolder(testInfo, {
      "runbook.mdx": runbook("Before edit", "watch-before"),
    })
    const page = await launchOn(launch, ["--watch"], folder)
    await editRunbook(page, path.join(folder, "runbook.mdx"))

    const block = await runGreet(page)
    await expect(block.getByLabel("Log")).toHaveText(printed("watch-after"))
    await expect(block.getByRole("region", { name: "Script changed" })).toHaveCount(0)
  })

  for (const flags of [[], ["--watch", "--disable-live-file-reload"]]) {
    test(`a script edited on disk runs as loaded until it is reloaded from its block (flags: ${flags.join(" ") || "none"})`, async ({
      launch,
    }, testInfo) => {
      const folder = runbookFolder(testInfo, {
        "greet.sh": "#!/bin/bash\necho script-before\n",
        "runbook.mdx": `# Before edit\n\n<Command id="greet" path="greet.sh" />\n`,
      })
      const page = await launchOn(launch, flags, folder)
      const block = page.locator("#runbook-block-greet")
      const notice = block.getByRole("region", { name: "Script changed" })

      // Edit again if the first edit landed before the watch began.
      await expect(async () => {
        fs.writeFileSync(path.join(folder, "greet.sh"), "#!/bin/bash\necho script-after\n")
        await expect(notice).toBeVisible({ timeout: 2_000 })
      }).toPass({ timeout: 15_000 })
      const diff = block.getByTestId("script-change-diff")
      await expect(diff).toContainText("-echo script-before")
      await expect(diff).toContainText("+echo script-after")

      await runGreet(page)
      await expect(block.getByLabel("Log")).toHaveText(printed("script-before"))

      await block.getByRole("button", { name: "Reload script" }).click()
      await expect(notice).toHaveCount(0)

      await runGreet(page)
      await expect(block.getByLabel("Log")).toHaveText(printed("script-after"))
    })
  }

  test("--disable-live-file-reload reloads the runbook's inline commands too", async ({
    launch,
  }, testInfo) => {
    const folder = runbookFolder(testInfo, {
      "runbook.mdx": runbook("Before edit", "watch-before"),
    })
    const page = await launchOn(launch, ["--watch", "--disable-live-file-reload"], folder)
    await editRunbook(page, path.join(folder, "runbook.mdx"))

    const block = await runGreet(page)
    await expect(block.getByLabel("Log")).toHaveText(printed("watch-after"))
    await expect(block.getByRole("region", { name: "Script changed" })).toHaveCount(0)
  })
})
