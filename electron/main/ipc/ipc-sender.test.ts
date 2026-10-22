import { describe, it, expect } from "bun:test"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { installIpcSenderCheck, isAppMainFrame } from "./ipc-sender.ts"

const mainFrame = (url: string) => ({ parent: null, url })
const event = (type: string, senderFrame: { parent: unknown; url: string } | null) => ({
  sender: { getType: () => type } as IpcMainInvokeEvent["sender"],
  senderFrame,
})
const APP = "file:///Applications/Runbooks.app/Contents/Resources/app.asar/dist/renderer/index.html"

describe("isAppMainFrame", () => {
  it("accepts the main frame of the app's window", () => {
    expect(isAppMainFrame(event("window", mainFrame(APP)), "")).toBe(true)
  })

  it("accepts the dev server's page in dev", () => {
    expect(
      isAppMainFrame(event("window", mainFrame("http://localhost:5173/")), "http://localhost:5173"),
    ).toBe(true)
    expect(isAppMainFrame(event("window", mainFrame(APP)), "http://localhost:5173")).toBe(false)
  })

  it.each([
    ["a <webview> guest", event("webview", mainFrame("https://evil.example/"))],
    [
      "a subframe of the app's window",
      event("window", { parent: {}, url: "https://evil.example/" }),
    ],
    ["a frame that has gone", event("window", null)],
    ["a window showing a remote page", event("window", mainFrame("https://evil.example/"))],
  ])("refuses %s", (_name, e) => {
    expect(isAppMainFrame(e, "")).toBe(false)
  })
})

describe("installIpcSenderCheck", () => {
  type Listener = (event: unknown, ...args: unknown[]) => unknown
  function install(isTrusted: (event: IpcMainInvokeEvent) => boolean) {
    const listeners = new Map<string, Listener>()
    const ipc = {
      handle: (channel: string, listener: Listener) => listeners.set(channel, listener),
    }
    installIpcSenderCheck(ipc as unknown as Pick<IpcMain, "handle">, isTrusted)
    return { ipc, listeners }
  }

  it("runs the handler for a trusted sender and refuses the rest without running it", async () => {
    const { ipc, listeners } = install((e) => (e as unknown as { trusted: boolean }).trusted)
    let calls = 0
    ipc.handle("exec:run", (_e: unknown, arg: unknown) => {
      calls++
      return arg
    })

    expect(await listeners.get("exec:run")!({ trusted: true }, "ok")).toBe("ok")
    expect(() => listeners.get("exec:run")!({ trusted: false })).toThrow(
      "exec:run can only be called from the app's window",
    )
    expect(calls).toBe(1)
  })
})
