/**
 * E2E test for where the runbook's scrollbar sits.
 *
 * The runbook's pane scrolls, not the runbook's bordered box, so the scrollbar
 * sits at the pane's right edge: against the handle beside the files
 * workspace, or where the handle's gap starts while the workspace is hidden.
 * The box keeps the same border and padding on both sides, and the pane
 * leaves room beside and below it for its shadow. Measured in the real window
 * at 1280 and 1920px, with the files workspace hidden and shown, in the light
 * and dark themes, with content wider than the box.
 *
 * Playwright can't see a scrollbar, so its width comes from the scroller's
 * offsetWidth and clientWidth. Electron draws classic scrollbars here unless
 * it is launched with --hide-scrollbars, which stands in for macOS overlay
 * scrollbars: they take no width.
 *
 * Prerequisites: run `electron-vite build` first (expects ./dist/main/index.js).
 *
 * Run with:
 *   bunx playwright test --config electron/e2e/playwright.config.ts runbook-scrollbar.spec.ts
 */
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { fileURLToPath } from "url"
import { MOCK_KEYCHAIN } from "./launch.ts"
import { resizeMainWindow } from "./main-process.ts"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const MAIN_ENTRY = path.join(ROOT, "dist/main/index.js")

const paragraphs = (chapter: string) =>
  Array.from({ length: 60 }, (_, i) => `${chapter} paragraph ${i + 1}.`).join("\n\n")

/** Content wider than the box: none of it may make the pane scroll sideways. */
const WIDE_CONTENT = [
  "```\n" + "x".repeat(400) + "\n```",
  "| " + Array.from({ length: 30 }, (_, i) => `column ${i + 1}`).join(" | ") + " |",
  "|" + Array.from({ length: 30 }, () => "---").join("|") + "|",
  "| " + Array.from({ length: 30 }, (_, i) => `value ${i + 1}`).join(" | ") + " |",
  "",
  "y".repeat(300),
  '<Iframe src="./assets/page.html" title="Page" />',
].join("\n")

/** Two chapters, each long enough to scroll at every window size below. */
const LONG_RUNBOOK = [
  "# Scrollbar",
  `<Chapter title="First">\n\n${WIDE_CONTENT}\n\n${paragraphs("First")}\n\n</Chapter>`,
  `<Chapter title="Second">\n\n${paragraphs("Second")}\n\n</Chapter>`,
].join("\n\n")

/** Too short to scroll. */
const SHORT_RUNBOOK = "# Scrollbar\n\nOne paragraph."

/** Where the scrollbar and the runbook's box are, in the window's pixels. */
function measure(page: Page) {
  return page.evaluate(() => {
    const box = document.querySelector<HTMLElement>('[data-testid="runbook-content"]')
    if (!box) throw new Error("the runbook's box (runbook-content) is not on the page")
    // Whatever scrolls the runbook: the box itself, or the nearest element around it.
    let scroller: HTMLElement | null = box
    while (scroller && !["auto", "scroll"].includes(getComputedStyle(scroller).overflowY)) {
      scroller = scroller.parentElement
    }
    if (!scroller) {
      throw new Error("nothing scrolls the runbook: no element around its box has overflow-y auto")
    }
    const handle = document.querySelector<HTMLElement>('[role="separator"]')!
    const pane = handle.previousElementSibling!.getBoundingClientRect()
    const sides = (el: HTMLElement) => {
      const style = getComputedStyle(el)
      return {
        border: [parseFloat(style.borderLeftWidth), parseFloat(style.borderRightWidth)],
        padding: [parseFloat(style.paddingLeft), parseFloat(style.paddingRight)],
      }
    }
    // The width a classic scrollbar takes inside an element's border.
    const scrollbarWidth = (el: HTMLElement) => {
      const { border } = sides(el)
      return el.offsetWidth - el.clientWidth - border[0]! - border[1]!
    }
    // How far the box's shadow reaches past each of its edges: each layer's
    // blur and spread, moved by its offset ("color x y blur spread").
    const shadow = { left: 0, right: 0, bottom: 0 }
    for (const layer of getComputedStyle(box)
      .boxShadow.replace(/rgba?\([^)]*\)/g, "")
      .split(",")) {
      const [x = 0, y = 0, blur = 0, spread = 0] = layer.trim().split(/\s+/).map(parseFloat)
      shadow.left = Math.max(shadow.left, blur + spread - x)
      shadow.right = Math.max(shadow.right, blur + spread + x)
      shadow.bottom = Math.max(shadow.bottom, blur + spread + y)
    }
    const scrollerRect = scroller.getBoundingClientRect()
    const scrollerBorder = sides(scroller).border
    const boxRect = box.getBoundingClientRect()
    const { border, padding } = sides(box)
    const scrollbarRight = scrollerRect.right - scrollerBorder[1]!
    return {
      scrolls: scroller.scrollHeight > scroller.clientHeight,
      scrollWidth: scroller.scrollWidth,
      clientWidth: scroller.clientWidth,
      colorScheme: getComputedStyle(scroller).colorScheme,
      scrollbarWidth: scrollbarWidth(scroller),
      scrollbarRight,
      paneRight: pane.right,
      handleLeft: handle.getBoundingClientRect().left,
      boxRight: boxRect.right,
      boxScrollbarWidth: scrollbarWidth(box),
      border,
      padding,
      // From the box's outer edges to its content, scrollbar included.
      contentLeft: box.clientLeft + padding[0]!,
      contentRight: boxRect.right - (boxRect.left + box.clientLeft + box.clientWidth) + padding[1]!,
      shadow,
      // The room the pane leaves around the box, inside its border and scrollbar.
      gapLeft: boxRect.left - scrollerRect.left - scrollerBorder[0]!,
      gapRight: scrollbarRight - scrollbarWidth(scroller) - boxRect.right,
      gapBottom: scroller.scrollHeight - (boxRect.bottom - scrollerRect.top + scroller.scrollTop),
      scrollerPaddingBottom: parseFloat(getComputedStyle(scroller).paddingBottom),
    }
  })
}

type Layout = Awaited<ReturnType<typeof measure>>

/**
 * The box has the same border and padding on both sides, and nothing scrolls
 * inside it. The pane never scrolls sideways, and leaves the same room on
 * both sides of the box, and enough beside and below it for its shadow.
 */
function expectSymmetricBox(m: Layout, label: string) {
  const at = `${label}: ${JSON.stringify(m)}`
  expect(m.scrollWidth, `no sideways scroll, ${at}`).toBe(m.clientWidth)
  expect(m.boxScrollbarWidth, at).toBe(0)
  expect(m.border[0], at).toBe(m.border[1])
  expect(m.padding[0], at).toBe(m.padding[1])
  expect(Math.abs(m.contentLeft - m.contentRight), at).toBeLessThanOrEqual(1)
  expect(Math.abs(m.gapLeft - m.gapRight), `equal room beside the box, ${at}`).toBeLessThanOrEqual(
    1,
  )
  expect(m.shadow.bottom, `the box has a shadow, ${at}`).toBeGreaterThan(0)
  expect(m.gapLeft, `room for the shadow, ${at}`).toBeGreaterThanOrEqual(m.shadow.left)
  expect(m.gapRight, `room for the shadow, ${at}`).toBeGreaterThanOrEqual(m.shadow.right)
  // The box's height can be fractional; the pane's scroll height is rounded.
  expect(m.gapBottom + 1, `room for the shadow, ${at}`).toBeGreaterThanOrEqual(m.shadow.bottom)
}

test.describe("runbook scrollbar", () => {
  let tmpDir: string
  let app: ElectronApplication | undefined

  test.beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-scrollbar-e2e-"))
  })

  test.afterEach(async () => {
    await app?.close()
    app = undefined
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function launch(runbook: string, ...switches: string[]) {
    const runbookDir = path.join(tmpDir, "scrollbar")
    fs.mkdirSync(path.join(runbookDir, "assets"), { recursive: true })
    fs.writeFileSync(path.join(runbookDir, "assets", "page.html"), "<p>An embedded page.</p>")
    fs.writeFileSync(path.join(runbookDir, "runbook.mdx"), runbook)
    app = await electron.launch({
      args: [
        MAIN_ENTRY,
        MOCK_KEYCHAIN,
        ...switches,
        `--user-data-dir=${path.join(tmpDir, "user-data")}`,
        runbookDir,
      ],
      env: { ...process.env, ELECTRON_NO_UPDATER: "1", RUNBOOKS_TELEMETRY_DISABLE: "1" },
    })
    const page = await app.firstWindow()
    await page.waitForLoadState("domcontentloaded")
    await expect(page.getByRole("heading", { name: "Scrollbar" })).toBeVisible({ timeout: 60_000 })
    return page
  }

  async function resize(page: Page, width: number, height: number) {
    await resizeMainWindow(app!, width, height)
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width)
  }

  async function setTheme(page: Page, theme: "Light" | "Dark") {
    await page.getByRole("button", { name: "Menu" }).click()
    await page.getByRole("menuitemradio", { name: theme }).click()
    const dark = theme === "Dark"
    await expect
      .poll(() => page.evaluate(() => document.documentElement.classList.contains("dark")))
      .toBe(dark)
  }

  test("sits at the pane's edge, outside the runbook's box", async () => {
    const page = await launch(LONG_RUNBOOK)
    const bar = page.getByRole("navigation", { name: "Chapters" })
    await expect(bar).toBeVisible()
    await page.getByRole("button", { name: "Load page" }).click()

    for (const files of [false, true]) {
      if (files) {
        await page.getByTitle("Show generated files").click()
        await page.waitForFunction(() => document.getAnimations().length === 0)
      }
      for (const [width, height] of [
        [1280, 900],
        [1920, 1080],
      ] as const) {
        await resize(page, width, height)
        await page.waitForFunction(() => document.getAnimations().length === 0)
        for (const theme of ["Light", "Dark"] as const) {
          await setTheme(page, theme)
          const label = `${width}px, files ${files ? "shown" : "hidden"}, ${theme}`
          const m = await measure(page)
          const at = `${label}: ${JSON.stringify(m)}`
          expect(m.scrolls, at).toBe(true)
          expect(m.scrollbarWidth, at).toBeGreaterThan(0)
          // Against the handle, which is where the pane ends.
          expect(Math.abs(m.scrollbarRight - m.paneRight), at).toBeLessThanOrEqual(1)
          expect(Math.abs(m.scrollbarRight - m.handleLeft), at).toBeLessThanOrEqual(1)
          // Outside the box: the box ends where the scrollbar starts.
          expect(m.boxRight, at).toBeLessThanOrEqual(m.scrollbarRight - m.scrollbarWidth + 1)
          expectSymmetricBox(m, label)
          // The scrollbar is drawn in the theme's colors.
          expect(m.colorScheme, at).toBe(theme === "Dark" ? "dark" : "normal")
        }
      }
    }

    // Dragged to its narrowest beside the files, the box still fits the pane.
    await resize(page, 1280, 900)
    const handle = page.getByRole("separator", { name: "Resize the runbook" })
    const grip = (await handle.boundingBox())!
    await page.mouse.move(grip.x + grip.width / 2, grip.y + 200)
    await page.mouse.down()
    await page.mouse.move(grip.x + grip.width / 2 - 1000, grip.y + 200, { steps: 10 })
    await page.mouse.up()
    await expect
      .poll(() =>
        page.getByTestId("runbook-scroller").evaluate((el) => (el as HTMLElement).offsetWidth),
      )
      .toBe(400)
    expectSymmetricBox(await measure(page), "dragged to 400px")

    // The chapter bar sticks at the top of the pane as it scrolls.
    const scroller = page.getByTestId("runbook-scroller")
    await scroller.evaluate((el) => el.scrollBy({ top: 600 }))
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
    const [barTop, scrollerTop] = await Promise.all([
      bar.evaluate((el) => el.getBoundingClientRect().top),
      scroller.evaluate((el) => el.getBoundingClientRect().top),
    ])
    expect(Math.abs(barTop - scrollerTop)).toBeLessThanOrEqual(1)

    // Scrolled to the end, the room below the box is still there.
    await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }))
    expectSymmetricBox(await measure(page), "scrolled to the end")
  })

  test("ends at the window's foot in the narrow layout, so the window never scrolls", async () => {
    const page = await launch(LONG_RUNBOOK)
    const scroller = page.getByTestId("runbook-scroller")
    for (const [width, height] of [
      [1100, 800],
      [900, 700],
    ] as const) {
      await resize(page, width, height)
      const m = await page.evaluate(() => ({
        windowScrollHeight: document.scrollingElement!.scrollHeight,
        innerHeight,
      }))
      const at = `${width}x${height}: ${JSON.stringify(m)}`
      expect(m.windowScrollHeight, at).toBe(m.innerHeight)
      const bottom = await scroller.evaluate((el) => el.getBoundingClientRect().bottom)
      expect(Math.abs(bottom - height), at).toBeLessThanOrEqual(1)
    }
  })

  for (const [name, runbook, switches] of [
    ["with overlay scrollbars", LONG_RUNBOOK, ["--hide-scrollbars"]],
    ["when the runbook is too short to scroll", SHORT_RUNBOOK, []],
  ] as const) {
    test(`keeps the runbook's box symmetric ${name}`, async () => {
      const page = await launch(runbook, ...switches)
      for (const [width, height] of [
        [1280, 900],
        [1920, 1080],
      ] as const) {
        await resize(page, width, height)
        const m = await measure(page)
        const at = `${width}px: ${JSON.stringify(m)}`
        expect(m.scrollbarWidth, at).toBe(0)
        // Nothing but the room beside the box lies between it and the pane's edge.
        expect(Math.abs(m.scrollbarRight - m.paneRight), at).toBeLessThanOrEqual(1)
        expect(Math.abs(m.boxRight + m.gapRight - m.paneRight), at).toBeLessThanOrEqual(1)
        // A short runbook's box still reaches the room at the foot of the pane.
        if (runbook === SHORT_RUNBOOK) {
          expect(m.scrolls, at).toBe(false)
          expect(Math.abs(m.gapBottom - m.scrollerPaddingBottom), at).toBeLessThanOrEqual(1)
        }
        expectSymmetricBox(m, `${width}px`)
      }
    })
  }
})
