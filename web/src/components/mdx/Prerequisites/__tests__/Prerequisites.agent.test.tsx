/** Prerequisites' agent adapter: run_block presses Check, cancel_block presses Stop. */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderWithAgent, askAgent } from "@/test/agent-harness"

const check = vi.fn()
const cancel = vi.fn()
let status = "pending"

vi.mock("../hooks/usePrerequisitesRun", () => ({
  usePrerequisitesRun: () => ({
    state: {
      status,
      logs: [{ line: "git 2.50.1", timestamp: "" }],
      exitCode: null,
      error: null,
      outputs: null,
      logFilePath: null,
    },
    check,
    cancel,
    error: null,
  }),
}))

import Prerequisites from "../Prerequisites"

const TOOLS = "tools:\n  - git\n"

beforeEach(() => {
  status = "pending"
  check.mockClear()
  cancel.mockClear()
})

describe("Prerequisites agent adapter", () => {
  it("checks the tools through the block's Check", async () => {
    const api = renderWithAgent(
      <Prerequisites id="tools">
        <pre>
          <code className="language-yaml">{TOOLS}</code>
        </pre>
      </Prerequisites>,
    )
    expect(await askAgent(api, { op: "run_block", blockId: "tools" })).toMatchObject({
      started: true,
    })
    expect(check).toHaveBeenCalledTimes(1)
    const detail = await askAgent(api, { op: "get_block", blockId: "tools" })
    expect(detail.logs).toEqual(["git 2.50.1"])
  })

  it("stops a running check", async () => {
    status = "running"
    const api = renderWithAgent(
      <Prerequisites id="tools">
        <pre>
          <code className="language-yaml">{TOOLS}</code>
        </pre>
      </Prerequisites>,
    )
    expect(await askAgent(api, { op: "cancel_block", blockId: "tools" })).toEqual({
      cancelled: true,
    })
    expect(cancel).toHaveBeenCalled()
  })
})
