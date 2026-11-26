/**
 * The engine over IPC, as the window's page and main see it: the page's
 * client gets answers and streams, a page that is not the app's reaches
 * nothing, a reload gives the new page a client of its own, and the page
 * holds the bridge and nothing more of Electron's.
 *
 * Runs against the build in app-out/: `just app-test-e2e` builds it first.
 */
import path from "node:path"
import type { ElectronApplication, Page } from "@playwright/test"
import { readFromMain, runInMain } from "../electron/e2e/main-process.ts"
import { expect, PAGE, test } from "./fixtures.ts"

/** The window's preload in the build. */
const PRELOAD = path.join(import.meta.dirname, "..", "app-out", "preload", "index.cjs")

/** The line main logs when it drops a message from anywhere but the app's page (ipcServer.ts). */
const REFUSED = "The engine dropped a message that did not come from the app's page."

/** The preload's bridge, as the page holds it. */
interface Bridge {
  readonly send: (message: string) => void
  readonly onMessage: (listener: (message: string) => void) => () => void
}

/** A request envelope, as a client encodes one. */
const request = (id: string, tag: string, payload: unknown = null) => ({
  _tag: "Request",
  id,
  tag,
  payload,
  headers: [],
})

/**
 * Sends `messages` through `page`'s bridge, raw, and returns what main sends
 * back for their ids within `waitMillis`, or as soon as `until` ids have an
 * answer.
 */
function exchange(
  page: Page,
  messages: ReadonlyArray<object>,
  options: { readonly waitMillis: number; readonly until?: ReadonlyArray<string> },
): Promise<
  ReadonlyArray<{
    readonly _tag: string
    readonly requestId: string
    readonly exit?: { readonly _tag: string; readonly value?: unknown }
  }>
> {
  return page.evaluate(
    ({ outgoing, waitMillis, until }) =>
      new Promise((resolve) => {
        const bridge = Reflect.get(window, "engine") as Bridge
        const ids = new Set(
          outgoing.flatMap((message) => ("id" in message ? [String(message.id)] : [])),
        )
        const heard: Array<{ _tag: string; requestId: string }> = []
        const done = () => {
          stop()
          clearTimeout(timer)
          resolve(heard)
        }
        const stop = bridge.onMessage((text) => {
          const message = JSON.parse(text)
          if (!ids.has(String(message.requestId))) return
          heard.push(message)
          const answered = new Set(heard.filter((m) => m._tag === "Exit").map((m) => m.requestId))
          if (until !== undefined && until.every((id) => answered.has(id))) done()
        })
        const timer = setTimeout(done, waitMillis)
        for (const message of outgoing) bridge.send(JSON.stringify(message))
      }),
    { outgoing: [...messages], waitMillis: options.waitMillis, until: options.until },
  )
}

/** Has main record every message it sends the app's window, and returns a reader of them. */
async function recordSentToPage(app: ElectronApplication): Promise<() => Promise<string[]>> {
  await runInMain(
    app,
    ({ BrowserWindow }) => {
      const [appWindow] = BrowserWindow.getAllWindows()
      if (!appWindow) throw new Error("the app has no window")
      const sent: string[] = []
      Object.assign(globalThis, { sentToPage: sent })
      const send = appWindow.webContents.send.bind(appWindow.webContents)
      appWindow.webContents.send = (channel, ...args) => {
        sent.push(String(args[0]))
        send(channel, ...args)
      }
    },
    undefined,
  )
  return () =>
    readFromMain(app, () => [...(Reflect.get(globalThis, "sentToPage") as string[])], undefined)
}

test.describe("the engine over IPC", () => {
  test("answers the page's call: the settings file the engine keeps", async ({
    launch,
    userDataDir,
  }) => {
    const { page } = await launch()
    const [answer] = await exchange(page, [request("settings", "GetSettings")], {
      waitMillis: 10_000,
      until: ["settings"],
    })
    expect(answer?.exit).toMatchObject({
      _tag: "Success",
      value: { file: path.join(userDataDir, "settings.json") },
    })
  })

  test("answers the page's own client: the welcome screen shows once the engine has no runbook open", async ({
    launch,
  }) => {
    const { page } = await launch()
    await expect(page.getByRole("heading", { name: "Open a runbook" })).toBeVisible()
  })

  test("streams a change of settings to the page", async ({ launch }) => {
    const { page } = await launch()
    const themes = await page.evaluate(
      () =>
        new Promise<string[]>((resolve) => {
          const bridge = Reflect.get(window, "engine") as Bridge
          const seen: string[] = []
          const send = (message: object) => bridge.send(JSON.stringify(message))
          const stop = bridge.onMessage((text) => {
            const message = JSON.parse(text)
            if (message._tag !== "Chunk" || message.requestId !== "watch") return
            seen.push(
              ...message.values.map((view: { settings: { theme: string } }) => view.settings.theme),
            )
            send({ _tag: "Ack", requestId: "watch" })
            if (seen.length === 1)
              send({
                _tag: "Request",
                id: "change",
                tag: "ChangeSettings",
                payload: { changes: { theme: "dark" } },
                headers: [],
              })
            if (seen.includes("dark")) {
              stop()
              resolve(seen)
            }
          })
          send({ _tag: "Request", id: "watch", tag: "WatchSettings", payload: null, headers: [] })
        }),
    )
    expect(themes).toEqual(["system", "dark"])
  })

  test("hears nothing from another page in the app's window, and the server sees nothing", async ({
    launch,
  }) => {
    const { app, page, output } = await launch()
    // Main loads it, as no navigation the page starts would be let through.
    await runInMain(
      app,
      ({ BrowserWindow }) => {
        const [appWindow] = BrowserWindow.getAllWindows()
        void appWindow?.loadURL("data:text/html,<title>Elsewhere</title><p>Not the app</p>")
      },
      undefined,
    )
    await expect(page).toHaveTitle("Elsewhere")
    expect(await page.evaluate(() => typeof Reflect.get(window, "engine"))).toBe("object")
    const heard = await exchange(page, [request("elsewhere", "GetSettings")], { waitMillis: 1500 })
    expect(heard).toEqual([])
    await expect.poll(output).toContain(REFUSED)

    // The app's page, loaded again, is heard.
    await runInMain(
      app,
      ({ BrowserWindow }, url) => {
        const [appWindow] = BrowserWindow.getAllWindows()
        void appWindow?.loadURL(url)
      },
      PAGE,
    )
    await expect(page.getByRole("heading", { name: "Open a runbook" })).toBeVisible()
    const answered = await exchange(page, [request("back", "GetSettings")], {
      waitMillis: 10_000,
      until: ["back"],
    })
    expect(answered.map((message) => message._tag)).toEqual(["Exit"])
    expect(output().split(REFUSED)).toHaveLength(2)
  })

  test("hears nothing from another window showing the app's page", async ({ launch }) => {
    const { app, page, output } = await launch()
    const opened = app.waitForEvent("window")
    // With the app window's preload and session, so it holds the same bridge.
    await runInMain(
      app,
      ({ BrowserWindow }, { url, preload }) => {
        const [appWindow] = BrowserWindow.getAllWindows()
        if (!appWindow) throw new Error("the app has no window")
        const other = new BrowserWindow({
          show: false,
          webPreferences: {
            preload,
            session: appWindow.webContents.session,
            sandbox: true,
            contextIsolation: true,
          },
        })
        void other.loadURL(url)
      },
      { url: PAGE, preload: PRELOAD },
    )
    const other = await opened
    await expect(other.getByRole("banner")).toHaveText("Runbooks")
    const heard = await exchange(other, [request("other", "GetSettings")], { waitMillis: 1500 })
    expect(heard).toEqual([])
    await expect(other.getByText("Asking the engine.")).toBeVisible()

    const answered = await exchange(page, [request("app", "GetSettings")], {
      waitMillis: 10_000,
      until: ["app"],
    })
    expect(answered.map((message) => message._tag)).toEqual(["Exit"])
    expect(output()).not.toContain(REFUSED)
  })

  test("ends the old page's stream at a reload, and gives the new page a client of its own", async ({
    launch,
  }) => {
    const { app, page } = await launch()
    await expect(page.getByRole("heading", { name: "Open a runbook" })).toBeVisible()
    const sentToPage = await recordSentToPage(app)
    const watched = await exchange(page, [request("old-watch", "WatchSettings")], {
      waitMillis: 1500,
    })
    expect(watched.map((message) => message._tag)).toEqual(["Chunk"])

    await page.reload()
    const afterReload = (await sentToPage()).length
    await expect(page.getByRole("heading", { name: "Open a runbook" })).toBeVisible()
    const changed = await exchange(
      page,
      [request("change", "ChangeSettings", { changes: { theme: "dark" } })],
      { waitMillis: 10_000, until: ["change"] },
    )
    expect(changed.map((message) => message._tag)).toEqual(["Exit"])
    const toOldWatch = (await sentToPage())
      .slice(afterReload)
      .filter((text) => text.includes('"old-watch"'))
    expect(toOldWatch).toEqual([])
  })

  test("gives the page a send and a listener, and nothing else of Electron's", async ({
    launch,
  }) => {
    const { page } = await launch()
    const held = await page.evaluate(
      async (probe) => {
        const bridge = Reflect.get(window, "engine") as Bridge
        const listenerGot = await new Promise<string[]>((resolve) => {
          const stop = bridge.onMessage((...args: unknown[]) => {
            stop()
            resolve(args.map((arg) => typeof arg))
          })
          bridge.send(JSON.stringify(probe))
        })
        let oversized = "sent"
        try {
          bridge.send("x".repeat(1_048_577))
        } catch {
          oversized = "refused"
        }
        return {
          bridge: Object.keys(bridge).sort(),
          kinds: [typeof bridge.send, typeof bridge.onMessage],
          listenerGot,
          oversized,
          require: typeof require,
          process: typeof process,
          electronGlobals: Object.getOwnPropertyNames(window).filter((name) =>
            /ipc|electron/i.test(name),
          ),
        }
      },
      request("probe", "GetSettings"),
    )
    expect(held).toEqual({
      bridge: ["onMessage", "send"],
      kinds: ["function", "function"],
      listenerGot: ["string"],
      oversized: "refused",
      require: "undefined",
      process: "undefined",
      electronGlobals: [],
    })
  })
})
