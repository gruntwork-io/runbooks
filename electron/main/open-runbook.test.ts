import { describe, it, expect } from "bun:test"
import { openRunbookInWindow } from "./open-runbook.ts"
import type { BrowserWindow } from "electron"

type SendCall = { channel: string; payload: unknown }

/**
 * Build a stand-in exposing just the webContents surface openRunbookInWindow
 * uses. `fireFinishLoad` simulates the renderer's page finishing its load — the
 * point where it has registered its IPC listeners.
 */
function makeFakeWindow(isLoading: boolean) {
  const calls: SendCall[] = []
  let finishLoadCb: (() => void) | null = null
  const win = {
    webContents: {
      isLoading: () => isLoading,
      once: (event: string, cb: () => void) => {
        if (event === "did-finish-load") finishLoadCb = cb
      },
      send: (channel: string, payload: unknown) => {
        calls.push({ channel, payload })
      },
    },
  } as unknown as BrowserWindow
  return { win, calls, fireFinishLoad: () => finishLoadCb?.() }
}

describe("openRunbookInWindow", () => {
  it("sends immediately when the window has already finished loading", () => {
    // The "app already running" case (e.g. Finder "Open with… > Runbooks").
    const { win, calls } = makeFakeWindow(false)
    openRunbookInWindow(win, { path: "/x/runbook.mdx" })
    expect(calls).toEqual([
      { channel: "file:open-runbook", payload: { path: "/x/runbook.mdx" } },
    ])
  })

  it("defers until did-finish-load when the window is still loading", () => {
    // The cold-start case: sending before the renderer registers its listener
    // would drop the event, so nothing is sent until the load finishes.
    const { win, calls, fireFinishLoad } = makeFakeWindow(true)
    openRunbookInWindow(win, { path: "/x/runbook.mdx" })
    expect(calls).toEqual([])

    fireFinishLoad()
    expect(calls).toEqual([
      { channel: "file:open-runbook", payload: { path: "/x/runbook.mdx" } },
    ])
  })

  it("forwards remoteSource in the payload", () => {
    const { win, calls } = makeFakeWindow(false)
    openRunbookInWindow(win, {
      path: "/x/runbook.mdx",
      remoteSource: "github.com/o/r",
    })
    expect(calls[0]?.payload).toEqual({
      path: "/x/runbook.mdx",
      remoteSource: "github.com/o/r",
    })
  })
})
