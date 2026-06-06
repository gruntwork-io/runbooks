import { describe, it, expect } from "bun:test"
import { Effect } from "effect"
import {
  parseRemoteSource,
  needsRefResolution,
  adjustBlobPath,
  resolveRef,
  getTokenForHost,
} from "./remote-source.ts"
import { makeTestSpawner } from "./test-utils/TestSpawner.ts"
import { makeTestEnvironment } from "./test-utils/TestEnvironment.ts"
import { Layer } from "effect"

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
      resolveRef(
        "https://github.com/o/r.git",
        "release/v1.2/foo/bar.md",
        false,
      ).pipe(Effect.provide(spawner)),
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
      resolveRef("https://github.com/o/r.git", "unknown/dir/file.md", false).pipe(
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
      resolveRef("https://github.com/o/r.git", "main", false).pipe(
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
      resolveRef("https://github.com/o/r.git", "v1.0.0/README.md", false).pipe(
        Effect.provide(spawner),
      ),
    )

    expect(result.ref).toBe("v1.0.0")
    expect(result.path).toBe("README.md")
  })
})

// ---------------------------------------------------------------------------
// getTokenForHost — env precedence, then CLI fallback, then undefined.
// ---------------------------------------------------------------------------

describe("getTokenForHost(github.com)", () => {
  const nullSpawner = makeTestSpawner([]) // never matched

  it("returns GITHUB_TOKEN when set", async () => {
    const layer = Layer.mergeAll(
      makeTestEnvironment({ GITHUB_TOKEN: "A" }),
      nullSpawner,
    )
    const result = await Effect.runPromise(
      getTokenForHost("github.com").pipe(Effect.provide(layer)),
    )
    expect(result).toBe("A")
  })

  it("returns GH_TOKEN when only that is set", async () => {
    const layer = Layer.mergeAll(
      makeTestEnvironment({ GH_TOKEN: "B" }),
      nullSpawner,
    )
    const result = await Effect.runPromise(
      getTokenForHost("github.com").pipe(Effect.provide(layer)),
    )
    expect(result).toBe("B")
  })

  it("prefers GITHUB_TOKEN when both are set", async () => {
    const layer = Layer.mergeAll(
      makeTestEnvironment({ GITHUB_TOKEN: "A", GH_TOKEN: "B" }),
      nullSpawner,
    )
    const result = await Effect.runPromise(
      getTokenForHost("github.com").pipe(Effect.provide(layer)),
    )
    expect(result).toBe("A")
  })

  it("falls back to `gh auth token` when no env var is set", async () => {
    const spawner = makeTestSpawner([
      {
        command: "gh",
        args: ["auth", "token"],
        outputLines: ["ghp_FROM_CLI"],
        exitCode: 0,
      },
    ])
    const layer = Layer.mergeAll(makeTestEnvironment({}), spawner)
    const result = await Effect.runPromise(
      getTokenForHost("github.com").pipe(Effect.provide(layer)),
    )
    expect(result).toBe("ghp_FROM_CLI")
  })

  it("returns undefined when neither env var nor `gh` is available", async () => {
    // TestSpawner with no matching command surfaces a SpawnError; getTokenForHost
    // catches it and resolves to undefined.
    const layer = Layer.mergeAll(makeTestEnvironment({}), nullSpawner)
    const result = await Effect.runPromise(
      getTokenForHost("github.com").pipe(Effect.provide(layer)),
    )
    expect(result).toBeUndefined()
  })
})

describe("getTokenForHost(gitlab.com)", () => {
  it("returns GITLAB_TOKEN when set", async () => {
    const layer = Layer.mergeAll(
      makeTestEnvironment({ GITLAB_TOKEN: "gl_X" }),
      makeTestSpawner([]),
    )
    const result = await Effect.runPromise(
      getTokenForHost("gitlab.com").pipe(Effect.provide(layer)),
    )
    expect(result).toBe("gl_X")
  })

  it("falls back to `glab auth token`", async () => {
    const layer = Layer.mergeAll(
      makeTestEnvironment({}),
      makeTestSpawner([
        {
          command: "glab",
          args: ["auth", "token"],
          outputLines: ["glpat_FROM_CLI"],
          exitCode: 0,
        },
      ]),
    )
    const result = await Effect.runPromise(
      getTokenForHost("gitlab.com").pipe(Effect.provide(layer)),
    )
    expect(result).toBe("glpat_FROM_CLI")
  })

  it("returns undefined when nothing is configured", async () => {
    const layer = Layer.mergeAll(makeTestEnvironment({}), makeTestSpawner([]))
    const result = await Effect.runPromise(
      getTokenForHost("gitlab.com").pipe(Effect.provide(layer)),
    )
    expect(result).toBeUndefined()
  })
})

describe("getTokenForHost(self-hosted GitLab)", () => {
  it("resolves GITLAB_TOKEN for a self-hosted gitlab host", async () => {
    const layer = Layer.mergeAll(
      makeTestEnvironment({ GITLAB_TOKEN: "gl_self" }),
      makeTestSpawner([]),
    )
    const result = await Effect.runPromise(
      getTokenForHost("gitlab.example.com").pipe(Effect.provide(layer)),
    )
    expect(result).toBe("gl_self")
  })
})

describe("getTokenForHost(unknown host)", () => {
  it("returns undefined for hosts with no special case", async () => {
    const layer = Layer.mergeAll(
      makeTestEnvironment({ GITHUB_TOKEN: "A", GITLAB_TOKEN: "B" }),
      makeTestSpawner([]),
    )
    const result = await Effect.runPromise(
      getTokenForHost("example.com").pipe(Effect.provide(layer)),
    )
    expect(result).toBeUndefined()
  })
})
