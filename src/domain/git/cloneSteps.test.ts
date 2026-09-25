import { describe, it, expect } from "bun:test"
import { Either } from "effect"
import { buildCloneSteps, normalizeRepoPath } from "./cloneSteps.ts"

const URL = "https://github.com/acme/mono.git"
const DEST = "/work/mono"

const steps = (options?: { ref?: string; repoPath?: string }) =>
  Either.getOrThrow(buildCloneSteps(URL, DEST, options))

describe("buildCloneSteps", () => {
  it("clones the whole repository in one step without a repo path", () => {
    expect(steps()).toEqual([{ args: ["clone", "--progress", "--", URL, DEST] }])
  })

  it("passes the ref to --branch", () => {
    expect(steps({ ref: "v1.2.0" })).toEqual([
      { args: ["clone", "--progress", "--branch", "v1.2.0", "--", URL, DEST] },
    ])
  })

  it("makes a blobless, cone-mode sparse clone of a repo path", () => {
    expect(steps({ repoPath: "modules/vpc" })).toEqual([
      { args: ["clone", "--filter=blob:none", "--no-checkout", "--progress", "--", URL, DEST] },
      { args: ["-C", DEST, "sparse-checkout", "init", "--cone"] },
      { args: ["-C", DEST, "sparse-checkout", "set", "--", "modules/vpc"] },
      // An empty repository has nothing to check out.
      { args: ["-C", DEST, "checkout"], skipIfNoCommits: true },
    ])
  })

  it("keeps the ref on a sparse clone", () => {
    expect(steps({ ref: "release", repoPath: "modules/vpc" })[0]?.args).toEqual([
      "clone", "--filter=blob:none", "--no-checkout", "--progress", "--branch", "release", "--", URL, DEST,
    ])
  })

  it('treats "." and an empty path as the whole repository', () => {
    for (const repoPath of [".", "./", "", "  "]) {
      expect(steps({ repoPath })).toEqual([{ args: ["clone", "--progress", "--", URL, DEST] }])
    }
  })

  it("fails for a repo path outside the repository, before any step runs", () => {
    const result = buildCloneSteps(URL, DEST, { repoPath: "../elsewhere" })
    expect(Either.isLeft(result)).toBe(true)
  })
})

describe("normalizeRepoPath", () => {
  const normalize = (p: string | undefined) => Either.getOrThrow(normalizeRepoPath(p))

  it("trims and strips a leading ./ and trailing slashes", () => {
    expect(normalize("  modules/vpc  ")).toBe("modules/vpc")
    expect(normalize("./modules/vpc/")).toBe("modules/vpc")
    expect(normalize(".//docs//")).toBe("docs")
  })

  it("turns backslashes into the / git paths use", () => {
    expect(normalize("modules\\vpc")).toBe("modules/vpc")
    expect(normalize(".\\modules\\vpc\\")).toBe("modules/vpc")
    expect(normalize(".\\")).toBeUndefined()
  })

  it("returns undefined for the repository root", () => {
    expect(normalize(undefined)).toBeUndefined()
    expect(normalize("")).toBeUndefined()
    expect(normalize(".")).toBeUndefined()
    expect(normalize("./")).toBeUndefined()
  })

  it("keeps a path whose name merely starts with dots", () => {
    expect(normalize("..hidden/dir")).toBe("..hidden/dir")
    expect(normalize(".github")).toBe(".github")
  })

  it("rejects absolute paths and .. segments", () => {
    for (const bad of ["/etc", "\\share", "C:\\repo", "..", "../x", "a/../../x", "a\\..\\x"]) {
      const result = normalizeRepoPath(bad)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("GitError")
        expect(result.left.stderr).toContain("invalid repo path")
      }
    }
  })
})
