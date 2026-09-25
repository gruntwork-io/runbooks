import { describe, it, expect } from "bun:test"
import { Effect } from "effect"
import { openRunbookInWindow, openRemoteRunbookInWindow } from "./open-runbook.ts"
import type { OpenRemoteRunbookDeps } from "./open-runbook.ts"
import { RemoteSourceError } from "../../src/errors/index.ts"
import type { BrowserWindow } from "electron"

type SendCall = { channel: string; payload: unknown }

/**
 * Build a stand-in exposing just the webContents surface openRunbookInWindow
 * uses. `fireFinishLoad` simulates the renderer's page finishing its load — the
 * point where it has registered its IPC listeners.
 */
function makeFakeWindow(isLoading: boolean, isDestroyed = false) {
  const calls: SendCall[] = []
  let finishLoadCb: (() => void) | null = null
  const win = {
    isDestroyed: () => isDestroyed,
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

describe("openRemoteRunbookInWindow", () => {
  const URL = "https://github.com/o/r/tree/main/rb"

  /** Deps around the given resolveRemote; records every showError call. */
  function makeDeps(resolveRemote: OpenRemoteRunbookDeps["resolveRemote"]) {
    const errors: { win: BrowserWindow; message: string; detail: string }[] = []
    const deps: OpenRemoteRunbookDeps = {
      resolveRemote,
      showError: (win, message, detail) => {
        errors.push({ win, message, detail })
      },
    }
    return { deps, errors }
  }

  it("opens the cloned runbook with its remote source", async () => {
    const { win, calls } = makeFakeWindow(false)
    const { deps, errors } = makeDeps(async (url) => ({ localPath: "/tmp/clone/rb/runbook.mdx", remoteSource: url }))

    await openRemoteRunbookInWindow(win, URL, deps)

    expect(calls).toEqual([
      { channel: "file:open-runbook", payload: { path: "/tmp/clone/rb/runbook.mdx", remoteSource: URL } },
    ])
    expect(errors).toEqual([])
  })

  it("waits for a still-loading window before sending the cloned runbook", async () => {
    // Cold launch: the clone starts alongside the page load.
    const { win, calls, fireFinishLoad } = makeFakeWindow(true)
    const { deps } = makeDeps(async (url) => ({ localPath: "/tmp/clone/runbook.mdx", remoteSource: url }))

    await openRemoteRunbookInWindow(win, URL, deps)
    expect(calls).toEqual([])

    fireFinishLoad()
    expect(calls).toHaveLength(1)
  })

  it("shows the clone-failure hint to the user instead of only logging it", async () => {
    // resolveRemoteRunbook fails through runtime.runPromise with a
    // RemoteSourceError carrying classifyCloneError's hint.
    const hint = "authentication required for github.com/o/r: set GITHUB_TOKEN, or run 'gh auth login'"
    const { win, calls } = makeFakeWindow(false)
    const { deps, errors } = makeDeps((url) =>
      Effect.runPromise(Effect.fail(new RemoteSourceError({ url, message: hint }))),
    )

    await openRemoteRunbookInWindow(win, URL, deps)

    expect(calls).toEqual([])
    expect(errors).toHaveLength(1)
    expect(errors[0].win).toBe(win)
    expect(errors[0].message).toBe("Couldn't open runbook")
    expect(errors[0].detail).toBe(`${URL}\n\n${hint}`)
  })

  it("redacts credentials from the error it shows", async () => {
    const { win } = makeFakeWindow(false)
    const { deps, errors } = makeDeps(async () => {
      throw new Error("git ls-remote https://x-access-token:s3cr3t-value@github.com/o/r.git failed")
    })

    await openRemoteRunbookInWindow(win, URL, deps)

    expect(errors[0].detail).not.toContain("s3cr3t-value")
    expect(errors[0].detail).toContain("[REDACTED]@github.com/o/r.git")
  })

  it("does nothing further once the window has been closed", async () => {
    for (const outcome of ["resolve", "reject"] as const) {
      const { win, calls } = makeFakeWindow(false, true)
      const { deps, errors } = makeDeps(async (url) => {
        if (outcome === "reject") throw new Error("network unreachable")
        return { localPath: "/tmp/clone/runbook.mdx", remoteSource: url }
      })

      await openRemoteRunbookInWindow(win, URL, deps)

      expect(calls).toEqual([])
      expect(errors).toEqual([])
    }
  })
})
