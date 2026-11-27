/**
 * A runbook given on the command line, as the window shows it: its markdown
 * walked, each block in its frame, a misconfigured block's errors, the
 * author's markup as data, its body in a box its styles can't escape, and
 * one nested as deep as a runbook may be, or deeper.
 *
 * Runs against the build in app-out/: `just app-test-e2e` builds it first.
 * Each test launches it through the shared fixture (fixtures.ts), with a
 * runbook from e2e/runbooks/.
 */
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "./fixtures.ts"

const runbook = (name: string) => path.join(import.meta.dirname, "runbooks", name)

/**
 * The parser's MAX_NESTING (packages/core/src/document/mdx.ts), which a spec
 * can't import. The test of a runbook nested deeper reads it in main's
 * message, so it fails when the two differ.
 */
const MAX_NESTING = 100

/** `text` inside `quotes` blockquotes. */
const quoted = (quotes: number, text: string) => `${"> ".repeat(quotes)}${text}\n`

test.describe("a runbook given on the command line", () => {
  test("shows its title, headings, a list, a code block, a link and a block's frame", async ({
    launch,
  }) => {
    const { page } = await launch({ args: [runbook("walk")] })
    await expect(page.getByRole("heading", { level: 1, name: "Walk the document" })).toBeVisible()
    await expect(page.getByRole("heading", { name: "Set up the network" })).toBeVisible()
    await expect(page.getByRole("listitem")).toHaveText(["Create the VPC", "Add the subnets"])
    await expect(page.locator("pre code")).toHaveText("tofu apply -auto-approve")
    await expect(page.getByRole("link", { name: "the OpenTofu docs" })).toHaveAttribute(
      "href",
      "https://opentofu.org/docs/",
    )
    const block = page.getByRole("region", { name: "<Command> block" })
    await expect(block.locator(".block-id")).toHaveText("setup")
    await expect(block.getByText("The setup step's own markdown.")).toBeVisible()
  })

  test("shows literal props and expressions as text, and runs nothing", async ({
    launch,
    userDataDir,
  }) => {
    const { page } = await launch({ args: [runbook("walk")] })
    const block = page.getByRole("region", { name: "<Command> block" })
    await expect(block.locator(".block-title")).toHaveText("Literal title")
    await expect(block.getByText("No substitutions here")).toBeVisible()
    await expect(page.getByText("An expression, shown as its text.")).toBeVisible()
    await expect(page.locator(".runbook-body")).not.toContainText("an author comment")
    // The block's script would leave this file in the folder it runs in: the
    // session's working folder, in the user data folder.
    const ran = fs
      .readdirSync(userDataDir, { recursive: true, encoding: "utf8" })
      .filter((file) => path.basename(file) === "ran-on-open")
    expect(ran).toEqual([])
    expect(fs.existsSync(path.join(runbook("walk"), "ran-on-open"))).toBe(false)
  })

  test("shows a misconfigured block's error and line in place of its view, and the warnings", async ({
    launch,
  }) => {
    const { page } = await launch({ args: [runbook("misconfigured")] })
    const broken = page
      .getByRole("region", { name: "<Command> block" })
      .filter({ hasText: "broken" })
    await expect(broken.getByRole("list", { name: "Configuration errors" })).toHaveText(
      /^Line 5: .*`command`/,
    )
    await expect(page.getByRole("list", { name: "Warnings" })).toHaveText(
      /^Line 7: .*`colour` prop/,
    )
  })

  test("shows the author's markup as data: no image loads, no handler, popover or off-page link", async ({
    launch,
  }) => {
    const { page } = await launch({ args: [runbook("untrusted-markup")] })
    const body = page.locator(".runbook-body")
    await expect(body).toContainText("Image: A tracking pixel (https://example.invalid/pixel.gif)")
    await expect(body).toContainText("Image: A diagram (./diagram.png)")
    await expect(body.getByText("A div with a handler.")).toHaveAttribute("title", "Kept title")
    await expect(page.locator("img, [onclick], [onerror], [popover], [popovertarget]")).toHaveCount(
      0,
    )
    await expect(body.getByRole("link")).toHaveCount(0)
    await expect(body).toContainText("The passwords file (file:///etc/passwd)")
    await expect(
      page.getByText(/can't show 1 part of the runbook yet.*<button> \(1\)/),
    ).toBeVisible()
    expect(await page.evaluate(() => Reflect.get(window, "ranFromRunbook"))).toBeUndefined()
  })

  test("is not opened with a javascript: link, and main says why", async ({ launch }) => {
    const target = path.join(runbook("javascript-link"), "runbook.mdx")
    const { page, output } = await launch({ args: [runbook("javascript-link")] })
    await expect(page.getByRole("heading", { name: "Open a runbook" })).toBeVisible()
    await expect.poll(output).toContain(`Runbooks could not open ${target}:`)
    expect(output()).toContain(`${target}:3:1: \`javascript:\` URLs`)
    await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0)
  })

  test("keeps a fixed element inside the body's box, and the app's header under the pointer", async ({
    launch,
  }) => {
    const { page } = await launch({ args: [runbook("fixed-overlay")] })
    const overlay = page.getByText("An overlay that would cover the window.")
    await expect(overlay).toBeVisible()
    // The author's style applies, set through the CSSOM under the CSP.
    expect(await overlay.evaluate((element) => getComputedStyle(element).position)).toBe("fixed")

    const box = await page.locator(".runbook-body").boundingBox()
    const covered = await overlay.boundingBox()
    if (box === null || covered === null) throw new Error("the body or the overlay has no box")
    expect(covered.x).toBeGreaterThanOrEqual(box.x)
    expect(covered.y).toBeGreaterThanOrEqual(box.y)
    expect(covered.x + covered.width).toBeLessThanOrEqual(box.x + box.width)
    expect(covered.y + covered.height).toBeLessThanOrEqual(box.y + box.height)

    const headerHit = await page.evaluate(() => {
      const header = document.querySelector("header.app-header")
      if (header === null) return "no header"
      const { x, y, width, height } = header.getBoundingClientRect()
      const hit = document.elementFromPoint(x + width / 2, y + height / 2)
      return header.contains(hit) ? "header" : (hit?.textContent ?? "nothing")
    })
    expect(headerHit).toBe("header")
  })

  test("shows a runbook nested as deep as a runbook may be, each part to its bottom", async ({
    launch,
  }, testInfo) => {
    // Each to MAX_NESTING levels, the most the parser takes (parse.test.ts):
    // under Electron's Node, nested elements ran the engine out of stack at
    // 500, and lists the window's walk at 400 (800 levels).
    const levels = MAX_NESTING - 2
    const lists = Array.from(
      { length: MAX_NESTING / 2 - 1 },
      (_, i) => `${"  ".repeat(i)}- item ${i}`,
    )
    const file = testInfo.outputPath("deepest.mdx")
    fs.writeFileSync(
      file,
      [
        "# As deep as may be",
        "",
        `${"<div>".repeat(levels)}The bottom of the elements.${"</div>".repeat(levels)}`,
        "",
        quoted(levels, "The bottom of the quotes."),
        `${lists.join("\n")} is the bottom of the lists.`,
        "",
      ].join("\n"),
    )
    const { page, output } = await launch({ args: [file] })
    await expect(page.getByRole("heading", { name: "As deep as may be" })).toBeVisible()
    const body = page.locator(".runbook-body")
    await expect(body).toContainText("The bottom of the elements.")
    await expect(body).toContainText("The bottom of the quotes.")
    await expect(body).toContainText(`item ${MAX_NESTING / 2 - 2} is the bottom of the lists.`)
    // Main says nothing of it. (Its output also holds Chromium's own lines,
    // such as GPU warnings on Linux CI.)
    expect(output()).not.toContain("Runbooks could not open")
  })

  test("refuses a runbook nested deeper, saying where, and serves the window", async ({
    launch,
  }, testInfo) => {
    // runbooks-reviewer's runbook: Electron main ran out of stack opening it.
    const file = testInfo.outputPath("too-deep.mdx")
    fs.writeFileSync(file, `# Too deep\n\n${quoted(2000, "The bottom.")}`)
    const { page, output } = await launch({ args: [file] })
    await expect(page.getByRole("heading", { name: "Open a runbook" })).toBeVisible()
    await expect
      .poll(output)
      .toContain(
        `Runbooks could not open ${file}:\n  ${file}:3:${2 * MAX_NESTING + 1}: Nested more than ${MAX_NESTING} levels deep.`,
      )
  })
})
