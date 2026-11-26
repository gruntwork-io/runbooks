/**
 * What main and the window's preload agree on: the IPC channels the engine
 * protocol's messages travel on, the longest message the page may send, and
 * the bridge the preload gives the page. Each message is one JSON-encoded
 * RPC envelope (`effect/rpc`'s `RpcSerialization.json`), sent as a string.
 *
 * The preload bundles this file, and a sandboxed preload may require
 * nothing but electron, so it imports nothing.
 */

/** The page's messages to the engine: requests, stream acks and interrupts. */
export const FROM_PAGE = "engine:from-page"

/** The engine's messages to the page: answers, stream chunks and defects. */
export const TO_PAGE = "engine:to-page"

/** The bridge's name on the page's `window`. */
export const BRIDGE = "engine"

/**
 * The longest message the page may send, in UTF-16 code units: 1 MiB, as a
 * saved session's payload. The preload refuses to send a longer one, so the
 * page's call fails, and main drops one unread.
 */
export const MAX_PAGE_MESSAGE = 1_048_576

/**
 * All the page gets: a way to send the engine a message, and one to hear
 * its messages. Strings both ways, and nothing of Electron's.
 */
export interface EngineBridge {
  /** Sends one message to the engine. Throws, sending nothing, for a non-string or one over `MAX_PAGE_MESSAGE`. */
  readonly send: (message: string) => void
  /** Calls `listener` with each message from the engine until the function it returns is called. */
  readonly onMessage: (listener: (message: string) => void) => () => void
}

/** The parts of `ipcRenderer` the bridge uses. */
export interface RendererIpc {
  send(channel: string, message: string): void
  on(channel: string, listener: (event: unknown, message: unknown) => void): unknown
  removeListener(channel: string, listener: (event: unknown, message: unknown) => void): unknown
}

/**
 * The bridge over `ipc`. A listener gets the message only, never the IPC
 * event, whose `sender` is `ipcRenderer` itself.
 */
export function makeBridge(ipc: RendererIpc): EngineBridge {
  return {
    send: (message) => {
      if (typeof message !== "string") throw new TypeError("A message to the engine is a string.")
      if (message.length > MAX_PAGE_MESSAGE)
        throw new RangeError(
          `A message to the engine is at most ${MAX_PAGE_MESSAGE} characters; this one is ${message.length}.`,
        )
      ipc.send(FROM_PAGE, message)
    },
    onMessage: (listener) => {
      if (typeof listener !== "function") throw new TypeError("The listener is a function.")
      const forward = (_event: unknown, message: unknown) => {
        if (typeof message === "string") listener(message)
      }
      ipc.on(TO_PAGE, forward)
      return () => {
        ipc.removeListener(TO_PAGE, forward)
      }
    },
  }
}
