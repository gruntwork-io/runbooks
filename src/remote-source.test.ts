import { describe, it, expect } from "bun:test"
import { Effect } from "effect"
import {
  parseRemoteSource,
  needsRefResolution,
  adjustBlobPath,
  resolveRef,
} from "./remote-source.ts"
import { makeTestSpawner } from "./test-utils/TestSpawner.ts"

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
})

// ---------------------------------------------------------------------------
// GitHub Enterprise hosts (GHES / ghe.com)
// ---------------------------------------------------------------------------

describe("parseRemoteSource — GitHub enterprise hosts", () => {
  const parseWith = (url: string, githubHosts?: string[]) =>
    Effect.runSync(parseRemoteSource(url, githubHosts ? { githubHosts } : {}))
  const parseEither = (url: string, githubHosts?: string[]) =>
    Effect.runSync(Effect.either(parseRemoteSource(url, githubHosts ? { githubHosts } : {})))

  it("parses a GHES tree URL with that host and clone URL", () => {
    const result = parseWith("https://ghes.example.com/owner/repo/tree/main/path/to/dir")
    expect(result).toEqual({
      host: "ghes.example.com",
      owner: "owner",
      repo: "repo",
      path: "main/path/to/dir",
      cloneURL: "https://ghes.example.com/owner/repo.git",
      isBlobURL: false,
    })
  })

  it("parses a GHES blob URL (lowercases the host, keeps the port)", () => {
    const result = parseWith("https://GHES.Example.com:8443/owner/repo/blob/v1.2/runbook.mdx")
    expect(result.host).toBe("ghes.example.com:8443")
    expect(result.cloneURL).toBe("https://ghes.example.com:8443/owner/repo.git")
    expect(result.path).toBe("v1.2/runbook.mdx")
    expect(result.isBlobURL).toBe(true)
  })

  it("parses ghe.com tree and blob URLs", () => {
    const tree = parseWith("https://acme.ghe.com/o/r/tree/main/dir")
    expect(tree.host).toBe("acme.ghe.com")
    expect(tree.cloneURL).toBe("https://acme.ghe.com/o/r.git")
    const blob = parseWith("https://acme.ghe.com/o/r/blob/main/dir/runbook.mdx")
    expect(blob.host).toBe("acme.ghe.com")
    expect(blob.isBlobURL).toBe(true)
  })

  it("an http:// browser URL still clones over https", () => {
    expect(parseWith("http://ghes.example.com/o/r/tree/main").cloneURL).toBe("https://ghes.example.com/o/r.git")
  })

  it("plain ghe.com repo URL parses without configuration", () => {
    for (const url of ["https://acme.ghe.com/o/r", "https://acme.ghe.com/o/r.git", "https://ACME.ghe.com/o/r"]) {
      const result = parseWith(url)
      expect(result.host).toBe("acme.ghe.com")
      expect(result.owner).toBe("o")
      expect(result.repo).toBe("r")
      expect(result.cloneURL).toBe("https://acme.ghe.com/o/r.git")
    }
  })

  it("plain GHES repo URL parses ONLY when its host is in githubHosts", () => {
    expect(parseEither("https://ghes.example.com/o/r")._tag).toBe("Left")
    expect(parseEither("https://ghes.example.com/o/r", ["other.example.com"])._tag).toBe("Left")
    const result = parseWith("https://ghes.example.com/o/r.git", ["GHES.example.com"])
    expect(result).toEqual({
      host: "ghes.example.com",
      owner: "o",
      repo: "r",
      cloneURL: "https://ghes.example.com/o/r.git",
      isBlobURL: false,
    })
  })

  it("plain github.com still parses without githubHosts", () => {
    expect(parseWith("https://github.com/o/r").cloneURL).toBe("https://github.com/o/r.git")
  })

  it("a GitLab-named host listed nowhere still parses as GitLab (githubHosts doesn't hijack it)", () => {
    const result = parseWith("https://gitlab.example.com/group/sub/project", ["ghes.example.com"])
    expect(result.owner).toBe("group/sub")
    expect(result.repo).toBe("project")
  })

  it("GitLab /-/tree/ URLs are not mistaken for GitHub tree URLs", () => {
    const result = parseWith("https://gitlab.example.com/group/project/-/tree/main/dir")
    expect(result.owner).toBe("group")
    expect(result.repo).toBe("project")
    expect(result.path).toBe("main/dir")
  })

  // KNOWN BUG (reported): the GitHub tree/blob regexes now match ANY host,
  // and run before the GitLab plain-repo rule, so a plain URL of a GitLab
  // project nested under a subgroup literally named `tree`/`blob`
  // (`group/team/blob/project`) misparses as GitHub `group/team` and would
  // clone the wrong repository. On main this parsed as GitLab.
  it("a plain GitLab URL with a `blob`/`tree` subgroup still parses as GitLab", () => {
    const result = parseWith("https://gitlab.com/group/team/blob/project")
    expect(result.owner).toBe("group/team/blob")
    expect(result.repo).toBe("project")
    expect(result.cloneURL).toBe("https://gitlab.com/group/team/blob/project.git")
  })
})
