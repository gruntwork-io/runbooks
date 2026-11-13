import { describe, it, expect } from "vitest"
import { knownMergeConditions, mergeConditionsError, unmetMergeCondition } from "../mergeConditions"

describe("unmetMergeCondition", () => {
  const facts = { uncommittedFiles: 0, checking: false }

  it("holds with no conditions, whatever the clone has", () => {
    expect(unmetMergeCondition([], { uncommittedFiles: 3, checking: true })).toBeUndefined()
  })

  it("says how many files no-uncommitted-changes is waiting on", () => {
    const condition = ["no-uncommitted-changes"] as const
    expect(unmetMergeCondition(condition, facts)).toBeUndefined()
    expect(unmetMergeCondition(condition, { ...facts, uncommittedFiles: 1 })).toBe(
      "1 file isn't committed yet. Push it to the pull request before merging.",
    )
    expect(unmetMergeCondition(condition, { ...facts, checking: true })).toMatch(/^Checking/)
  })
})

describe("mergeConditionsError", () => {
  it("accepts known conditions with allowPullRequestMerge, and none at all", () => {
    expect(mergeConditionsError("GitHubPullRequest", true, ["no-uncommitted-changes"])).toBeNull()
    expect(mergeConditionsError("GitHubPullRequest", false, [])).toBeNull()
  })

  it("names every keyword it doesn't know", () => {
    expect(mergeConditionsError("GitHubPullRequest", true, ["a", "b"])?.message).toBe(
      `The <GitHubPullRequest> block's allowPullRequestMergeConditions names "a", "b", which aren't conditions it knows.`,
    )
  })

  it("keeps only the known conditions", () => {
    expect(knownMergeConditions(["no-uncommitted-changes", "a"])).toEqual([
      "no-uncommitted-changes",
    ])
  })
})
