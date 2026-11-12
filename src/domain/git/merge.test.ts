import { describe, it, expect } from "bun:test"
import { Effect } from "effect"
import { mergeGitHubPullRequest, mergeStateOf } from "./merge.ts"
import { makeTestGitHubClient } from "../../test-utils/TestLayer.ts"
import type { PullRequestMergeFacts } from "../../services/GitHubClient.ts"

const OPEN: PullRequestMergeFacts = {
  state: "open",
  merged: false,
  draft: false,
  mergeable: true,
  mergeableState: "clean",
  mergeCommitSha: null,
  headSha: "head1",
}
const ALL = { merge: true, squash: true, rebase: true }

describe("mergeStateOf", () => {
  it("merges a clean pull request with the first method the repository allows", () => {
    expect(mergeStateOf(OPEN, ALL)).toEqual({
      state: "open",
      mergeability: "ready",
      headSha: "head1",
      method: "merge",
    })
    expect(mergeStateOf(OPEN, { merge: false, squash: true, rebase: true })).toMatchObject({
      method: "squash",
    })
  })

  it("lets a failing check that isn't required through, with a warning", () => {
    expect(mergeStateOf({ ...OPEN, mergeableState: "unstable" }, ALL)).toMatchObject({
      mergeability: "ready",
      warning: expect.stringContaining("failing or haven't finished"),
    })
    expect(mergeStateOf(OPEN, ALL)).not.toHaveProperty("warning")
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

describe("mergeGitHubPullRequest", () => {
  const PR = { owner: "acme", repo: "infra-live", number: 7 }
  const merges: string[] = []
  const layer = (headSha: string) =>
    makeTestGitHubClient({
      getPullRequestMergeFacts: () => Effect.succeed({ ...OPEN, headSha }),
      getRepoMergeMethods: () => Effect.succeed(ALL),
      mergePullRequest: (_token, _owner, _repo, _number, _method, sha) =>
        Effect.sync(() => {
          merges.push(sha)
          return { sha: "merged1" }
        }),
    })

  it("merges exactly the head the user saw ready", async () => {
    merges.length = 0
    const result = await Effect.runPromise(
      mergeGitHubPullRequest("t", PR, "head1").pipe(Effect.provide(layer("head1"))),
    )
    expect(result).toEqual({ sha: "merged1" })
    expect(merges).toEqual(["head1"])
  })

  it("refuses when the branch has moved since", async () => {
    merges.length = 0
    const error = await Effect.runPromise(
      mergeGitHubPullRequest("t", PR, "head1").pipe(Effect.flip, Effect.provide(layer("head2"))),
    )
    expect(error.message).toContain("new commits since GitHub said it could merge")
    expect(merges).toEqual([])
  })
})
