import { describe, it, expect } from "bun:test"
import { mergeStateOf } from "./merge.ts"
import type { PullRequestMergeFacts } from "../../services/GitHubClient.ts"

const OPEN: PullRequestMergeFacts = {
  state: "open",
  merged: false,
  draft: false,
  mergeable: true,
  mergeableState: "clean",
  mergeCommitSha: null,
}
const ALL = { merge: true, squash: true, rebase: true }

describe("mergeStateOf", () => {
  it("merges a clean pull request with the first method the repository allows", () => {
    expect(mergeStateOf(OPEN, ALL)).toEqual({
      state: "open",
      mergeability: "ready",
      method: "merge",
    })
    expect(mergeStateOf(OPEN, { merge: false, squash: true, rebase: true })).toMatchObject({
      method: "squash",
    })
  })

  it("lets a failing check that isn't required through", () => {
    expect(mergeStateOf({ ...OPEN, mergeableState: "unstable" }, ALL)).toMatchObject({
      mergeability: "ready",
    })
  })

  it("says why branch protection, a stale branch, a conflict or a draft stops it", () => {
    expect(mergeStateOf({ ...OPEN, mergeableState: "blocked" }, ALL)).toMatchObject({
      mergeability: "blocked",
      reason: expect.stringContaining("required review or check"),
    })
    expect(mergeStateOf({ ...OPEN, mergeableState: "behind" }, ALL)).toMatchObject({
      mergeability: "behind",
    })
    expect(mergeStateOf({ ...OPEN, mergeable: false, mergeableState: "dirty" }, ALL)).toMatchObject(
      { mergeability: "conflicts" },
    )
    expect(mergeStateOf({ ...OPEN, draft: true }, ALL)).toMatchObject({ mergeability: "draft" })
  })

  it("waits while GitHub is still working it out", () => {
    expect(
      mergeStateOf({ ...OPEN, mergeable: null, mergeableState: "unknown" }, ALL),
    ).toMatchObject({ mergeability: "checking" })
  })

  it("knows a merged or closed pull request, and a repository with no merge method", () => {
    expect(
      mergeStateOf({ ...OPEN, state: "closed", merged: true, mergeCommitSha: "abc" }, ALL),
    ).toEqual({ state: "merged", sha: "abc" })
    expect(mergeStateOf({ ...OPEN, state: "closed" }, ALL)).toEqual({ state: "closed" })
    expect(mergeStateOf(OPEN, { merge: false, squash: false, rebase: false })).toMatchObject({
      mergeability: "blocked",
      reason: "The repository allows no merge method.",
    })
  })
})
