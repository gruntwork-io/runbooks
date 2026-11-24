/** DirPicker's agent adapter: pick directories and type a path through the block's own handlers. */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderWithAgent, askAgent } from "@/test/agent-harness"

const selectDir = vi.fn(async () => {})
const setPath = vi.fn()

vi.mock("../hooks/useDirPicker", () => ({
  useDirPicker: () => ({
    levels: [{ path: "/root", selected: "", dirs: ["dev", "prod"] }],
    manualPath: "",
    error: null,
    isWorkspaceReady: true,
    selectDir,
    setPath,
  }),
}))

import DirPicker from "../DirPicker"

beforeEach(() => {
  selectDir.mockClear()
  setPath.mockClear()
})

describe("DirPicker agent adapter", () => {
  it("shows the choices and picks one", async () => {
    const api = renderWithAgent(<DirPicker id="dp" rootDir="/root" />)
    const detail = await askAgent(api, { op: "get_block", blockId: "dp" })
    expect(detail.state.levels).toEqual([{ level: 0, selected: "", choices: ["dev", "prod"] }])
    await askAgent(api, {
      op: "act_on_block",
      blockId: "dp",
      action: "select_dir",
      params: { level: 0, name: "prod" },
    })
    expect(selectDir).toHaveBeenCalledWith(0, "prod")
    expect(
      await askAgent(api, {
        op: "act_on_block",
        blockId: "dp",
        action: "select_dir",
        params: { level: 0, name: "nope" },
      }),
    ).toMatchObject({ ok: false })
  })

  it("types a path", async () => {
    const api = renderWithAgent(<DirPicker id="dp" rootDir="/root" />)
    await askAgent(api, {
      op: "act_on_block",
      blockId: "dp",
      action: "set_path",
      params: { path: "prod/us-east-1" },
    })
    expect(setPath).toHaveBeenCalledWith("prod/us-east-1")
  })
})
