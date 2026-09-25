import { describe, it, expect } from "bun:test"
import { isLocalBranchConflict, prBlockOutputs } from "./git-pr-result.ts"

describe("prBlockOutputs", () => {
  // The names are what runbooks reference ({{ .outputs.<id>.PR_URL }}), and
  // output lookup is case-sensitive. Only MAIN picks them, so only a MAIN-side
  // test can catch a rename; a renderer test's mocked event supplies its own.
  it("emits exactly the documented PR_ID and PR_URL outputs", () => {
    expect(prBlockOutputs({ url: "https://github.com/o/r/pull/42", number: 42 })).toEqual({
      PR_ID: "42",
      PR_URL: "https://github.com/o/r/pull/42",
    })
  })
})

describe("isLocalBranchConflict", () => {
  it("matches git's local branch collision, which deleting the branch can fix", () => {
    expect(isLocalBranchConflict("fatal: a branch named 'runbook/1' already exists")).toBe(true)
  })

  it.each([
    // GitHub 422 on a second PR for the same head branch
    'Validation Failed: {"message":"A pull request already exists for acme:runbook/1."}',
    // GitLab 409 on a second MR for the same source branch
    '["Another open merge request already exists for this source branch: !7"]',
  ])("does not match a remote PR/MR conflict: %s", (message) => {
    expect(isLocalBranchConflict(message)).toBe(false)
  })
})
