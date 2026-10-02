import { describe, it, expect } from "bun:test"
import { installEmbedRelay } from "./embed-relay.ts"
import {
  EMBED_PAGE_MESSAGE_CHANNEL,
  EMBED_RUNBOOK_MESSAGE_CHANNEL,
} from "../shared/embed-messaging.ts"

const ORIGIN = "runbook-asset://rabc"

type Relay = Parameters<typeof installEmbedRelay>

/** A guest's window and ipcRenderer with the relay installed, and what passes through it. */
function relayedGuest() {
  const page = new EventTarget()
  const postedToPage: unknown[][] = []
  const win = Object.assign(page, {
    location: { origin: ORIGIN },
    postMessage: (...args: unknown[]) => void postedToPage.push(args),
  })
  const sentToBlock: unknown[][] = []
  const listeners = new Map<string, (event: unknown, ...args: unknown[]) => void>()
  const ipc = {
    sendToHost: (...args: unknown[]) => void sentToBlock.push(args),
    on(channel: string, listener: (event: unknown, ...args: unknown[]) => void) {
      listeners.set(channel, listener)
      return ipc
    },
  }
  installEmbedRelay(win as unknown as Relay[0], ipc as unknown as Relay[1])

  return {
    sentToBlock,
    postedToPage,
    /** The page, or a frame inside it (`source`), posts `data` to the guest's window. */
    pagePosts(data: unknown, source: unknown = win) {
      page.dispatchEvent(Object.assign(new Event("message"), { data, source }))
    },
    blockSends(message: unknown) {
      listeners.get(EMBED_RUNBOOK_MESSAGE_CHANNEL)?.({}, message)
    },
  }
}

describe("installEmbedRelay", () => {
  it("passes a protocol message the page posts to parent on to the block", () => {
    const guest = relayedGuest()
    const message = { type: "runbooks:set-outputs", outputs: { region: "us-east-1" } }

    guest.pagePosts(message)
    guest.pagePosts({ type: "runbooks:no-such-type" })

    expect(guest.sentToBlock).toEqual([
      [EMBED_PAGE_MESSAGE_CHANNEL, message],
      [EMBED_PAGE_MESSAGE_CHANNEL, { type: "runbooks:no-such-type" }],
    ])
  })

  it("ignores a frame inside the page", () => {
    const guest = relayedGuest()

    guest.pagePosts({ type: "runbooks:set-outputs", outputs: { region: "x" } }, {})

    expect(guest.sentToBlock).toEqual([])
  })

  it.each([
    ["another message type", { type: "chart:resize", height: 300 }],
    ["a string", "hello"],
    ["null", null],
    ["a message whose type isn't a string", { type: 1 }],
    ["the inputs message it posts to the page itself", { type: "runbooks:inputs", inputs: {} }],
  ])("keeps %s from the block", (_name, data) => {
    const guest = relayedGuest()

    guest.pagePosts(data)

    expect(guest.sentToBlock).toEqual([])
  })

  it("posts what the block sends to the page, at the page's own origin", () => {
    const guest = relayedGuest()
    const message = { type: "runbooks:inputs", inputs: { environment: "staging" } }

    guest.blockSends(message)

    expect(guest.postedToPage).toEqual([[message, ORIGIN]])
  })
})
