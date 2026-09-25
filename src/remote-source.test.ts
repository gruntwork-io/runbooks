import { describe, it, expect } from "bun:test"
import { Effect } from "effect"
import {
  parseRemoteSource,
  needsRefResolution,
  adjustBlobPath,
  resolveRef,
} from "./remote-source.ts"
import { makeTestSpawner } from "./test-utils/TestSpawner.ts"
import type { GitError } from "./errors/index.ts"

function parse(url: string) {
  return Effect.runSync(parseRemoteSource(url))
}

describe("parseRemoteSource", () => {
  describe("git:: prefix URLs", () => {
    it("parses git::https URL with ref", () => {
      const result = parse("git::https://github.com/owner/repo.git//modules/vpc?ref=v1.0")
      expect(result.host).toBe("github.com")
      expect(result.owner).toBe("owner")
      expect(result.repo).toBe("repo")
      expect(result.path).toBe("modules/vpc")
      expect(result.ref).toBe("v1.0")
      expect(result.cloneURL).toBe("https://github.com/owner/repo.git")
      expect(result.isBlobURL).toBe(false)
    })

    it("parses git::https URL without ref", () => {
      const result = parse("git::https://github.com/owner/repo.git//modules/vpc")
      expect(result.path).toBe("modules/vpc")
      expect(result.ref).toBeUndefined()
    })

    it("parses git::https URL with GitLab nested groups", () => {
      const result = parse(
        "git::https://gitlab.com/group/subgroup/project.git//modules/vpc?ref=v1.0",
      )
      expect(result.host).toBe("gitlab.com")
      expect(result.owner).toBe("group/subgroup")
      expect(result.repo).toBe("project")
      expect(result.path).toBe("modules/vpc")
      expect(result.ref).toBe("v1.0")
      expect(result.cloneURL).toBe(
        "https://gitlab.com/group/subgroup/project.git",
      )
    })

    it("parses git::https URL on a self-hosted host with nested groups", () => {
      const result = parse(
        "git::https://gitlab.example.com/group/subgroup/project.git//path?ref=main",
      )
      expect(result.host).toBe("gitlab.example.com")
      expect(result.owner).toBe("group/subgroup")
      expect(result.repo).toBe("project")
      expect(result.cloneURL).toBe(
        "https://gitlab.example.com/group/subgroup/project.git",
      )
    })

    it("parses git::https URL without a //subdir (runbook at the repo root)", () => {
      const result = parse("git::https://github.com/gruntwork-io/runbooks.git?ref=v1.0")
      expect(result.owner).toBe("gruntwork-io")
      expect(result.repo).toBe("runbooks")
      expect(result.path).toBeUndefined()
      expect(result.ref).toBe("v1.0")
      expect(result.cloneURL).toBe("https://github.com/gruntwork-io/runbooks.git")
    })

    it.each([
      "git::https://github.com/owner/repo.git//modules/vpc?ref=v1.0&depth=1",
      "git::https://github.com/owner/repo.git//modules/vpc?depth=1&ref=v1.0",
    ])("reads only ref from the query: %s", (url) => {
      const result = parse(url)
      expect(result.path).toBe("modules/vpc")
      expect(result.ref).toBe("v1.0")
    })

    it.each([
      "git::https://github.com/repo.git//modules/vpc", // no owner
      "git::https://github.com/group/subgroup/repo.git//modules/vpc", // GitHub has no nested groups
      "git::ssh://git@github.com/owner/repo.git//modules/vpc",
    ])("rejects %s", (url) => {
      expect(() => parse(url)).toThrow()
    })
  })

  describe("GitHub shorthand", () => {
    it("parses shorthand with ref", () => {
      const result = parse("github.com/owner/repo//modules/vpc?ref=main")
      expect(result.host).toBe("github.com")
      expect(result.owner).toBe("owner")
      expect(result.repo).toBe("repo")
      expect(result.path).toBe("modules/vpc")
      expect(result.ref).toBe("main")
    })

    it("parses shorthand without a //subdir", () => {
      const result = parse("github.com/owner/repo?ref=v1")
      expect(result.owner).toBe("owner")
      expect(result.repo).toBe("repo")
      expect(result.path).toBeUndefined()
      expect(result.ref).toBe("v1")
      expect(result.cloneURL).toBe("https://github.com/owner/repo.git")
    })
  })

  describe("GitLab shorthand", () => {
    it("parses shorthand with nested groups, subdir and ref", () => {
      const result = parse("gitlab.com/group/subgroup/project//modules/vpc?ref=v1")
      expect(result.host).toBe("gitlab.com")
      expect(result.owner).toBe("group/subgroup")
      expect(result.repo).toBe("project")
      expect(result.path).toBe("modules/vpc")
      expect(result.ref).toBe("v1")
      expect(result.cloneURL).toBe("https://gitlab.com/group/subgroup/project.git")
    })

    it.each([
      "gitlab.com/group/project/-/tree/main/x",
      "git::https://gitlab.com/group/project/-/tree/main/x",
    ])("rejects a browser URL rather than reading it as nested groups: %s", (url) => {
      // `-` is reserved by GitLab, so it is never a group or project name.
      expect(() => parse(url)).toThrow()
    })
  })

  describe("GitHub browser URLs", () => {
    it("parses tree URL", () => {
      const result = parse("https://github.com/owner/repo/tree/main/path/to/dir")
      expect(result.host).toBe("github.com")
      expect(result.owner).toBe("owner")
      expect(result.repo).toBe("repo")
      expect(result.path).toBe("main/path/to/dir")
      expect(result.isBlobURL).toBe(false)
    })

    it("parses blob URL", () => {
      const result = parse("https://github.com/owner/repo/blob/main/path/to/file.ts")
      expect(result.path).toBe("main/path/to/file.ts")
      expect(result.isBlobURL).toBe(true)
    })

    it.each([
      ["https://github.com/owner/repo/tree/main/path/to/dir#readme", "main/path/to/dir"],
      ["https://github.com/owner/repo/tree/main#readme", "main"],
      ["https://github.com/owner/repo/tree/main/path/to/dir/", "main/path/to/dir"],
      ["https://github.com/owner/repo/blob/main/path/runbook.mdx?plain=1", "main/path/runbook.mdx"],
    ])("drops the query, fragment and trailing slash: %s", (url, path) => {
      expect(parse(url).path).toBe(path)
    })

    it("decodes a percent-encoded path", () => {
      const result = parse("https://github.com/owner/repo/tree/main/my%20runbook")
      expect(result.path).toBe("main/my runbook")
    })

    it.each([
      "https://github.com/owner/repo/tree/main/../../../etc",
      "https://github.com/owner/repo/tree/main/runbooks/%2e%2e/%2E%2E/%2e%2e/etc",
      "https://github.com/owner/repo/tree/main/..%2F..%2F..%2Fetc",
      "github.com/owner/repo//..%2F..%2Fetc",
      "https://github.com/owner/repo/tree/main/..%5C..%5C..%5Cetc",
      "github.com/owner/repo//..%5C..%5Cetc",
      "git::https://gitlab.com/group/project.git//x/..%5C..%5Cetc?ref=v1",
    ])("never yields a `..` path segment: %s", (url) => {
      const result = Effect.runSync(Effect.either(parseRemoteSource(url)))
      if (result._tag === "Right") {
        // Windows' path.join also splits on a backslash.
        expect(result.right.path?.split(/[\\/]/) ?? []).not.toContain("..")
      }
    })

    it.each([
      "https://github.com/owner/repo/tree/main/..%5C..%5C..%5Cetc",
      "github.com/owner/repo//..%5C..%5Cetc",
      "https://gitlab.com/group/project/-/tree/main/..%5Cetc",
    ])("rejects a backslash-delimited `..` segment: %s", (url) => {
      expect(() => parse(url)).toThrow()
    })
  })

  describe("GitLab browser URLs", () => {
    it("parses tree URL", () => {
      const result = parse("https://gitlab.com/owner/repo/-/tree/main/path")
      expect(result.host).toBe("gitlab.com")
      expect(result.owner).toBe("owner")
      expect(result.repo).toBe("repo")
      expect(result.path).toBe("main/path")
    })

    it("parses blob URL", () => {
      const result = parse("https://gitlab.com/owner/repo/-/blob/main/file.ts")
      expect(result.isBlobURL).toBe(true)
    })

    it("parses tree URL with nested groups (full group path as owner)", () => {
      const result = parse(
        "https://gitlab.com/group/subgroup/project/-/tree/main/path/to/dir",
      )
      expect(result.host).toBe("gitlab.com")
      expect(result.owner).toBe("group/subgroup")
      expect(result.repo).toBe("project")
      expect(result.path).toBe("main/path/to/dir")
      expect(result.cloneURL).toBe(
        "https://gitlab.com/group/subgroup/project.git",
      )
    })

    it("parses blob URL with nested groups", () => {
      const result = parse(
        "https://gitlab.com/group/subgroup/project/-/blob/main/file.ts",
      )
      expect(result.owner).toBe("group/subgroup")
      expect(result.repo).toBe("project")
      expect(result.path).toBe("main/file.ts")
      expect(result.isBlobURL).toBe(true)
    })

    it("parses a tree URL on a self-hosted GitLab instance", () => {
      const result = parse(
        "https://gitlab.example.com/group/subgroup/project/-/tree/main/path",
      )
      expect(result.host).toBe("gitlab.example.com")
      expect(result.owner).toBe("group/subgroup")
      expect(result.repo).toBe("project")
      expect(result.path).toBe("main/path")
      expect(result.cloneURL).toBe(
        "https://gitlab.example.com/group/subgroup/project.git",
      )
    })

    it("keeps the port of a self-hosted GitLab instance", () => {
      const result = parse("https://gitlab.example.com:8443/group/project/-/tree/main/path")
      expect(result.host).toBe("gitlab.example.com:8443")
      expect(result.cloneURL).toBe("https://gitlab.example.com:8443/group/project.git")
    })
  })

  describe("plain repo URLs", () => {
    it("parses GitHub repo URL", () => {
      const result = parse("https://github.com/owner/repo")
      expect(result.host).toBe("github.com")
      expect(result.owner).toBe("owner")
      expect(result.repo).toBe("repo")
      expect(result.path).toBeUndefined()
      expect(result.ref).toBeUndefined()
    })

    it("parses GitLab repo URL", () => {
      const result = parse("https://gitlab.com/owner/repo")
      expect(result.host).toBe("gitlab.com")
    })

    it("parses GitLab repo URL with nested groups", () => {
      const result = parse("https://gitlab.com/group/subgroup/project")
      expect(result.host).toBe("gitlab.com")
      expect(result.owner).toBe("group/subgroup")
      expect(result.repo).toBe("project")
      expect(result.cloneURL).toBe(
        "https://gitlab.com/group/subgroup/project.git",
      )
    })

    it("parses GitLab repo URL with nested groups and .git suffix", () => {
      const result = parse("https://gitlab.com/group/subgroup/project.git")
      expect(result.owner).toBe("group/subgroup")
      expect(result.repo).toBe("project")
    })

    it("parses a plain repo URL on a self-hosted GitLab instance", () => {
      const result = parse("https://gitlab.example.com/group/subgroup/project")
      expect(result.host).toBe("gitlab.example.com")
      expect(result.owner).toBe("group/subgroup")
      expect(result.repo).toBe("project")
      expect(result.cloneURL).toBe(
        "https://gitlab.example.com/group/subgroup/project.git",
      )
    })

    it("parses a GitHub repo name that contains dots", () => {
      const result = parse("https://github.com/gruntwork-io/docs.gruntwork.io")
      expect(result.repo).toBe("docs.gruntwork.io")
      expect(result.cloneURL).toBe("https://github.com/gruntwork-io/docs.gruntwork.io.git")
    })

    it.each([
      ["https://github.com/owner/repo/", "github.com", "owner", "repo"],
      ["https://github.com/owner/repo.git/", "github.com", "owner", "repo"],
      ["https://GitHub.com/owner/repo", "github.com", "owner", "repo"],
      ["https://github.com/owner/repo?tab=readme", "github.com", "owner", "repo"],
      ["https://gitlab.com/group/project/", "gitlab.com", "group", "project"],
      ["https://gitlab.com/group/project?tab=x", "gitlab.com", "group", "project"],
    ])("normalizes %s", (url, host, owner, repo) => {
      const result = parse(url)
      expect(result.host).toBe(host)
      expect(result.owner).toBe(owner)
      expect(result.repo).toBe(repo)
      expect(result.cloneURL).toBe(`https://${host}/${owner}/${repo}.git`)
    })
  })

  describe("invalid URLs", () => {
    it("rejects empty string", () => {
      expect(() => parse("")).toThrow()
    })

    it("rejects unsupported format", () => {
      expect(() => parse("https://bitbucket.org/owner/repo")).toThrow()
    })
  })
})

describe("needsRefResolution", () => {
  it("returns true for browser-style URLs without explicit ref", () => {
    const parsed = parse("https://github.com/owner/repo/tree/main/path")
    expect(needsRefResolution(parsed)).toBe(true)
  })

  it("returns false for URLs with explicit ref", () => {
    const parsed = parse("git::https://github.com/owner/repo.git//path?ref=v1.0")
    expect(needsRefResolution(parsed)).toBe(false)
  })

  it("returns false for plain repo URLs (no path)", () => {
    const parsed = parse("https://github.com/owner/repo")
    expect(needsRefResolution(parsed)).toBe(false)
  })

  it.each([
    "git::https://github.com/owner/repo.git//modules/vpc",
    "github.com/owner/repo//modules/vpc",
  ])("returns false for an OpenTofu //subdir without a ref: %s", (url) => {
    // The subdir is only a path — the default branch is cloned, and
    // "modules" must not be taken for a ref.
    const parsed = parse(url)
    expect(parsed.path).toBe("modules/vpc")
    expect(needsRefResolution(parsed)).toBe(false)
  })
})

describe("adjustBlobPath", () => {
  it("converts blob path to parent directory", () => {
    const parsed = parse("https://github.com/owner/repo/blob/main/path/to/file.ts")
    // After ref resolution, path would be "path/to/file.ts"
    // Simulate resolved state:
    const resolved = { ...parsed, ref: "main", path: "path/to/file.ts" }
    const adjusted = adjustBlobPath(resolved)
    expect(adjusted.path).toBe("path/to")
    expect(adjusted.isBlobURL).toBe(false)
  })

  it("returns undefined path for blob at repo root", () => {
    const parsed = { host: "github.com", owner: "o", repo: "r", cloneURL: "x", isBlobURL: true, path: "file.ts" }
    const adjusted = adjustBlobPath(parsed)
    expect(adjusted.path).toBeUndefined()
  })

  it("is a no-op for non-blob URLs", () => {
    const parsed = parse("https://github.com/owner/repo/tree/main/path")
    const adjusted = adjustBlobPath(parsed)
    expect(adjusted).toEqual(parsed)
  })
})

// ---------------------------------------------------------------------------
// resolveRef — picks the longest matching ref from `git ls-remote` output.
// ---------------------------------------------------------------------------

describe("resolveRef", () => {
  // ls-remote output: <sha>\t<refname>; refs/heads/<branch> or refs/tags/<tag>
  const refOutput = (names: string[]) =>
    names.map((n, i) => `${"a".repeat(40)}${i}\t${n}`)

  it("picks the longest matching ref over a shorter one", async () => {
    const spawner = makeTestSpawner([
      {
        command: "git",
        args: ["ls-remote", "--refs", "https://github.com/o/r.git"],
        outputLines: refOutput([
          "refs/heads/main",
          "refs/heads/release/v1",
          "refs/heads/release/v1.2",
        ]),
        exitCode: 0,
      },
    ])

    const result = await Effect.runPromise(
      resolveRef("https://github.com/o/r.git", "release/v1.2/foo/bar.md").pipe(
        Effect.provide(spawner),
      ),
    )

    expect(result.ref).toBe("release/v1.2")
    expect(result.path).toBe("foo/bar.md")
  })

  it("falls back to first-segment-is-ref when no candidate matches", async () => {
    const spawner = makeTestSpawner([
      {
        command: "git",
        args: ["ls-remote", "--refs", "https://github.com/o/r.git"],
        outputLines: refOutput(["refs/heads/main"]),
        exitCode: 0,
      },
    ])

    const result = await Effect.runPromise(
      resolveRef("https://github.com/o/r.git", "unknown/dir/file.md").pipe(
        Effect.provide(spawner),
      ),
    )

    expect(result.ref).toBe("unknown")
    expect(result.path).toBe("dir/file.md")
  })

  it("returns undefined path when the ref exhausts the segments", async () => {
    const spawner = makeTestSpawner([
      {
        command: "git",
        args: ["ls-remote", "--refs", "https://github.com/o/r.git"],
        outputLines: refOutput(["refs/heads/main"]),
        exitCode: 0,
      },
    ])

    const result = await Effect.runPromise(
      resolveRef("https://github.com/o/r.git", "main").pipe(
        Effect.provide(spawner),
      ),
    )

    expect(result.ref).toBe("main")
    expect(result.path).toBeUndefined()
  })

  it("strips refs/tags/ prefix so a tag matches by its bare name", async () => {
    const spawner = makeTestSpawner([
      {
        command: "git",
        args: ["ls-remote", "--refs", "https://github.com/o/r.git"],
        outputLines: refOutput(["refs/tags/v1.0.0"]),
        exitCode: 0,
      },
    ])

    const result = await Effect.runPromise(
      resolveRef("https://github.com/o/r.git", "v1.0.0/README.md").pipe(
        Effect.provide(spawner),
      ),
    )

    expect(result.ref).toBe("v1.0.0")
    expect(result.path).toBe("README.md")
  })

  it("resolves a commit SHA segment (a permalink) as the ref", async () => {
    const sha = "0123456789abcdef0123456789abcdef01234567"
    const spawner = makeTestSpawner([
      {
        command: "git",
        args: ["ls-remote", "--refs", "https://github.com/o/r.git"],
        outputLines: refOutput(["refs/heads/main"]),
        exitCode: 0,
      },
    ])

    const result = await Effect.runPromise(
      resolveRef("https://github.com/o/r.git", `${sha}/runbooks/x`).pipe(
        Effect.provide(spawner),
      ),
    )

    expect(result.ref).toBe(sha)
    expect(result.path).toBe("runbooks/x")
  })

  it("fails with a redacted GitError instead of guessing when ls-remote fails", async () => {
    const authedURL = "https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/o/r.git"
    const spawner = makeTestSpawner([
      {
        command: "git",
        args: ["ls-remote", "--refs", authedURL],
        outputLines: [`fatal: Authentication failed for '${authedURL}/'`],
        source: "stderr",
        exitCode: 128,
      },
    ])

    const result = await Effect.runPromise(
      resolveRef(authedURL, "main/runbooks/x").pipe(
        Effect.provide(spawner),
        Effect.either,
      ),
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      const err = result.left as GitError
      expect(err._tag).toBe("GitError")
      expect(err.exitCode).toBe(128)
      expect(err.stderr).toContain("Authentication failed")
      expect(err.stderr).not.toContain("ghp_")
    }
  })
})
