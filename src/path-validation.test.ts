import { describe, it, expect } from "bun:test"
import { Effect, Exit } from "effect"
import {
  containsPathTraversal,
  isAbsolutePath,
  isFilesystemRoot,
  isContainedIn,
  validateRelativePath,
  validateRelativePathIn,
  validateAbsolutePathInDir,
} from "./path-validation.ts"

describe("containsPathTraversal", () => {
  it("detects .. at start", () => {
    expect(containsPathTraversal("../etc/passwd")).toBe(true)
  })

  it("detects .. in middle", () => {
    expect(containsPathTraversal("foo/../bar")).toBe(true)
  })

  it("detects standalone ..", () => {
    expect(containsPathTraversal("..")).toBe(true)
  })

  it("detects .. at end", () => {
    expect(containsPathTraversal("foo/..")).toBe(true)
  })

  it("detects Windows-style backslash traversal", () => {
    expect(containsPathTraversal("foo\\..\\bar")).toBe(true)
  })

  it("returns false for normal paths", () => {
    expect(containsPathTraversal("foo/bar")).toBe(false)
    expect(containsPathTraversal("./foo")).toBe(false)
    expect(containsPathTraversal("foo/bar/baz")).toBe(false)
  })

  it("returns false for .. inside a filename", () => {
    expect(containsPathTraversal("file..txt")).toBe(false)
  })
})

describe("isAbsolutePath", () => {
  it("returns true for absolute paths", () => {
    expect(isAbsolutePath("/foo")).toBe(true)
    expect(isAbsolutePath("/")).toBe(true)
  })

  it("returns false for relative paths", () => {
    expect(isAbsolutePath("foo/bar")).toBe(false)
    expect(isAbsolutePath("./foo")).toBe(false)
    expect(isAbsolutePath("")).toBe(false)
  })
})

describe("isFilesystemRoot", () => {
  it("returns true for /", () => {
    expect(isFilesystemRoot("/")).toBe(true)
  })

  it("returns false for non-root paths", () => {
    expect(isFilesystemRoot("/home")).toBe(false)
    expect(isFilesystemRoot("/usr/bin")).toBe(false)
  })
})

describe("isContainedIn", () => {
  it("returns true for child path", () => {
    expect(isContainedIn("/a/b/c", "/a/b")).toBe(true)
  })

  it("returns true for exact match", () => {
    expect(isContainedIn("/a/b", "/a/b")).toBe(true)
  })

  it("returns false for prefix-but-not-parent", () => {
    expect(isContainedIn("/a/bc", "/a/b")).toBe(false)
  })

  it("returns false when file is above container", () => {
    expect(isContainedIn("/a", "/a/b")).toBe(false)
  })
})

describe("validateRelativePath", () => {
  it("succeeds for valid relative path", async () => {
    await Effect.runPromise(validateRelativePath("foo/bar"))
  })

  it("succeeds (no-op) for empty string", async () => {
    await Effect.runPromise(validateRelativePath(""))
  })

  it("fails for absolute path", async () => {
    const exit = await Effect.runPromiseExit(validateRelativePath("/absolute/path"))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails for path with traversal", async () => {
    const exit = await Effect.runPromiseExit(validateRelativePath("../escape"))
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe("validateRelativePathIn", () => {
  it("succeeds for contained relative path", async () => {
    await Effect.runPromise(validateRelativePathIn("sub/file.txt", "/workspace"))
  })

  it("fails for empty path", async () => {
    const exit = await Effect.runPromiseExit(validateRelativePathIn("", "/workspace"))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails when resolved path escapes directory", async () => {
    const exit = await Effect.runPromiseExit(validateRelativePathIn("../../etc/passwd", "/workspace"))
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe("validateAbsolutePathInDir", () => {
  it("succeeds for path within directory", async () => {
    await Effect.runPromise(validateAbsolutePathInDir("/workspace/foo", "/workspace"))
  })

  it("fails for empty path", async () => {
    const exit = await Effect.runPromiseExit(validateAbsolutePathInDir("", "/workspace"))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails for relative path", async () => {
    const exit = await Effect.runPromiseExit(validateAbsolutePathInDir("relative/path", "/workspace"))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails for path escaping directory", async () => {
    const exit = await Effect.runPromiseExit(validateAbsolutePathInDir("/other/place", "/workspace"))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails for dangerous system directories", async () => {
    const exit = await Effect.runPromiseExit(validateAbsolutePathInDir("/etc", "/"))
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
