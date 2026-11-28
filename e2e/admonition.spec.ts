/**
 * Admonition in the window, end to end: each of Admonition's test runbooks
 * (blocks/admonition/testdata) opened in place, as a person reads it. Each
 * note draws all of itself, in its type's colors, and closing or confirming
 * takes all of it off the page until the runbook opens again. Confirmed
 * with "Don't show me this again" ticked, it stays hidden when the runbook
 * opens again, in that runbook only: the settings file keeps the hide.
 *
 * The old app's Admonition checks run on the `types` runbook:
 * electron/e2e/kitchen-sink.spec.ts ("renders all admonition types",
 * "danger admonition has confirmation button"), web/e2e/admonition.spec.ts
 * ("shows the lists in an admonition's body with their bullets and
 * numbers") and electron/e2e/long-paths.spec.ts's admonition (a long path
 * wraps inside its box).
 *
 * Runs against the build in app-out/: `just app-test-e2e` builds it first.
 */
import fs from "node:fs"
import path from "node:path"
import type { Page } from "@playwright/test"
import { expect, test } from "./fixtures.ts"

const testdata = (name: string) =>
  fs.realpathSync(path.join(import.meta.dirname, "..", "blocks", "admonition", "testdata", name))

/** The note of the block with id `id`. */
const noteOf = (page: Page, id: string) => page.locator(`#runbook-block-${id}`).getByRole("note")

/** The hides the settings file in `userDataDir` holds, once it holds any. */
const hiddenIn = (userDataDir: string): unknown => {
  const file = path.join(userDataDir, "settings.json")
  if (!fs.existsSync(file)) return undefined
  const saved = JSON.parse(fs.readFileSync(file, "utf8")) as {
    readonly settings?: { readonly hiddenInRunbooks?: unknown }
  }
  return saved.settings?.hiddenInRunbooks
}

test.describe("Admonition in the window", () => {
  test("types: each type a note named for it, in its own colors, with no frame around it", async ({
    launch,
  }) => {
    const { page } = await launch({ args: [testdata("types")] })

    // kitchen-sink: renders all admonition types.
    for (const text of [
      "This is a note admonition",
      "This is an info admonition",
      "This is a warning admonition",
      "This is a danger admonition",
    ])
      await expect(page.getByText(text, { exact: false })).toBeVisible()

    await expect(noteOf(page, "a_note")).toHaveAccessibleName("Note")
    await expect(noteOf(page, "an_info")).toHaveAccessibleName("Info")
    await expect(noteOf(page, "a_warning")).toHaveAccessibleName("Warning")
    await expect(noteOf(page, "a_danger")).toHaveAccessibleName("Danger")
    await expect(noteOf(page, "a_warning")).toContainText("A warning")
    // The frame draws no header around a note: its view draws all of it.
    await expect(page.locator("#runbook-block-a_note .block-header")).toHaveCount(0)
    await expect(page.locator("#runbook-block-a_note .block-tag")).toHaveCount(0)

    // Each type's box has its own background, from the view's Tailwind classes.
    const backgrounds = await Promise.all(
      ["a_note", "an_info", "a_warning", "a_danger"].map((id) =>
        noteOf(page, id).evaluate((element) => getComputedStyle(element).backgroundColor),
      ),
    )
    expect(backgrounds).not.toContain("rgba(0, 0, 0, 0)")
    expect(new Set(backgrounds).size).toBe(4)

    // An untitled note is headed by its type's name, and its markdown shows under its description.
    const untitled = noteOf(page, "untitled")
    await expect(untitled.locator("p").first()).toHaveText("Info")
    await expect(untitled).toContainText("Billing applies.")
    await expect(untitled.locator("strong")).toHaveText("pricing")
    await expect(page.getByText("A note without an id.")).toBeVisible()

    // web/e2e/admonition.spec.ts: the lists in its markdown keep their bullets and numbers.
    const bullets = untitled.locator("ul")
    const numbers = untitled.locator("ol")
    await expect(bullets.getByRole("listitem")).toHaveText([
      "The AWS CLI",
      "OpenTofu v1.6 or later",
    ])
    await expect(bullets).toHaveCSS("list-style-type", "disc")
    await expect(numbers).toHaveCSS("list-style-type", "decimal")
    await expect(bullets).not.toHaveCSS("padding-left", "0px")
    await expect(numbers).not.toHaveCSS("padding-left", "0px")
    await expect(untitled.getByText("You need:")).not.toHaveCSS("margin-bottom", "0px")

    // long-paths.spec.ts: a long path wraps inside its note, which stays inside the runbook.
    const long = noteOf(page, "long_path")
    await expect(long).toContainText("/very/long/path/")
    const fits = await long.evaluate((element) => {
      const box = element.getBoundingClientRect()
      const column = element.closest(".runbook-body")?.getBoundingClientRect()
      return {
        inside: element.scrollWidth <= element.clientWidth,
        within: column !== undefined && box.right <= column.right + 0.5,
      }
    })
    expect(fits).toEqual({ inside: true, within: true })

    // kitchen-sink: danger admonition has confirmation button.
    await expect(page.getByRole("button", { name: "I understand the risks" })).toBeVisible()
  })

  test("types: closing or confirming takes the whole note off the page, until the runbook opens again", async ({
    launch,
  }) => {
    const first = await launch({ args: [testdata("types")] })
    const { page } = first
    await expect(noteOf(page, "a_warning")).toBeVisible()
    await noteOf(page, "a_warning").getByRole("button", { name: "Close" }).click()
    await expect(page.getByText("This is a warning admonition")).toHaveCount(0)
    await expect(page.getByText("A warning", { exact: true })).toHaveCount(0)
    // It takes no room: its frame is empty and has no box of its own.
    expect(
      await page
        .locator("#runbook-block-a_warning")
        .evaluate((element) => element.getBoundingClientRect().height),
    ).toBe(0)

    await page.getByRole("button", { name: "I understand the risks" }).click()
    await expect(page.getByText("This is a danger admonition")).toHaveCount(0)
    await expect(noteOf(page, "a_note")).toBeVisible()
    await first.app.close()

    const again = await launch({ args: [testdata("types")] })
    await expect(noteOf(again.page, "a_warning")).toBeVisible()
    await expect(noteOf(again.page, "a_danger")).toBeVisible()
  })

  test('permanent-hide: a note confirmed with "Don\'t show me this again" stays hidden in its runbook only', async ({
    launch,
    userDataDir,
  }, testInfo) => {
    const runbook = testdata("permanent-hide")
    const first = await launch({ args: [runbook] })
    const welcome = noteOf(first.page, "welcome")
    await expect(welcome).toContainText("This is your first time running this runbook.")
    await welcome.getByRole("checkbox", { name: "Don't show me this again" }).check()
    await welcome.getByRole("button", { name: "I've read the introduction" }).click()
    await expect(first.page.getByText("This is your first time running this runbook.")).toHaveCount(
      0,
    )
    // A note with no storageKey offers no such box.
    await expect(noteOf(first.page, "always").getByRole("checkbox")).toHaveCount(0)
    await expect
      .poll(() => hiddenIn(userDataDir))
      .toEqual([{ runbook: path.join(runbook, "runbook.mdx"), keys: ["welcome-message"] }])
    await first.app.close()

    const again = await launch({ args: [runbook] })
    await expect(noteOf(again.page, "always")).toBeVisible()
    await expect(again.page.getByText("This is your first time running this runbook.")).toHaveCount(
      0,
    )
    await again.app.close()

    // The same runbook in another folder is another runbook: its note shows.
    const copy = testInfo.outputPath("copy")
    fs.cpSync(runbook, copy, { recursive: true })
    const elsewhere = await launch({ args: [fs.realpathSync(copy)] })
    await expect(noteOf(elsewhere.page, "welcome")).toContainText(
      "This is your first time running this runbook.",
    )
  })

  test("permanent-hide: a note confirmed without the box ticked shows again", async ({
    launch,
    userDataDir,
  }) => {
    const runbook = testdata("permanent-hide")
    const first = await launch({ args: [runbook] })
    await noteOf(first.page, "welcome")
      .getByRole("button", { name: "I've read the introduction" })
      .click()
    await expect(first.page.getByText("This is your first time running this runbook.")).toHaveCount(
      0,
    )
    await first.app.close()
    expect(hiddenIn(userDataDir)).toBeUndefined()

    const again = await launch({ args: [runbook] })
    await expect(noteOf(again.page, "welcome")).toBeVisible()
  })

  test("misconfigured: the error in the note's place, in the frame, and the runbook's other notes", async ({
    launch,
  }) => {
    const { page } = await launch({ args: [testdata("misconfigured")] })
    const noType = page.locator("#runbook-block-no_type")
    await expect(noType.locator(".block-header")).toContainText("<Admonition>")
    await expect(noType.getByLabel("Configuration errors")).toHaveText(
      "Line 6: <Admonition> needs the `type` prop.",
    )
    await expect(
      page.locator("#runbook-block-unknown_type").getByLabel("Configuration errors"),
    ).toContainText(
      'the `type` prop of <Admonition>: Expected "note" | "info" | "warning" | "danger"',
    )
    await expect(
      page.locator("#runbook-block-no_hide").getByLabel("Configuration errors"),
    ).toContainText("it names a hide, so it does nothing without allowPermanentHide={true}")
    await expect(noteOf(page, "fine")).toContainText("The runbook's other blocks still work.")
  })
})
