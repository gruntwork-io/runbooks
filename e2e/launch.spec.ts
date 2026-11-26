/**
 * Launching the rebuilt app as a person does: with a runbook on the command
 * line, with none, and again while it runs.
 *
 * Runs against the build in app-out/: `just app-test-e2e` builds it first.
 * Each test launches it through the shared fixture (fixtures.ts).
 */
import path from "node:path"
import type { Page } from "@playwright/test"
import { readFromMain, runInMain } from "../electron/e2e/main-process.ts"
import { expect, test } from "./fixtures.ts"

/** A runbook folder: the Command block's end-to-end fixture. */
const RUNBOOK_FOLDER = path.resolve(
  import.meta.dirname,
  "..",
  "blocks",
  "command",
  "testdata",
  "end-to-end",
)

/** The e2e runbooks' folder, and the one whose title the tests read. */
const RUNBOOKS = path.join(import.meta.dirname, "runbooks")
const WALK = path.join(RUNBOOKS, "walk")

/** The preload's bridge, as the page holds it. */
interface Bridge {
  readonly send: (message: string) => void
  readonly onMessage: (listener: (message: string) => void) => () => void
}

/** The runbook files of the engine's open sessions, as the page's raw `ListSessions` gets them. */
function openRunbooks(page: Page): Promise<unknown> {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const bridge = Reflect.get(window, "engine") as Bridge
        const stop = bridge.onMessage((text) => {
          const message = JSON.parse(text)
          if (message._tag !== "Exit" || message.requestId !== "list") return
          stop()
          resolve(message.exit.value.map((session: { path: string }) => session.path))
        })
        bridge.send(
          JSON.stringify({
            _tag: "Request",
            id: "list",
            tag: "ListSessions",
            payload: null,
            headers: [],
          }),
        )
      }),
  )
}

test.describe("launching the rebuilt app", () => {
  test("with no runbook, shows a welcome screen that says how to open one, and no buttons", async ({
    launch,
  }) => {
    const { page } = await launch()
    const welcome = page.getByRole("region", { name: "Open a runbook" })
    await expect(welcome).toContainText("on the command line")
    await expect(welcome).toContainText("runbook.mdx")
    await expect(page.getByRole("button")).toHaveCount(0)
    expect(await openRunbooks(page)).toEqual([])
  })

  test("with a runbook file's path, opens that runbook", async ({ launch }) => {
    const runbook = path.join(WALK, "runbook.mdx")
    const { page } = await launch({ args: [runbook] })
    await expect(page.getByRole("heading", { level: 1, name: "Walk the document" })).toBeVisible()
    expect(await openRunbooks(page)).toEqual([runbook])
  })

  test("with a relative path, opens the runbook in the folder it names from where it started", async ({
    launch,
  }) => {
    const { page } = await launch({ args: ["walk"], cwd: RUNBOOKS })
    await expect(page.getByRole("heading", { level: 1, name: "Walk the document" })).toBeVisible()
    expect(await openRunbooks(page)).toEqual([path.join(WALK, "runbook.mdx")])
  })

  test("with a path to nothing, says so and shows the welcome screen", async ({ launch }) => {
    const missing = path.join(RUNBOOKS, "missing")
    const { page, output } = await launch({ args: [missing] })
    await expect(page.getByRole("heading", { name: "Open a runbook" })).toBeVisible()
    await expect
      .poll(output)
      .toContain(`Runbooks could not open ${missing}: there is no file or folder there.`)
    expect(await openRunbooks(page)).toEqual([])
  })

  test("again on its user data folder focuses the first window and opens nothing", async ({
    launch,
    launchAgain,
  }) => {
    const { app, page } = await launch()
    await runInMain(
      app,
      ({ BrowserWindow }) => {
        const [appWindow] = BrowserWindow.getAllWindows()
        if (!appWindow) throw new Error("the app has no window")
        const focused: string[] = []
        Object.assign(globalThis, { focused })
        const focus = appWindow.focus.bind(appWindow)
        appWindow.focus = () => {
          focused.push("focus")
          focus()
        }
      },
      undefined,
    )

    const second = await launchAgain([RUNBOOK_FOLDER])

    expect(second.code, second.output).toBe(0)
    await expect
      .poll(() => readFromMain(app, () => Reflect.get(globalThis, "focused"), undefined))
      .toEqual(["focus"])
    expect(app.windows()).toHaveLength(1)
    expect(await openRunbooks(page)).toEqual([])
  })
})
