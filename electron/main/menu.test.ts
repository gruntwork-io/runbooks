import { describe, it, expect, mock } from "bun:test"
import type { MenuItemConstructorOptions } from "electron"
import { mockElectron } from "./test-utils/mock-electron.ts"

// Capture the template instead of building a native menu.
let template: MenuItemConstructorOptions[] = []
mockElectron({
  app: { name: "Runbooks", isPackaged: false },
  Menu: {
    buildFromTemplate: (t: MenuItemConstructorOptions[]) => t,
    setApplicationMenu: (t: MenuItemConstructorOptions[]) => {
      template = t
    },
  },
})

// The main window the Find items send to: records what they send.
const sent: Array<{ channel: string; payload: unknown }> = []
const fakeWindow = {
  isDestroyed: () => false,
  webContents: {
    send: (channel: string, payload?: unknown) => {
      sent.push({ channel, payload })
    },
  },
}
await mock.module("./window.ts", () => ({ getMainWindow: () => fakeWindow }))

const { setupApplicationMenu } = await import("./menu.ts")

function editItems(): MenuItemConstructorOptions[] {
  setupApplicationMenu()
  const edit = template.find((m) => m.label === "Edit")
  expect(edit).toBeDefined()
  return edit!.submenu as MenuItemConstructorOptions[]
}

describe("File menu", () => {
  const fileItems = () => {
    setupApplicationMenu()
    return template.find((m) => m.label === "File")!.submenu as MenuItemConstructorOptions[]
  }

  it("has Rename Session and Reset Session, with no shortcut that could reset by accident", () => {
    const items = fileItems().filter((i) => i.id === "rename-session" || i.id === "reset-session")

    expect(items.map(({ label, accelerator }) => ({ label, accelerator }))).toEqual([
      { label: "Rename Session…", accelerator: undefined },
      { label: "Reset Session", accelerator: undefined },
    ])
  })

  it("sends menu:rename-session to the renderer's title bar", () => {
    const rename = fileItems().find((i) => i.id === "rename-session")!
    sent.length = 0

    ;(rename.click as () => void)()

    expect(sent).toEqual([{ channel: "menu:rename-session", payload: undefined }])
  })

  it("does nothing on Reset Session while no runbook is open", () => {
    const reset = fileItems().find((i) => i.id === "reset-session")!
    sent.length = 0

    ;(reset.click as () => void)()

    expect(sent).toEqual([])
  })
})

describe("Edit menu", () => {
  it("has Find, Find Next and Find Previous with the browser shortcuts", () => {
    const find = editItems().filter((item) => item.label?.startsWith("Find"))
    expect(find.map(({ label, accelerator }) => ({ label, accelerator }))).toEqual([
      { label: "Find…", accelerator: "CmdOrCtrl+F" },
      { label: "Find Next", accelerator: "CmdOrCtrl+G" },
      { label: "Find Previous", accelerator: "Shift+CmdOrCtrl+G" },
    ])
  })

  it("keeps the standard edit roles", () => {
    const roles = editItems().flatMap((item) => (item.role ? [item.role] : []))
    expect(roles).toEqual(["undo", "redo", "cut", "copy", "paste", "selectAll"])
  })

  it("sends menu:find to the renderer's find bar", () => {
    const items = editItems()
    const click = (label: string) => {
      const item = items.find((i) => i.label === label)
      ;(item!.click as () => void)()
    }
    sent.length = 0
    click("Find…")
    click("Find Next")
    click("Find Previous")
    expect(sent).toEqual([
      { channel: "menu:find", payload: { action: "open" } },
      { channel: "menu:find", payload: { action: "next" } },
      { channel: "menu:find", payload: { action: "previous" } },
    ])
  })
})
