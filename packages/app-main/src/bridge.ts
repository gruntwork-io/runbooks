/**
 * What main and the window's preload agree on: the IPC channels the engine
 * protocol's messages travel on, and the longest message the page may send.
 * Each message is one JSON-encoded RPC envelope (`effect/rpc`'s
 * `RpcSerialization.json`), sent as a string.
 *
 * The preload bundles this file, so it imports nothing.
 */

/** The page's messages to the engine: requests, stream acks and interrupts. */
export const FROM_PAGE = "engine:from-page"

/** The engine's messages to the page: answers, stream chunks and defects. */
export const TO_PAGE = "engine:to-page"

/**
 * The longest message the page may send, in UTF-16 code units: 1 MiB, as a
 * saved session's payload. The preload refuses to send a longer one, so the
 * page's call fails, and main drops one unread.
 */
export const MAX_PAGE_MESSAGE = 1_048_576
