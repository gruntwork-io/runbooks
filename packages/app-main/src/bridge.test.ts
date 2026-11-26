import { describe, expect, it } from "bun:test"
import { EventEmitter } from "node:events"
import { FROM_PAGE, makeBridge, MAX_PAGE_MESSAGE, TO_PAGE } from "./bridge.ts"

// The bridge over a stand-in for ipcRenderer: an emitter for what main
// sends, and a list of what the page sent.

const fakeIpc = () => {
  const ipc = Object.assign(new EventEmitter(), {
    sent: [] as Array<[string, string]>,
    send(channel: string, message: string) {
      ipc.sent.push([channel, message])
    },
  })
  return ipc
}

describe("the engine bridge", () => {
  it("sends each message on its own, on the engine's channel", () => {
    const ipc = fakeIpc()
    const bridge = makeBridge(ipc)
    bridge.send('{"_tag":"Ack","requestId":1}')
    bridge.send('{"_tag":"Ack","requestId":2}')
    expect(ipc.sent).toEqual([
      [FROM_PAGE, '{"_tag":"Ack","requestId":1}'],
      [FROM_PAGE, '{"_tag":"Ack","requestId":2}'],
    ])
  })

  it("refuses, sending nothing, a message that is not a string or is over the cap", () => {
    const ipc = fakeIpc()
    const bridge = makeBridge(ipc)
    expect(() => bridge.send({ _tag: "Ack" } as unknown as string)).toThrow(TypeError)
    expect(() => bridge.send("x".repeat(MAX_PAGE_MESSAGE + 1))).toThrow(RangeError)
    bridge.send("x".repeat(MAX_PAGE_MESSAGE))
    expect(ipc.sent.map(([, message]) => message.length)).toEqual([MAX_PAGE_MESSAGE])
  })

  it("hands a listener main's messages, and never the IPC event", () => {
    const ipc = fakeIpc()
    const heard: unknown[][] = []
    makeBridge(ipc).onMessage((...args) => heard.push(args))
    ipc.emit(TO_PAGE, { sender: ipc }, '{"_tag":"Exit"}')
    ipc.emit(TO_PAGE, { sender: ipc }, { not: "a string" })
    ipc.emit("another-channel", { sender: ipc }, "elsewhere")
    expect(heard).toEqual([['{"_tag":"Exit"}']])
  })

  it("stops a listener when its unsubscribe is called", () => {
    const ipc = fakeIpc()
    const heard: string[] = []
    const stop = makeBridge(ipc).onMessage((message) => heard.push(message))
    ipc.emit(TO_PAGE, {}, "one")
    stop()
    ipc.emit(TO_PAGE, {}, "two")
    expect(heard).toEqual(["one"])
    expect(ipc.listenerCount(TO_PAGE)).toBe(0)
  })

  it("holds a send and a listener, and nothing else", () => {
    expect(Object.keys(makeBridge(fakeIpc())).sort()).toEqual(["onMessage", "send"])
  })
})
