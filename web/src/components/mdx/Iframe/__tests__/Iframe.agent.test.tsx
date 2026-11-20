/** Iframe's agent adapter: load the page, and say what the person must do on it. */
import { describe, it, expect } from "vitest"
import { renderWithAgent, askAgent, availableActions } from "@/test/agent-harness"
import { Iframe } from "../Iframe"

describe("Iframe agent adapter", () => {
  it("loads the page through the block's Load", async () => {
    const api = renderWithAgent(<Iframe id="page" src="https://example.com/" />)
    const before = await askAgent(api, { op: "get_block", blockId: "page" })
    expect(availableActions(before)).toEqual(["load"])
    await askAgent(api, { op: "act_on_block", blockId: "page", action: "load", params: {} })
    const after = await askAgent(api, { op: "get_block", blockId: "page" })
    expect(after.state.loaded).toBe(true)
    expect(availableActions(after)).toEqual(["reload"])
  })
})
