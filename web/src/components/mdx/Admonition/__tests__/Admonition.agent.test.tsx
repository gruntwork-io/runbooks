/** Admonition's agent adapter: a note reports its status, and only the person confirms trust. */
import { describe, it, expect, vi } from "vitest"
import { renderWithAgent, askAgent, availableActions } from "@/test/agent-harness"
import { Admonition } from "../Admonition"

describe("Admonition agent adapter", () => {
  it("reports a plain note as info, with nothing to do", async () => {
    const api = renderWithAgent(<Admonition type="info" title="Heads up" description="Read me" />)
    const session = await askAgent(api, { op: "get_session" })
    expect(session.blocks).toEqual([
      expect.objectContaining({
        type: "Admonition",
        status: "info",
        controllable: false,
        actions: [],
      }),
    ])
  })

  it("confirms a note through its button", async () => {
    const api = renderWithAgent(
      <Admonition
        type="warning"
        title="Careful"
        description="This deletes things"
        confirmationText="I understand"
      />,
    )
    const [note] = (await askAgent(api, { op: "get_session" })).blocks
    expect(note).toMatchObject({ status: "pending", actions: ["confirm"] })
    await askAgent(api, { op: "act_on_block", blockId: note.id, action: "confirm", params: {} })
    await vi.waitFor(async () => {
      expect((await askAgent(api, { op: "get_block", blockId: note.id })).status).toBe("success")
    })
  })

  it("leaves the trust banner to the person", async () => {
    const api = renderWithAgent(
      <Admonition
        type="warning"
        title="Trust"
        confirmationText="I trust this Runbook"
        storageKey="security-banner-x"
      />,
    )
    const [note] = (await askAgent(api, { op: "get_session" })).blocks
    const detail = await askAgent(api, { op: "get_block", blockId: note.id })
    expect(availableActions(detail)).toEqual([])
    expect(detail.needsHuman).toContain("trust this runbook")
  })
})
