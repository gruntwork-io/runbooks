/**
 * The relay a local page's `<webview>` guest runs in its preload (embed.ts),
 * between the page and its Iframe block.
 *
 * In a guest, `parent` is the page's own window, so what the page posts to
 * `parent` arrives here as a message from that window. Protocol messages
 * among them go to the block (sendToHost reaches only the embedding page,
 * not the main process), and what the block sends back is posted to the
 * page. The preload runs in an isolated world, so the page never gets
 * `ipcRenderer` itself: it can send the block protocol messages, and nothing
 * else.
 *
 * Only `import type` from electron, so this stays unit-testable without an
 * Electron runtime.
 */
import type { IpcRenderer } from "electron"
import {
  EMBED_PAGE_MESSAGE_CHANNEL,
  EMBED_RUNBOOK_MESSAGE_CHANNEL,
  INPUTS_MESSAGE,
  MESSAGE_TYPE_PREFIX,
} from "../shared/embed-messaging.ts"

type RelayWindow = Pick<Window, "addEventListener" | "postMessage"> & {
  location: Pick<Location, "origin">
}

export function installEmbedRelay(
  win: RelayWindow,
  ipc: Pick<IpcRenderer, "sendToHost" | "on">,
): void {
  win.addEventListener("message", (event) => {
    // Only the page itself. A frame inside the page posts as itself.
    if (event.source !== win) return
    // The inputs message is the one this relay posts to the page.
    if (isPageMessage(event.data) && event.data.type !== INPUTS_MESSAGE) {
      ipc.sendToHost(EMBED_PAGE_MESSAGE_CHANNEL, event.data)
    }
  })
  ipc.on(EMBED_RUNBOOK_MESSAGE_CHANNEL, (_event, message: unknown) => {
    win.postMessage(message, win.location.origin)
  })
}

function isPageMessage(data: unknown): data is { type: string } {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    typeof data.type === "string" &&
    data.type.startsWith(MESSAGE_TYPE_PREFIX)
  )
}
