/**
 * How the Iframe block and a page it embeds from the runbook's assets folder
 * reach each other. The page runs in a `<webview>` guest, where `parent` is
 * the page's own window, so the guest's preload (electron/preload/embed.ts)
 * relays the protocol's messages (web/src/components/mdx/Iframe/protocol.ts)
 * between the page and the block over these channels.
 */

/** Guest to block: a protocol message the page posted to `parent`. */
export const EMBED_PAGE_MESSAGE_CHANNEL = "embed:page-message"

/** Block to guest: a protocol message for the preload to post to the page. */
export const EMBED_RUNBOOK_MESSAGE_CHANNEL = "embed:runbook-message"

/** Every protocol message type starts with this; a page's other messages are its own. */
export const MESSAGE_TYPE_PREFIX = "runbooks:"

/** The message the runbook sends the page: the values of its `inputsId` Inputs blocks. */
export const INPUTS_MESSAGE = "runbooks:inputs"
