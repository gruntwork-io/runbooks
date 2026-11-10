import { describe, expect, it } from "vitest"
import { nextFrom, stageOf, type FlowFacts } from "../flow"

const facts = (over: Partial<FlowFacts> = {}): FlowFacts => ({
  inputsValid: true,
  hasRepo: true,
  pr: "none",
  applied: false,
  ...over,
})

describe("stageOf", () => {
  it("asks for the inputs first", () => {
    expect(stageOf(facts({ inputsValid: false, pr: "merged", applied: true }))).toBe("fill")
  })

  it("follows a pull request from opening to merged and applied", () => {
    expect(stageOf(facts())).toBe("open-pr")
    expect(stageOf(facts({ pr: "open" }))).toBe("merge-or-apply")
    expect(stageOf(facts({ pr: "behind", applied: true }))).toBe("push")
    expect(stageOf(facts({ pr: "open", applied: true }))).toBe("merge")
    expect(stageOf(facts({ pr: "merged" }))).toBe("apply")
    expect(stageOf(facts({ pr: "merged", applied: true }))).toBe("done")
  })

  it("asks for a new pull request when the inputs changed after a merge", () => {
    expect(stageOf(facts({ pr: "superseded", applied: true }))).toBe("open-pr")
  })

  it("asks for a pull request even after an apply", () => {
    expect(stageOf(facts({ applied: true }))).toBe("open-pr")
  })

  it("skips the pull request without a repository", () => {
    expect(stageOf(facts({ hasRepo: false }))).toBe("apply")
    expect(stageOf(facts({ hasRepo: false, applied: true }))).toBe("done")
  })
})

describe("nextFrom", () => {
  it("leads UI to Code, and Code to PR or, without a repository, to Apply", () => {
    expect(nextFrom("ui", "fill", true)).toEqual({ tab: "code", label: "Next" })
    expect(nextFrom("code", "open-pr", true)).toEqual({ tab: "pr", label: "Next" })
    expect(nextFrom("code", "apply", false)).toEqual({ tab: "apply", label: "Next" })
  })

  it("sends Apply back to an open pull request once it's applied", () => {
    expect(nextFrom("apply", "merge", true)).toEqual({
      tab: "pr",
      label: "Merge the pull request",
    })
    expect(nextFrom("apply", "open-pr", true)).toEqual({
      tab: "pr",
      label: "Open the pull request",
    })
  })

  it("sends PR to Apply once it's merged", () => {
    expect(nextFrom("pr", "apply", true)).toEqual({ tab: "apply", label: "Apply" })
  })

  it("leads nowhere while either order works, or when it's done", () => {
    expect(nextFrom("pr", "merge-or-apply", true)).toBeUndefined()
    expect(nextFrom("apply", "merge-or-apply", true)).toBeUndefined()
    expect(nextFrom("apply", "done", true)).toBeUndefined()
    expect(nextFrom("pr", "merge", true)).toBeUndefined()
  })
})
