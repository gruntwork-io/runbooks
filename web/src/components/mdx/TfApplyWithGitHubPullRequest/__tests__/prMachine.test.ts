import { describe, expect, it } from "vitest"
import {
  INITIAL_PULL_REQUEST,
  pullRequestReducer,
  pullRequestStatus,
  unusedBranch,
  type OpenedPullRequest,
  type PullRequestAction,
  type PullRequestState,
} from "../prMachine"

const PR: OpenedPullRequest = {
  url: "https://github.com/acme/live/pull/42",
  number: 42,
  branch: "runbooks/add-group",
  title: "Add the group",
  body: "",
}
const run = (...actions: PullRequestAction[]): PullRequestState =>
  actions.reduce(pullRequestReducer, INITIAL_PULL_REQUEST)
const opened = (inputs = "A"): PullRequestAction[] => [
  { type: "open-started" },
  { type: "opened", pr: PR, inputs },
]

describe("pullRequestReducer", () => {
  it("returns to the draft with the error when opening fails", () => {
    expect(run({ type: "open-started" }, { type: "failed", error: "no access" }).phase).toEqual({
      kind: "draft",
      error: "no access",
    })
  })

  it("does one task at a time on an open pull request", () => {
    const pushing = run(...opened(), { type: "task-started", task: "pushing" })
    expect(pullRequestReducer(pushing, { type: "task-started", task: "merging" })).toBe(pushing)
    expect(pullRequestReducer(pushing, { type: "pushed", inputs: "B" }).phase).toEqual({
      kind: "open",
      pr: PR,
      pushedWith: "B",
      task: undefined,
    })
  })

  it("keeps the pull request open, with the error, when a task fails", () => {
    const state = run(
      ...opened(),
      { type: "task-started", task: "merging" },
      { type: "failed", error: "conflict" },
    )
    expect(state.phase).toMatchObject({ kind: "open", error: "conflict", task: undefined })
  })

  it("merges with the inputs the branch has, then starts a new draft that remembers it", () => {
    const merged = run(
      ...opened("A"),
      { type: "task-started", task: "merging" },
      { type: "merged" },
    )
    expect(merged.phase).toEqual({ kind: "merged", pr: PR, mergedWith: "A" })
    const next = pullRequestReducer(merged, { type: "start-new" })
    expect(next.phase).toEqual({ kind: "draft" })
    expect(next.merged).toEqual([PR])
  })
})

describe("pullRequestStatus", () => {
  it("follows the inputs against the branch", () => {
    const open = run(...opened("A")).phase
    expect(pullRequestStatus(INITIAL_PULL_REQUEST.phase, "A")).toBe("none")
    expect(pullRequestStatus(open, "A")).toBe("open")
    expect(pullRequestStatus(open, "B")).toBe("behind")
  })

  it("is superseded when the inputs change after a merge", () => {
    const merged = run(
      ...opened("A"),
      { type: "task-started", task: "merging" },
      { type: "merged" },
    )
    expect(pullRequestStatus(merged.phase, "A")).toBe("merged")
    expect(pullRequestStatus(merged.phase, "B")).toBe("superseded")
  })
})

it("unusedBranch adds a number to a branch the block used", () => {
  expect(unusedBranch("runbooks/x", [])).toBe("runbooks/x")
  expect(unusedBranch("runbooks/add-group", [PR])).toBe("runbooks/add-group-2")
  expect(unusedBranch("runbooks/add-group", [PR, { ...PR, branch: "runbooks/add-group-2" }])).toBe(
    "runbooks/add-group-3",
  )
})
