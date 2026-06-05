import { describe, it, expect } from "bun:test"
import { Effect } from "effect"
import {
  parseOwnerRepoFromURL,
  isValidGitURL,
  deleteBranch,
  resolveClonePaths,
  countFiles,
  createMergeRequest,
} from "./operations.ts"
import { makeTestLayer } from "../../test-utils/TestLayer.ts"
import { GitLabApiError } from "../../errors/index.ts"

// ---------------------------------------------------------------------------
// parseOwnerRepoFromURL
// ---------------------------------------------------------------------------

describe("parseOwnerRepoFromURL", () => {
  it("parses HTTPS URL", () => {
    const result = parseOwnerRepoFromURL("https://github.com/gruntwork-io/runbooks")
    expect(result).toEqual({ owner: "gruntwork-io", repo: "runbooks" })
  })

  it("parses HTTPS URL with .git suffix", () => {
    const result = parseOwnerRepoFromURL("https://github.com/gruntwork-io/runbooks.git")
    expect(result).toEqual({ owner: "gruntwork-io", repo: "runbooks" })
  })

  it("parses SSH URL", () => {
    const result = parseOwnerRepoFromURL("git@github.com:gruntwork-io/runbooks.git")
    expect(result).toEqual({ owner: "gruntwork-io", repo: "runbooks" })
  })

  it("parses SSH URL without .git suffix", () => {
    const result = parseOwnerRepoFromURL("git@github.com:owner/repo")
    expect(result).toEqual({ owner: "owner", repo: "repo" })
  })

  it("returns undefined for invalid URL", () => {
    expect(parseOwnerRepoFromURL("not-a-url")).toBeUndefined()
  })

  it("returns undefined for URL with only owner", () => {
    expect(parseOwnerRepoFromURL("https://github.com/owner")).toBeUndefined()
  })

  it("parses GitLab HTTPS URL", () => {
    const result = parseOwnerRepoFromURL("https://gitlab.com/group/project.git")
    expect(result).toEqual({ owner: "group", repo: "project" })
  })

  it("parses SSH URL with custom host", () => {
    const result = parseOwnerRepoFromURL("git@gitlab.com:group/project.git")
    expect(result).toEqual({ owner: "group", repo: "project" })
  })

  it("parses GitLab HTTPS URL with nested groups (full group path as owner)", () => {
    const result = parseOwnerRepoFromURL(
      "https://gitlab.com/group/subgroup/project.git",
    )
    expect(result).toEqual({ owner: "group/subgroup", repo: "project" })
  })

  it("parses GitLab HTTPS URL with deeply nested groups", () => {
    const result = parseOwnerRepoFromURL(
      "https://gitlab.com/group/subgroup/deeper/project",
    )
    expect(result).toEqual({ owner: "group/subgroup/deeper", repo: "project" })
  })

  it("parses GitLab SSH URL with nested groups", () => {
    const result = parseOwnerRepoFromURL(
      "git@gitlab.com:group/subgroup/project.git",
    )
    expect(result).toEqual({ owner: "group/subgroup", repo: "project" })
  })

  it("parses self-hosted GitLab SSH URL with nested groups", () => {
    const result = parseOwnerRepoFromURL(
      "git@gitlab.example.com:group/subgroup/project.git",
    )
    expect(result).toEqual({ owner: "group/subgroup", repo: "project" })
  })

  it("strips .git suffix from HTTPS URL with trailing slash absent", () => {
    const result = parseOwnerRepoFromURL("https://github.com/owner/repo.git")
    expect(result).toEqual({ owner: "owner", repo: "repo" })
  })

  it("handles HTTPS URL with trailing slash", () => {
    const result = parseOwnerRepoFromURL("https://github.com/owner/repo/")
    expect(result).toEqual({ owner: "owner", repo: "repo" })
  })

  it("handles HTTPS URL with .git and trailing slash", () => {
    // Trailing slash after .git keeps the suffix as part of the segment;
    // document the actual behaviour so a future tightening is intentional.
    const result = parseOwnerRepoFromURL("https://github.com/owner/repo.git/")
    expect(result).toEqual({ owner: "owner", repo: "repo" })
  })
})

// ---------------------------------------------------------------------------
// isValidGitURL
// ---------------------------------------------------------------------------

describe("isValidGitURL", () => {
  it.each([
    "https://github.com/owner/repo",
    "https://github.com/owner/repo.git",
    "http://github.com/owner/repo",
    "git@github.com:owner/repo.git",
    "git@github.com:owner/repo",
    "git@gitlab.com:group/project",
  ])("returns true for %s", (url) => {
    expect(isValidGitURL(url)).toBe(true)
  })

  it.each([
    "",
    "not-a-url",
    "https://github.com",
    "https://github.com/owner",
    "ftp://github.com/owner/repo",
  ])("returns false for %s", (url) => {
    expect(isValidGitURL(url)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// deleteBranch — protected branch guard
// ---------------------------------------------------------------------------

describe("deleteBranch", () => {
  const protectedBranches = [
    "main", "master", "develop", "dev",
    "staging", "release", "prod", "production",
  ]

  it.each(protectedBranches)(
    "rejects deleting protected branch: %s",
    async (branch) => {
      const layer = makeTestLayer({
        git: {
          deleteBranch: () => Effect.void,
        },
      })

      const result = await Effect.runPromise(
        deleteBranch("/repo", branch).pipe(
          Effect.either,
          Effect.provide(layer),
        ),
      )
      expect(result._tag).toBe("Left")
    },
  )

  it("allows deleting non-protected branch", async () => {
    const layer = makeTestLayer({
      git: {
        deleteBranch: () => Effect.void,
      },
    })

    const result = await Effect.runPromise(
      deleteBranch("/repo", "feature/my-branch").pipe(
        Effect.either,
        Effect.provide(layer),
      ),
    )
    expect(result._tag).toBe("Right")
  })
})

// ---------------------------------------------------------------------------
// resolveClonePaths
// ---------------------------------------------------------------------------

describe("resolveClonePaths", () => {
  it("uses localPath when provided", async () => {
    const layer = makeTestLayer()
    const result = await Effect.runPromise(
      resolveClonePaths("my-dir", "https://github.com/o/r", "/work").pipe(
        Effect.provide(layer),
      ),
    )
    expect(result.absolutePath).toBe("/work/my-dir")
    expect(result.relativePath).toBe("my-dir")
  })

  it("extracts repo name from URL when no localPath", async () => {
    const layer = makeTestLayer()
    const result = await Effect.runPromise(
      resolveClonePaths(undefined, "https://github.com/owner/my-repo.git", "/work").pipe(
        Effect.provide(layer),
      ),
    )
    expect(result.absolutePath).toBe("/work/my-repo")
  })

  it("handles absolute localPath", async () => {
    const layer = makeTestLayer()
    const result = await Effect.runPromise(
      resolveClonePaths("/abs/path", "https://github.com/o/r", "/work").pipe(
        Effect.provide(layer),
      ),
    )
    expect(result.absolutePath).toBe("/abs/path")
  })

  it("falls back to 'repo' when URL cannot be parsed", async () => {
    const layer = makeTestLayer()
    const result = await Effect.runPromise(
      resolveClonePaths(undefined, "not-a-url", "/work").pipe(
        Effect.provide(layer),
      ),
    )
    expect(result.absolutePath).toBe("/work/repo")
  })
})

// ---------------------------------------------------------------------------
// countFiles
// ---------------------------------------------------------------------------

describe("countFiles", () => {
  it("counts files excluding .git", async () => {
    const layer = makeTestLayer({
      commands: [
        {
          command: "git",
          args: ["ls-files"],
          outputLines: ["file1.txt", "file2.txt"],
          exitCode: 0,
        },
      ],
    })
    const count = await Effect.runPromise(
      countFiles("/repo").pipe(Effect.provide(layer)),
    )
    expect(count).toBe(2)
  })

  it("returns 0 for empty directory", async () => {
    const layer = makeTestLayer({ files: {} })
    const count = await Effect.runPromise(
      countFiles("/empty").pipe(Effect.provide(layer)),
    )
    expect(count).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// createMergeRequest
// ---------------------------------------------------------------------------

describe("createMergeRequest", () => {
  const params = {
    owner: "group/subgroup",
    repo: "project",
    title: "My MR",
    body: "Body",
    baseBranch: "main",
    headBranch: "runbook/123",
    commitMessage: "Changes",
    labels: ["enhancement"],
    repoPath: "/repo",
  }

  it("runs the git steps then opens the MR with labels inline (no separate add-labels call)", async () => {
    const steps: string[] = []
    let mrLabels: string[] | undefined

    const layer = makeTestLayer({
      git: {
        createBranch: () => Effect.sync(() => void steps.push("createBranch")),
        stageAll: () => Effect.sync(() => void steps.push("stageAll")),
        commit: () => Effect.sync(() => void steps.push("commit")),
        push: () => Effect.sync(() => void steps.push("push")),
      },
      gitlab: {
        createMergeRequest: (_token, p) =>
          Effect.sync(() => {
            mrLabels = p.labels
            return { url: "https://gitlab.com/group/subgroup/project/-/merge_requests/7", number: 7, branch: p.headBranch }
          }),
      },
    })

    const result = await Effect.runPromise(
      createMergeRequest("tok", params).pipe(Effect.provide(layer)),
    )

    // git half ran in order, then the MR was opened
    expect(steps).toEqual(["createBranch", "stageAll", "commit", "push"])
    // iid surfaces as the user-facing number
    expect(result.number).toBe(7)
    expect(result.url).toContain("/merge_requests/7")
    // labels are passed to the MR create itself, not a follow-up call
    expect(mrLabels).toEqual(["enhancement"])
  })

  it("propagates a non-empty message when GitLab rejects with a 409", async () => {
    const layer = makeTestLayer({
      git: {
        createBranch: () => Effect.void,
        stageAll: () => Effect.void,
        commit: () => Effect.void,
        push: () => Effect.void,
      },
      gitlab: {
        createMergeRequest: () =>
          Effect.fail(new GitLabApiError({ status: 409, message: "Cannot Create: This merge request already exists" })),
      },
    })

    const result = await Effect.runPromise(
      createMergeRequest("tok", params).pipe(Effect.either, Effect.provide(layer)),
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(GitLabApiError)
      expect(result.left.status).toBe(409)
      expect(result.left.message).toContain("already exists")
    }
  })
})
