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

function menuItems(label: string): MenuItemConstructorOptions[] {
  setupApplicationMenu()
  const menu = template.find((m) => m.label === label)
  expect(menu).toBeDefined()
  return menu!.submenu as MenuItemConstructorOptions[]
}

const editItems = () => menuItems("Edit")

/** Every item of `items`, submenus included. */
function allItems(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? allItems(item.submenu) : []),
  ])
}

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

describe("View menu", () => {
  it("opens the command palette with Cmd/Ctrl+K, the only binding of that shortcut", () => {
    const [palette] = menuItems("View")
    expect(palette).toMatchObject({ label: "Command Palette…", accelerator: "CmdOrCtrl+K" })
    const bound = allItems(template).filter((item) => item.accelerator === "CmdOrCtrl+K")
    expect(bound).toHaveLength(1)
    expect(bound[0]).toBe(palette)

    sent.length = 0
    ;(palette!.click as () => void)()
    expect(sent).toEqual([{ channel: "menu:open-command-palette", payload: undefined }])
  })
})
