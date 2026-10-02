/**
 * Wiring tests for IPC error normalization and the sender check, with
 * `electron` as the only stand-in: importing ipc/index.ts wraps
 * ipcMain.handle before main/index.ts or registerAllIpcHandlers() registers
 * any handler, and the preload's api.invoke hands the renderer only the
 * handler's message.
 *
 * The stand-in ipcRenderer.invoke calls the MAIN listener with an event from
 * `sender` (the app's page unless a test says otherwise) and rejects the way
 * Electron does: MAIN sends the listener's rejection as `error.toString()`,
 * and the renderer's invoke rejects with
 * "Error invoking remote method '<channel>': <that string>".
 */
import { describe, it, expect, afterAll } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { mockElectron } from "../test-utils/mock-electron.ts"
import { FileReadError } from "../../../src/errors/index.ts"

type Listener = (event: unknown, ...args: unknown[]) => unknown
const listeners = new Map<string, Listener>()
const fakeIpcMain = {
  handle: (channel: string, listener: Listener) => {
    listeners.set(channel, listener)
  },
  on: () => {},
  removeHandler: () => {},
}
let exposedApi: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> } | undefined

/** An IPC event from the main frame of a web contents of `type` showing `url`. */
const eventFrom = (type: string, url: string) => ({
  sender: { getType: () => type },
  senderFrame: { parent: null, url },
})
const APP_PAGE = eventFrom("window", "file:///app/dist/renderer/index.html")
let sender: unknown = APP_PAGE
const userDataDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "runbooks-ipc-error-wiring-"))

mockElectron({
  ipcMain: fakeIpcMain,
  app: { getPath: () => userDataDir },
  contextBridge: {
    exposeInMainWorld: (_key: string, api: typeof exposedApi) => {
      exposedApi = api
    },
  },
  ipcRenderer: {
    invoke: async (channel: string, ...args: unknown[]) => {
      const listener = listeners.get(channel)
      if (!listener)
        throw new Error(`Error invoking remote method '${channel}': Error: No handler registered`)
      try {
        return await listener(sender, ...args)
      } catch (err) {
        throw new Error(`Error invoking remote method '${channel}': ${String(err)}`, { cause: err })
      }
    },
    on: () => {},
    once: () => {},
    removeListener: () => {},
  },
})

// A real ManagedRuntime, so failures reject with the same FiberFailure the
// handlers' `runtime.runPromise(...)` produces.
const runtime = ManagedRuntime.make(Layer.empty)
afterAll(async () => {
  await runtime.dispose()
  fs.rmSync(userDataDir, { recursive: true, force: true })
})

/**
 * Import a module as a fresh instance: bun shares its module registry across
 * test files, so a plain import of a module another file already loaded
 * (github.test.ts loads the preload) would not run it again against this
 * file's electron stand-in.
 */
const importFresh = (specifier: string) => import(`${specifier}?ipc-error-wiring`)

/** What the renderer's `api.invoke(channel)` rejects with. */
async function rendererRejection(channel: string): Promise<Error> {
  try {
    await exposedApi!.invoke(channel)
  } catch (err) {
    return err as Error
  }
  throw new Error(`expected ${channel} to reject`)
}

describe("preload api.invoke", () => {
  it("rejects with only the handler's message, without Electron's wrapper", async () => {
    await importFresh("../../preload/index.ts")
    expect(exposedApi).toBeDefined()
    fakeIpcMain.handle("workspace:file", () => {
      throw new Error("path is outside session working directory")
    })

    const err = await rendererRejection("workspace:file")
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe("path is outside session working directory")
  })
})

describe("ipc/index.ts", () => {
  it("wraps ipcMain.handle when imported, so a handler registered afterwards rejects cleanly", async () => {
    await importFresh("./index.ts")
    // Registered the way main/index.ts's native handlers and
    // registerAllIpcHandlers() register theirs: after the import.
    fakeIpcMain.handle("workspace:tree", () =>
      runtime.runPromise(
        Effect.fail(
          new FileReadError({
            path: "/ws/a.txt",
            cause: new Error("ENOENT: no such file or directory"),
          }),
        ),
      ),
    )

    const err = await rendererRejection("workspace:tree")
    expect(err.message).toBe("FileReadError (/ws/a.txt): ENOENT: no such file or directory")
    expect(err.message).not.toContain("FiberFailure")
    expect(err.message).not.toContain("    at ")
  })

  it("rejects a call from a page the Iframe block embeds before its handler runs", async () => {
    await importFresh("./index.ts")
    let ran = false
    fakeIpcMain.handle("exec:run", () => {
      ran = true
    })

    sender = eventFrom("webview", "https://evil.example/")
    try {
      const err = await rendererRejection("exec:run")
      expect(err.message).toBe("exec:run can only be called from the app's window")
      expect(ran).toBe(false)
    } finally {
      sender = APP_PAGE
    }
  })
})
