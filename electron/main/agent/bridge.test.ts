import { describe, it, expect } from "bun:test"
import type { AgentRequestEvent } from "../../../src/domain/agent/protocol.ts"
import { RendererBridge } from "./bridge.ts"

describe("RendererBridge", () => {
  it("resolves a request with the renderer's answer to it", async () => {
    const sent: AgentRequestEvent[] = []
    const bridge = new RendererBridge((event) => {
      sent.push(event)
      return true
    })
    const pending = bridge.request({ op: "get_outputs" })
    expect(sent[0]!.request).toEqual({ op: "get_outputs" })
    bridge.respond({ requestId: "unknown", ok: true, result: "ignored" })
    bridge.respond({ requestId: sent[0]!.requestId, ok: true, result: { a: { b: "c" } } })
    expect(await pending).toEqual({ a: { b: "c" } })
  })

  it("rejects with the renderer's error", async () => {
    let id = ""
    const bridge = new RendererBridge((event) => {
      id = event.requestId
      return true
    })
    const pending = bridge.request({ op: "run_block", blockId: "x" })
    bridge.respond({ requestId: id, ok: false, error: 'No block "x" on the page.' })
    await expect(pending).rejects.toThrow('No block "x"')
  })

  it("rejects when there is no window, or it doesn't answer", async () => {
    await expect(new RendererBridge(() => false).request({ op: "get_session" })).rejects.toThrow(
      "isn't open",
    )
    await expect(new RendererBridge(() => true, 20).request({ op: "get_session" })).rejects.toThrow(
      "didn't answer",
    )
  })
})
