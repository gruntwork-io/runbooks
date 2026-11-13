import {
  test,
  expect,
  expectNoConsoleErrors,
  drag,
  hideFiles,
  showFiles,
  trustRunbook,
  type Page,
} from "./fixtures"
import type { Locator } from "@playwright/test"

/**
 * End-to-end test for the Runbook width setting.
 *
 * Runs in the real window, as the widths come from its layout. Fixed, the
 * default, keeps the layout the app always had. Fill window lets the runbook,
 * and the files workspace beside it, fill the window, while the runbook's
 * text keeps its line length. Windows stay at most 1920px wide. CI's
 * `xvfb-run --auto-servernum` screen is 1280x1024, but X with no window
 * manager doesn't clamp a window to it, so a window still opens 1920px wide
 * there; if one ever is clamped, resizeWindow fails rather than measuring it.
 */

const RUNBOOK = "testdata/sample-runbooks/my-first-runbook"

/** The window's margin on each side of the row the runbook is in. */
const MARGIN = 24
/** The gap the resize handle leaves between the runbook and the files workspace. */
const HANDLE = 32
/** The widest the row gets with Runbook width Fixed: 130rem. */
const FIXED_ROW_MAX = 2080
/** The runbook's width on its own with Runbook width Fixed: 56rem. */
const FIXED_RUNBOOK_WIDTH = 896
/** The widest a paragraph outside a block gets with Runbook width Fill window: 52rem. */
const TEXT_MAX_WIDTH = 832

test.describe("Runbook width Fixed", () => {
  for (const windowWidth of [1280, 1920]) {
    test(`keeps the layout on a ${windowWidth}px window`, async ({
      launchRunbook,
      resizeWindow,
      consoleMessages,
    }) => {
      const page = await launchRunbook(RUNBOOK)
      await resizeWindow(windowWidth, 900)
      const runbook = await openRunbook(page)
      const row = Math.min(windowWidth - 2 * MARGIN, FIXED_ROW_MAX)

      // On its own, 896px wide, centered with the handle's gap beside it.
      await expect.poll(() => width(runbook)).toBe(FIXED_RUNBOOK_WIDTH)
      expect(await left(runbook)).toBeCloseTo(MARGIN + (row - FIXED_RUNBOOK_WIDTH - HANDLE) / 2, 0)
      // Its text isn't capped.
      expect(await maxWidth(firstParagraph(runbook))).toBe("none")

      // Beside the files workspace: a third of the row, between 576px and
      // 768px, and the workspace takes the rest.
      await showFiles(page)
      const sideBySide = Math.min(Math.max((row - HANDLE) / 3, 576), 768)
      expect(await width(runbook)).toBeCloseTo(sideBySide, 0)
      expect(await width(filesPanel(page))).toBeCloseTo(row - HANDLE - sideBySide, 0)

      expectNoConsoleErrors(consoleMessages)
    })
  }
})

test.describe("Runbook width Fill window", () => {
  test("fills a wide window with the runbook, but not its text", async ({
    launchRunbook,
    resizeWindow,
    consoleMessages,
  }) => {
    const page = await launchRunbook(RUNBOOK)
    await resizeWindow(1920, 1080)
    const runbook = await openRunbook(page)
    await setRunbookWidth(page, "Fill window")

    // The row, less the handle's gap and room for the Show generated files
    // button beside the runbook: 80px.
    const row = 1920 - 2 * MARGIN
    await expect.poll(() => width(runbook)).toBeCloseTo(row - 80, 0)
    expect(await left(runbook)).toBeCloseTo(2 * MARGIN, 0)
    const showButton = await page.getByTitle("Show generated files").boundingBox()
    expect(showButton!.x + showButton!.width).toBeLessThanOrEqual(1920 - MARGIN)

    // Text outside blocks keeps its line length; headings don't need to.
    expect(await width(firstParagraph(runbook))).toBe(TEXT_MAX_WIDTH)
    expect(await width(runbook.locator("h2").first())).toBeGreaterThan(TEXT_MAX_WIDTH)

    // Blocks, their text and code use the full width.
    expect(await width(page.getByTestId("check-git"))).toBeGreaterThan(900)
    expect(await width(runbook.locator(".runbook-block p").first())).toBeGreaterThan(TEXT_MAX_WIDTH)
    expect(await width(runbook.locator("pre:not(.runbook-block pre)").first())).toBeGreaterThan(900)

    // The setting comes back after a reload.
    await page.reload()
    await expect.poll(() => width(page.getByTestId("runbook-content"))).toBeCloseTo(row - 80, 0)

    expectNoConsoleErrors(consoleMessages)
  })

  test("keeps the narrow layout's text below the desktop width", async ({
    launchRunbook,
    resizeWindow,
    consoleMessages,
  }) => {
    const page = await launchRunbook(RUNBOOK)
    await resizeWindow(1200, 900)
    const runbook = await openRunbook(page)
    const paragraph = firstParagraph(runbook)
    await expect(paragraph).toBeVisible()
    const fixedWidth = await width(paragraph)

    // Below 1250px the runbook takes the narrow layout, which Fill window
    // leaves as it is: its text isn't capped.
    await setRunbookWidth(page, "Fill window")
    expect(await maxWidth(paragraph)).toBe("none")
    expect(await width(paragraph)).toBe(fixedWidth)
    expect(fixedWidth).toBeGreaterThan(TEXT_MAX_WIDTH)

    expectNoConsoleErrors(consoleMessages)
  })

  test("caps text, but not the images, code and tables in it", async ({
    launchRunbook,
    resizeWindow,
    consoleMessages,
  }) => {
    const page = await launchRunbook("testdata/sample-runbooks/markdown-only-full")
    await resizeWindow(1920, 1080)
    const runbook = await openRunbook(page)
    await setRunbookWidth(page, "Fill window")

    // The sample image is 1920px wide: it fills the runbook, past the text's cap.
    await expect.poll(() => width(runbook.locator("p img").first())).toBeGreaterThan(1500)

    // A list item that holds code or a table isn't capped, so neither is the
    // code. Its other items are.
    await page.evaluate(`(() => {
      const list = document.createElement("ul")
      list.id = "nested"
      list.innerHTML =
        "<li id='with-code'>Run:<pre>code</pre></li>" +
        "<li id='with-table'>See:<table><tr><td>cell</td></tr></table></li>" +
        "<li id='text-only'>Some text</li>"
      document.querySelector(".markdown-body").append(list)
    })()`)
    expect(await maxWidth(page.locator("#nested"))).toBe("none")
    expect(await maxWidth(page.locator("#with-code"))).toBe("none")
    expect(await maxWidth(page.locator("#with-table"))).toBe("none")
    expect(await maxWidth(page.locator("#text-only"))).toBe(`${TEXT_MAX_WIDTH}px`)

    expectNoConsoleErrors(consoleMessages)
  })

  test("fills the window beside the files workspace, and drags across all of it", async ({
    launchRunbook,
    resizeWindow,
    consoleMessages,
  }) => {
    const page = await launchRunbook(RUNBOOK)
    await resizeWindow(1920, 1080)
    const runbook = await openRunbook(page)
    await trustRunbook(page)
    await setRunbookWidth(page, "Fill window")
    const row = 1920 - 2 * MARGIN

    // A block's output from before the files workspace opens.
    const check = page.getByTestId("check-git")
    await check.getByRole("button", { name: "Check", exact: true }).click()
    await expect(check.getByText("Git is installed!")).toBeVisible({ timeout: 15_000 })

    // A third of the row, and the files workspace the rest of it.
    await showFiles(page)
    const sideBySide = (row - HANDLE) / 3
    expect(await width(runbook)).toBeCloseTo(sideBySide, 0)
    expect(await left(runbook)).toBeCloseTo(MARGIN, 0)
    expect(await width(filesPanel(page))).toBeCloseTo(row - HANDLE - sideBySide, 0)

    // The handle drags as far as leaving the files workspace 400px, and
    // down to a 400px runbook.
    const handle = page.getByRole("separator", { name: "Resize the runbook" })
    await drag(page, handle, 1200)
    await expect.poll(() => width(runbook)).toBeCloseTo(row - 432, 0)
    expect(await width(filesPanel(page))).toBeCloseTo(400, 0)
    await drag(page, handle, -1200)
    await expect.poll(() => width(runbook)).toBe(400)

    // Double-clicking it puts back the default widths.
    await handle.dblclick()
    await expect.poll(() => width(runbook)).toBeCloseTo(sideBySide, 0)

    // Hiding the files workspace widens the runbook again, and keeps its
    // blocks' output.
    await hideFiles(page)
    await expect.poll(() => width(runbook)).toBeCloseTo(row - 80, 0)
    await expect(check.getByText("Git is installed!")).toBeVisible()

    expectNoConsoleErrors(consoleMessages)
  })
})

test.describe("showing and hiding the files workspace", () => {
  for (const setting of ["Fixed", "Fill window"] as const) {
    for (const dragged of [false, true]) {
      const runbookKind = dragged ? "a dragged runbook" : "the runbook"
      test(`slides ${runbookKind} without a jump with Runbook width ${setting}`, async ({
        launchRunbook,
        resizeWindow,
        consoleMessages,
      }) => {
        const page = await launchRunbook(RUNBOOK)
        await resizeWindow(1920, 1080)
        await openRunbook(page)
        await setRunbookWidth(page, setting)
        if (dragged) {
          await showFiles(page)
          await drag(page, page.getByRole("separator", { name: "Resize the runbook" }), 50)
          await hideFiles(page)
        }

        // Opening narrows the runbook a little at a time, and moves its left
        // edge only leftwards; closing does the opposite.
        const opening = await perFrame(page, () => page.getByTitle("Show generated files").click())
        expectSlide(opening, -1)
        const closing = await perFrame(page, () =>
          page.getByTitle("Hide files workspace").locator("visible=true").click(),
        )
        expectSlide(closing, 1)

        expectNoConsoleErrors(consoleMessages)
      })
    }
  }

  for (const setting of ["Fixed", "Fill window"] as const) {
    test(`slides the runbook back without a jump when hidden mid-slide with Runbook width ${setting}`, async ({
      launchRunbook,
      resizeWindow,
      consoleMessages,
    }) => {
      const page = await launchRunbook(RUNBOOK)
      await resizeWindow(1920, 1080)
      const runbook = await openRunbook(page)
      await setRunbookWidth(page, setting)
      const row = 1920 - 2 * MARGIN
      const closed = setting === "Fixed" ? FIXED_RUNBOOK_WIDTH : row - 80
      const open = (row - HANDLE) / 3

      // Hides the files workspace once the runbook has narrowed 60% of the
      // way, so the slide back still takes over 300ms. A dispatched click: the
      // button is still moving, so a real click would wait for the slide to end.
      await page.getByTitle("Show generated files").click()
      await page.waitForFunction(
        `document.querySelector('[data-testid="runbook-content"]').getBoundingClientRect().width < ${closed - 0.6 * (closed - open)}`,
      )
      const closing = await perFrame(page, async () => {
        await page.getByTitle("Hide files workspace").locator("visible=true").dispatchEvent("click")
        // A few frames on, past the first slide's transitioncancel, the
        // runbook still slides with the panel.
        expect(await paneTransition(page, 3)).toBe("0.7s")
      })
      expectSlide(closing, 1)
      await expect.poll(() => width(runbook)).toBeCloseTo(closed, 0)
      // Once the slide back ends, the runbook stops sliding.
      await expect.poll(() => paneTransition(page, 0)).toBe("0s")

      expectNoConsoleErrors(consoleMessages)
    })
  }

  test("stops sliding when the window narrows mid-slide", async ({
    launchRunbook,
    resizeWindow,
    consoleMessages,
  }) => {
    const page = await launchRunbook(RUNBOOK)
    await resizeWindow(1920, 1080)
    const runbook = await openRunbook(page)
    await setRunbookWidth(page, "Fill window")
    const closed = 1920 - 2 * MARGIN - 80

    // Below 1250px the files workspace leaves the row, which cancels its slide.
    await page.getByTitle("Show generated files").click()
    await page.waitForFunction(
      `document.querySelector('[data-testid="runbook-content"]').getBoundingClientRect().width < ${closed - 20}`,
    )
    await resizeWindow(1200, 900)
    await resizeWindow(1920, 1080)

    // Back on the desktop layout, the runbook no longer slides, so the
    // handle's arrow keys and double-click set its width at once.
    await expect(runbook).toBeVisible()
    await expect.poll(() => paneTransition(page, 0)).toBe("0s")

    expectNoConsoleErrors(consoleMessages)
  })
})

/** Waits for the runbook to render, and returns it. */
async function openRunbook(page: Page): Promise<Locator> {
  const runbook = page.getByTestId("runbook-content")
  await expect(runbook).toBeVisible({ timeout: 15_000 })
  return runbook
}

/** Picks a Runbook width in the Menu, as Preferences… opens it. */
async function setRunbookWidth(page: Page, setting: "Fixed" | "Fill window") {
  await page.getByRole("button", { name: "Menu" }).click()
  await page.getByRole("menuitemradio", { name: setting }).click()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("menu")).toBeHidden()
}

/** The runbook's first paragraph, which is long enough to fill a line. */
function firstParagraph(runbook: Locator): Locator {
  return runbook.locator("p", { hasText: "The first thing to point out" })
}

/** The files workspace beside the runbook. */
function filesPanel(page: Page): Locator {
  return page
    .getByRole("separator", { name: "Resize the runbook" })
    .locator("xpath=following-sibling::div[1]")
}

async function box(locator: Locator) {
  const found = await locator.boundingBox()
  if (!found) throw new Error("The element isn't on screen")
  return found
}

async function width(locator: Locator): Promise<number> {
  return (await box(locator)).width
}

async function left(locator: Locator): Promise<number> {
  return (await box(locator)).x
}

/** The element's computed max-width. */
async function maxWidth(locator: Locator): Promise<string> {
  return locator.evaluate(
    (el) =>
      (
        globalThis as unknown as { getComputedStyle(e: unknown): { maxWidth: string } }
      ).getComputedStyle(el).maxWidth,
  )
}

/**
 * The runbook pane's transition-duration, `frames` frames from now: 0.7s
 * while it slides with the files workspace, 0s otherwise.
 */
async function paneTransition(page: Page, frames: number): Promise<string> {
  return (await page.evaluate(`new Promise((done) => {
    const pane = document.querySelector('[aria-label="Resize the runbook"]').previousElementSibling
    let left = ${frames}
    const read = () =>
      left-- > 0 ? requestAnimationFrame(read) : done(getComputedStyle(pane).transitionDuration)
    read()
  })`)) as string
}

interface Frames {
  times: number[]
  lefts: number[]
  widths: number[]
}

/** The runbook's left edge and width on every frame for 1.2s, from just before `action`. */
async function perFrame(page: Page, action: () => Promise<void>): Promise<Frames> {
  await page.evaluate(`(() => {
    const runbook = document.querySelector('[data-testid="runbook-content"]')
    window.__frames = { times: [], lefts: [], widths: [] }
    window.__framesDone = false
    const start = performance.now()
    const sample = () => {
      const { left, width } = runbook.getBoundingClientRect()
      window.__frames.times.push(performance.now())
      window.__frames.lefts.push(left)
      window.__frames.widths.push(width)
      if (performance.now() - start < 1200) requestAnimationFrame(sample)
      else window.__framesDone = true
    }
    requestAnimationFrame(sample)
  })()`)
  await action()
  await page.waitForFunction("window.__framesDone")
  return (await page.evaluate("window.__frames")) as Frames
}

/** A frame at 60 frames a second, in ms. */
const FRAME = 1000 / 60

/** The shortest time over which a slide's width changes, in ms. */
const MIN_SLIDE = 300

/**
 * Expects a slide: the left edge moves only in `direction` (1 rightwards, -1
 * leftwards), and the runbook only widens (1) or narrows (-1). Each step
 * changes the width by at most a third of the whole change per 60Hz frame
 * since the last one, counting a frame that comes late, as on a busy machine,
 * as at most two and a half: so no step is more than five sixths of the
 * change, however long its frame. And the width keeps changing for at least
 * 300ms, from the frame before its first step of more than half a pixel to
 * its last one; the slide takes 700ms. A snap fails both.
 */
function expectSlide({ times, lefts, widths }: Frames, direction: 1 | -1) {
  const shown = [
    `ms per frame: ${times.map((time) => (time - times[0]!).toFixed(1)).join(", ")}`,
    `left edge per frame: ${lefts.join(", ")}`,
    `width per frame: ${widths.join(", ")}`,
  ].join("\n")
  const steps = (values: number[], sign: number) =>
    values.slice(1).map((value, i) => (value - values[i]!) * sign)
  expect(Math.min(...steps(lefts, direction)), shown).toBeGreaterThan(-1)
  const widthSteps = steps(widths, direction)
  expect(Math.min(...widthSteps), shown).toBeGreaterThan(-1)
  const widthChange = Math.abs(widths.at(-1)! - widths[0]!)
  expect(widthChange, shown).toBeGreaterThan(50)
  // Each step as a share of a third of the change per 60Hz frame elapsed,
  // counting from one frame up to two and a half.
  const elapsed = steps(times, 1)
  const stepShare = widthSteps.map(
    (step, i) => step / ((widthChange / 3) * Math.min(Math.max(elapsed[i]! / FRAME, 1), 2.5)),
  )
  expect(Math.max(...stepShare), shown).toBeLessThanOrEqual(1)
  // Steps of more than half a pixel, by the frame each one ends on.
  const moving = widthSteps.flatMap((step, i) => (step > 0.5 ? [i + 1] : []))
  expect(times[moving.at(-1)!]! - times[moving[0]! - 1]!, shown).toBeGreaterThanOrEqual(MIN_SLIDE)
}
