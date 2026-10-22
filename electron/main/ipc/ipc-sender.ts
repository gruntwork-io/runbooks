/**
 * Only the app's own page may call IPC handlers.
 *
 * Every handler (exec:run among them) trusts its caller. The preload exposes
 * the API to the app's main frame only, but a page the Iframe block embeds
 * runs in a renderer process of its own, and a renderer bug exploited there
 * could send IPC messages directly. installIpcSenderCheck() rejects any call
 * that doesn't come from the main frame of the app's window before its
 * handler runs.
 *
 * Only `import type` from electron, so this stays unit-testable without an
 * Electron runtime (same approach as ipc-error.ts).
 */
import type { IpcMain, IpcMainInvokeEvent } from "electron"

type SenderEvent = {
  sender: Pick<IpcMainInvokeEvent["sender"], "getType">
  senderFrame: { parent: unknown; url: string } | null
}

/**
 * Whether `event` comes from the app's page: the main frame (not a subframe)
 * of a window's web contents (not a `<webview>` guest), showing the app,
 * which is file:// in a build and ELECTRON_RENDERER_URL in dev. The URL
 * check keeps a window added later for remote content from counting.
 */
export function isAppMainFrame(
  event: SenderEvent,
  devRendererUrl = process.env.ELECTRON_RENDERER_URL,
): boolean {
  const frame = event.senderFrame
  if (!frame || frame.parent !== null || event.sender.getType() !== "window") return false
  try {
    const url = new URL(frame.url)
    return devRendererUrl ? url.origin === new URL(devRendererUrl).origin : url.protocol === "file:"
  } catch {
    return false
  }
}

const checkedIpcs = new WeakSet<object>()

/**
 * Wrap `ipc.handle` so every handler registered through it afterwards
 * rejects calls that `isTrusted` refuses, without running. Must run before
 * the first `ipcMain.handle` call, like installIpcErrorNormalization(), which
 * then turns the rejection into a clean message. Installing it again is a
 * no-op.
 */
export function installIpcSenderCheck(
  ipc: Pick<IpcMain, "handle">,
  isTrusted: (event: IpcMainInvokeEvent) => boolean = isAppMainFrame,
): void {
  if (checkedIpcs.has(ipc)) return
  checkedIpcs.add(ipc)
  const register = ipc.handle.bind(ipc)
  ipc.handle = (channel, listener) =>
    register(channel, (event, ...args) => {
      if (!isTrusted(event)) {
        throw new Error(`${channel} can only be called from the app's window`)
      }
      return listener(event, ...args)
    })
}
