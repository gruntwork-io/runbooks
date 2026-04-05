import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import { parseRemoteSource, needsRefResolution, adjustBlobPath } from "./remote-source.ts"

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
