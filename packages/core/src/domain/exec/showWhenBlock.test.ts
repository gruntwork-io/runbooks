import { describe, it, expect } from "bun:test"
import { describeShowWhenBlock, parseShowWhenBlock, showWhenBlockHolds } from "./showWhenBlock.ts"

describe("parseShowWhenBlock", () => {
  it("gives a block without the prop no condition", () => {
    expect(parseShowWhenBlock(undefined)).toEqual({ ok: true, condition: null })
  })

  it("reads one status or a list of them", () => {
    expect(parseShowWhenBlock({ id: "check-plan", status: "fail" })).toEqual({
      ok: true,
      condition: { id: "check-plan", statuses: ["fail"] },
    })
    expect(parseShowWhenBlock({ id: "check-plan", status: ["warn", "fail"] })).toEqual({
      ok: true,
      condition: { id: "check-plan", statuses: ["warn", "fail"] },
    })
  })

  it.each([
    ["a string", "check-plan", "must be an object"],
    ["a list", ["check-plan"], "must be an object"],
    ["no id", { status: "fail" }, "needs the id of a block"],
    ["an empty id", { id: "", status: "fail" }, "needs the id of a block"],
    ["no status", { id: "check-plan" }, "status must be success, warn, fail"],
    ["an unknown status", { id: "check-plan", status: "failed" }, "status must be"],
    ["an empty list", { id: "check-plan", status: [] }, "status must be"],
    ["an unknown key", { id: "check-plan", status: "fail", block: "x" }, "not block"],
  ])("rejects %s", (_name, value, message) => {
    const parsed = parseShowWhenBlock(value)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain(message)
  })
})

describe("showWhenBlockHolds", () => {
  const condition = { id: "check-plan", statuses: ["fail"] as const }

  it("always holds without a condition", () => {
    expect(showWhenBlockHolds(null, undefined)).toBe(true)
  })

  it("holds only while the named block's latest run ended as it says", () => {
    expect(showWhenBlockHolds(condition, "fail")).toBe(true)
    expect(showWhenBlockHolds(condition, "success")).toBe(false)
    expect(showWhenBlockHolds(condition, "warn")).toBe(false)
  })

  it("doesn't hold before the named block has run, or while it runs", () => {
    expect(showWhenBlockHolds(condition, undefined)).toBe(false)
    expect(showWhenBlockHolds(condition, "pending")).toBe(false)
    expect(showWhenBlockHolds(condition, "running")).toBe(false)
  })
})

describe("describeShowWhenBlock", () => {
  it("names the block and each result", () => {
    expect(describeShowWhenBlock({ id: "check-plan", statuses: ["warn", "fail"] })).toBe(
      '"check-plan" ends with a warning or fails',
    )
  })
})
