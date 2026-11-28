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
 * The old spec's 2nd test runs here without its "View Source Code" steps,
 * which land with the window's source view. Two tests the old spec lacks
 * pin what a launch must not reload: a plain launch reloads no runbook
 * save, and `--disable-live-file-reload` reads no script file again.
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

/**
 * Writes `text` to the script `file` and waits until `block`'s notice shows
 * it on disk. Writes again if the first write landed before the watch began.
 * Once it shows, the watcher has taken every save before the write, since it
 * takes saves in order.
 */
async function editScript(block: Locator, file: string, text: string): Promise<void> {
  const diff = block.getByTestId("script-change-diff")
  await expect(async () => {
    fs.writeFileSync(file, `#!/bin/bash\necho ${text}\n`)
    await expect(diff).toContainText(`+echo ${text}`, { timeout: 2_000 })
  }).toPass({ timeout: 15_000 })
}

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

  test("with no flags, a runbook saved on disk isn't reloaded: the page and its runs keep the runbook opened", async ({
    launch,
  }, testInfo) => {
    const blocks = `<Command id="script" path="script.sh" />\n`
    const folder = runbookFolder(testInfo, {
      "script.sh": "#!/bin/bash\necho script-before\n",
      "runbook.mdx": `${runbook("Before edit", "watch-before")}\n${blocks}`,
    })
    const page = await launchOn(launch, [], folder)
    const script = page.locator("#runbook-block-script")
    const scriptFile = path.join(folder, "script.sh")
    await editScript(script, scriptFile, "script-watched")

    fs.writeFileSync(
      path.join(folder, "runbook.mdx"),
      `${runbook("After edit", "watch-after")}\n${blocks}`,
    )
    await editScript(script, scriptFile, "script-after")

    await expect(page.getByRole("heading", { name: "Before edit" })).toBeVisible()
    await expect(page.getByRole("heading", { name: "After edit" })).toHaveCount(0)
    const block = await runGreet(page)
    await expect(block.getByLabel("Log")).toHaveText(printed("watch-before"))
  })

  test("saving runbook.mdx unchanged after a script edit runs the edited script", async ({
    launch,
  }, testInfo) => {
    const folder = runbookFolder(testInfo, {
      "greet.sh": "#!/bin/bash\necho script-before\n",
      "runbook.mdx": `# Before edit\n\n<Command id="greet" path="greet.sh" />\n`,
    })
    const page = await launchOn(launch, ["--watch"], folder)
    const block = page.locator("#runbook-block-greet")
    await editScript(block, path.join(folder, "greet.sh"), "script-after")

    const file = path.join(folder, "runbook.mdx")
    fs.writeFileSync(file, fs.readFileSync(file))
    await expect(block.getByRole("region", { name: "Script changed" })).toHaveCount(0)
    await runGreet(page)
    await expect(block.getByLabel("Log")).toHaveText(printed("script-after"))
  })

  test("with --disable-live-file-reload, saving runbook.mdx unchanged keeps the script as the session read it", async ({
    launch,
  }, testInfo) => {
    const folder = runbookFolder(testInfo, {
      "greet.sh": "#!/bin/bash\necho script-before\n",
      "runbook.mdx": `# Before edit\n\n<Command id="greet" path="greet.sh" />\n`,
    })
    const page = await launchOn(launch, ["--watch", "--disable-live-file-reload"], folder)
    const block = page.locator("#runbook-block-greet")
    const scriptFile = path.join(folder, "greet.sh")
    await editScript(block, scriptFile, "script-after")

    const file = path.join(folder, "runbook.mdx")
    fs.writeFileSync(file, fs.readFileSync(file))
    await editScript(block, scriptFile, "script-later")

    await expect(block.getByTestId("script-change-diff")).toContainText("-echo script-before")
    await runGreet(page)
    await expect(block.getByLabel("Log")).toHaveText(printed("script-before"))
  })

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
