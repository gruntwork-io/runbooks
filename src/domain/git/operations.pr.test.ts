/**
 * The PR/MR flow: the shared git half (runGitSteps, reached through
 * createPullRequest and createMergeRequest) and GitHub labeling.
 *
 * The resume tests stub GitClient to pin the step sequence; the last block
 * drives the live GitCliClient against real repositories, because the bug it
 * guards (a retry dying on "a branch named … already exists") only shows up
 * with real git state left behind by a failed attempt.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect, Layer } from "effect"
import { createPullRequest, createMergeRequest } from "./operations.ts"
import type { CreatePullRequestParams } from "./operations.ts"
import { makeTestLayer, makeTestGitHubClient } from "../../test-utils/TestLayer.ts"
import type { CreatePRParams } from "../../services/GitHubClient.ts"
import { GitError, GitHubApiError } from "../../errors/index.ts"
import { GitCliClientLive } from "../../layers/GitCliClient.ts"
import { ChildProcessSpawnerLive } from "../../layers/ChildProcessSpawner.ts"
import { NodeFileSystemLive } from "../../layers/NodeFileSystem.ts"

const params: CreatePullRequestParams = {
  owner: "acme",
  repo: "infra",
  title: "My PR",
  body: "Body",
  baseBranch: "main",
  headBranch: "runbook/123",
  commitMessage: "Changes",
  repoPath: "/repo",
}

const openedPr = (p: CreatePRParams) =>
  Effect.succeed({ url: "https://github.com/acme/infra/pull/42", number: 42, branch: p.headBranch })

// ---------------------------------------------------------------------------
// runGitSteps: guard and resume
// ---------------------------------------------------------------------------

describe("runGitSteps", () => {
  it("resumes on the head branch when HEAD is already on it: no checkout -b, commits what is staged, pushes", async () => {
    const steps: string[] = []
    const logs: string[] = []

    const layer = makeTestLayer({
      git: {
        getCurrentBranch: () => Effect.succeed("runbook/123"),
        status: () => Effect.succeed([{ path: "new.tf", status: "A" }]),
        createBranch: () => Effect.sync(() => void steps.push("createBranch")),
        stageAll: () => Effect.sync(() => void steps.push("stageAll")),
        commit: () => Effect.sync(() => void steps.push("commit")),
        push: () => Effect.sync(() => void steps.push("push")),
      },
      github: { createPullRequest: (_token, p) => openedPr(p) },
    })

    const pr = await Effect.runPromise(
      createPullRequest("tok", params, (l) => logs.push(l)).pipe(Effect.provide(layer)),
    )

    expect(steps).toEqual(["stageAll", "commit", "push"])
    expect(pr.number).toBe(42)
    expect(logs).toContain("Resuming on existing branch runbook/123…")
  })

  it("on a resumed branch with nothing staged, skips the commit but still pushes", async () => {
    const steps: string[] = []

    const layer = makeTestLayer({
      git: {
        getCurrentBranch: () => Effect.succeed("runbook/123"),
        // An embedded repo left out of staging stays untracked; it must not
        // count as something to commit.
        status: () => Effect.succeed([{ path: "sub/", status: "??" }]),
        // The earlier attempt's commit is still ahead of the base.
        hasCommitsNotIn: () => Effect.succeed(true),
        createBranch: () => Effect.sync(() => void steps.push("createBranch")),
        stageAll: () => Effect.sync(() => void steps.push("stageAll")),
        commit: () => Effect.sync(() => void steps.push("commit")),
        push: () => Effect.sync(() => void steps.push("push")),
      },
      github: { createPullRequest: (_token, p) => openedPr(p) },
    })

    await Effect.runPromise(createPullRequest("tok", params).pipe(Effect.provide(layer)))

    expect(steps).toEqual(["stageAll", "push"])
  })

  it("on a fresh branch, stages before creating the branch, then commits and pushes", async () => {
    const steps: string[] = []

    const layer = makeTestLayer({
      git: {
        getCurrentBranch: () => Effect.succeed("main"),
        status: () => Effect.succeed([{ path: "new.tf", status: "A" }]),
        createBranch: () => Effect.sync(() => void steps.push("createBranch")),
        stageAll: () => Effect.sync(() => void steps.push("stageAll")),
        commit: () => Effect.sync(() => void steps.push("commit")),
        push: () => Effect.sync(() => void steps.push("push")),
      },
      github: { createPullRequest: (_token, p) => openedPr(p) },
    })

    await Effect.runPromise(createPullRequest("tok", params).pipe(Effect.provide(layer)))

    expect(steps).toEqual(["stageAll", "createBranch", "commit", "push"])
  })

  it("with nothing staged, measures HEAD against origin's base, else the local base branch", async () => {
    const steps: string[] = []
    const refs: string[] = []

    const layer = makeTestLayer({
      git: {
        getCurrentBranch: () => Effect.succeed("runbook/122"),
        status: () => Effect.succeed([]),
        // No origin/main (e.g. origin was never fetched); the local main is behind HEAD.
        hasCommitsNotIn: (_repoPath, ref) =>
          Effect.suspend(() => {
            refs.push(ref)
            return ref.startsWith("refs/remotes/")
              ? Effect.fail(new GitError({ command: "git rev-list", stderr: "bad revision", exitCode: 128 }))
              : Effect.succeed(true)
          }),
        createBranch: () => Effect.sync(() => void steps.push("createBranch")),
        stageAll: () => Effect.sync(() => void steps.push("stageAll")),
        commit: () => Effect.sync(() => void steps.push("commit")),
        push: () => Effect.sync(() => void steps.push("push")),
      },
      github: { createPullRequest: (_token, p) => openedPr(p) },
    })

    await Effect.runPromise(createPullRequest("tok", params).pipe(Effect.provide(layer)))

    expect(refs).toEqual(["refs/remotes/origin/main", "refs/heads/main"])
    expect(steps).toEqual(["stageAll", "createBranch", "push"])
  })

  it.each([
    ["the base branch", { headBranch: "release-1", baseBranch: "release-1" }],
    ["a protected branch", { headBranch: "main", baseBranch: "develop" }],
  ])("refuses a head branch that is %s before touching git", async (_label, branches) => {
    const steps: string[] = []

    // HEAD is on the requested head branch, i.e. exactly the state in which
    // resuming would otherwise commit and push straight to it.
    const layer = makeTestLayer({
      git: {
        getCurrentBranch: () => Effect.succeed(branches.headBranch),
        status: () => Effect.succeed([{ path: "new.tf", status: "A" }]),
        createBranch: () => Effect.sync(() => void steps.push("createBranch")),
        stageAll: () => Effect.sync(() => void steps.push("stageAll")),
        commit: () => Effect.sync(() => void steps.push("commit")),
        push: () => Effect.sync(() => void steps.push("push")),
      },
      github: {
        createPullRequest: (_token, p) =>
          Effect.sync(() => void steps.push("createPullRequest")).pipe(Effect.zipRight(openedPr(p))),
      },
    })

    const result = await Effect.runPromise(
      createPullRequest("tok", { ...params, ...branches }).pipe(Effect.either, Effect.provide(layer)),
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({
        stderr: expect.stringContaining(`Refusing to commit to ${branches.headBranch}`),
      })
    }
    expect(steps).toEqual([])
  })

  it("applies the same resume to merge requests", async () => {
    const steps: string[] = []

    const layer = makeTestLayer({
      git: {
        getRemoteUrl: () => Effect.succeed("https://gitlab.com/acme/infra.git"),
        getCurrentBranch: () => Effect.succeed("runbook/123"),
        status: () => Effect.succeed([]),
        hasCommitsNotIn: () => Effect.succeed(true),
        createBranch: () => Effect.sync(() => void steps.push("createBranch")),
        stageAll: () => Effect.sync(() => void steps.push("stageAll")),
        commit: () => Effect.sync(() => void steps.push("commit")),
        push: () => Effect.sync(() => void steps.push("push")),
      },
      gitlab: {
        createMergeRequest: (_token, p) =>
          Effect.succeed({ url: "https://gitlab.com/acme/infra/-/merge_requests/7", number: 7, branch: p.headBranch }),
      },
    })

    await Effect.runPromise(createMergeRequest("tok", params).pipe(Effect.provide(layer)))

    expect(steps).toEqual(["stageAll", "push"])
  })
})

// ---------------------------------------------------------------------------
// createPullRequest: labels
// ---------------------------------------------------------------------------

describe("createPullRequest labels", () => {
  const gitOk = {
    status: () => Effect.succeed([{ path: "new.tf", status: "A" }]),
    createBranch: () => Effect.void,
    stageAll: () => Effect.void,
    commit: () => Effect.void,
    push: () => Effect.void,
  }

  it("opens the PR without labels, then adds them exactly once", async () => {
    let prParams: CreatePRParams | undefined
    const labelCalls: unknown[][] = []

    const layer = makeTestLayer({
      git: gitOk,
      github: {
        createPullRequest: (_token, p) => {
          prParams = p
          return openedPr(p)
        },
        addLabels: (...args) => Effect.sync(() => void labelCalls.push(args)),
      },
    })

    const pr = await Effect.runPromise(
      createPullRequest("tok", { ...params, labels: ["enhancement", "terraform"] }).pipe(
        Effect.provide(layer),
      ),
    )

    expect(pr.number).toBe(42)
    expect(prParams).toBeDefined()
    expect(prParams && "labels" in prParams).toBe(false)
    expect(labelCalls).toEqual([["tok", "acme", "infra", 42, ["enhancement", "terraform"]]])
  })

  it("makes no label call when there are no labels", async () => {
    let labelCalls = 0

    const layer = makeTestLayer({
      git: gitOk,
      github: {
        createPullRequest: (_token, p) => openedPr(p),
        addLabels: () => Effect.sync(() => void labelCalls++),
      },
    })

    await Effect.runPromise(
      createPullRequest("tok", { ...params, labels: [] }).pipe(Effect.provide(layer)),
    )

    expect(labelCalls).toBe(0)
  })

  it("still returns the PR when labeling fails, and reports a warning", async () => {
    const logs: string[] = []

    const layer = makeTestLayer({
      git: gitOk,
      github: {
        createPullRequest: (_token, p) => openedPr(p),
        addLabels: () => Effect.fail(new GitHubApiError({ status: 502, message: "Bad Gateway" })),
      },
    })

    const result = await Effect.runPromise(
      createPullRequest("tok", { ...params, labels: ["enhancement"] }, (l) => logs.push(l)).pipe(
        Effect.either,
        Effect.provide(layer),
      ),
    )

    expect(result._tag).toBe("Right")
    if (result._tag === "Right") {
      expect(result.right.url).toBe("https://github.com/acme/infra/pull/42")
    }
    expect(logs).toContain(
      "Warning: PR #42 was created but labels could not be applied: Bad Gateway",
    )
  })
})

// ---------------------------------------------------------------------------
// Real git: a retry after a failed push
// ---------------------------------------------------------------------------

/** Run git with deterministic config, independent of the machine's. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...args],
    { cwd, stdio: ["pipe", "pipe", "pipe"] },
  ).toString()
}

describe("createPullRequest retry (real git)", () => {
  let tmp: string
  let work: string
  let remote: string

  // Live git and filesystem; only the GitHub API is stubbed. validateToken is
  // left unconfigured, so the commit uses the repo's own identity below.
  const layer = Layer.mergeAll(
    GitCliClientLive.pipe(Layer.provide(ChildProcessSpawnerLive)),
    NodeFileSystemLive,
    makeTestGitHubClient({ createPullRequest: (_token, p) => openedPr(p) }),
  )

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-pr-retry-"))
    remote = path.join(tmp, "remote.git")
    work = path.join(tmp, "work")
    fs.mkdirSync(work)
    git(tmp, "init", "--bare", remote)
    git(work, "init")
    git(work, "config", "user.name", "Test")
    git(work, "config", "user.email", "test@example.com")
    git(work, "config", "commit.gpgsign", "false")
    fs.writeFileSync(path.join(work, "README.md"), "hello\n")
    git(work, "add", "README.md")
    git(work, "commit", "-m", "initial")
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("resumes on the branch a failed push left behind and pushes it", async () => {
    const retryParams = { ...params, repoPath: work }
    fs.writeFileSync(path.join(work, "generated.tf"), "resource {}\n")

    // Attempt 1: origin points nowhere, so the push fails after the branch was
    // created and the change committed on it.
    git(work, "remote", "add", "origin", path.join(tmp, "missing.git"))
    const first = await Effect.runPromise(
      createPullRequest("tok", retryParams).pipe(Effect.either, Effect.provide(layer)),
    )
    expect(first._tag).toBe("Left")
    expect(git(work, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("runbook/123")

    // Attempt 2: same branch name, remote fixed, nothing new to stage.
    git(work, "remote", "set-url", "origin", remote)
    const logs: string[] = []
    const second = await Effect.runPromise(
      createPullRequest("tok", retryParams, (l) => logs.push(l)).pipe(
        Effect.either,
        Effect.provide(layer),
      ),
    )

    expect(second).toMatchObject({ _tag: "Right", right: { number: 42 } })
    expect(logs).toContain("Resuming on existing branch runbook/123…")
    // The commit from attempt 1 reached the remote.
    expect(git(remote, "show", "--name-only", "--format=", "runbook/123").trim()).toBe(
      "generated.tf",
    )
  })

  it("pushes the failed attempt's commit under a new branch name", async () => {
    fs.writeFileSync(path.join(work, "generated.tf"), "resource {}\n")

    // Attempt 1 fails at the push, leaving the change committed on runbook/123.
    git(work, "remote", "add", "origin", path.join(tmp, "missing.git"))
    const first = await Effect.runPromise(
      createPullRequest("tok", { ...params, repoPath: work }).pipe(Effect.either, Effect.provide(layer)),
    )
    expect(first._tag).toBe("Left")

    // Attempt 2: a new name, with nothing left to stage.
    git(work, "remote", "set-url", "origin", remote)
    const logs: string[] = []
    const second = await Effect.runPromise(
      createPullRequest("tok", { ...params, headBranch: "runbook/124", repoPath: work }, (l) =>
        logs.push(l),
      ).pipe(Effect.either, Effect.provide(layer)),
    )

    expect(second).toMatchObject({ _tag: "Right", right: { number: 42, branch: "runbook/124" } })
    expect(logs).toContain("No new changes to commit; pushing the existing commits…")
    expect(git(remote, "show", "--name-only", "--format=", "runbook/124").trim()).toBe(
      "generated.tf",
    )
  })

  it("with nothing new, fails with nothing to commit before creating the branch", async () => {
    // origin's main is the same commit as HEAD: there is nothing for a PR.
    git(work, "remote", "add", "origin", remote)
    git(work, "push", "origin", "main")
    git(work, "fetch", "origin")

    const result = await Effect.runPromise(
      createPullRequest("tok", { ...params, repoPath: work }).pipe(Effect.either, Effect.provide(layer)),
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({ stderr: expect.stringContaining("Nothing to commit") })
    }
    // HEAD stayed put, so the next attempt starts from the same place.
    expect(git(work, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main")
    expect(git(work, "branch", "--list", "runbook/123").trim()).toBe("")
  })
})
