import { describe, it, expect } from "bun:test"
import { Effect } from "effect"
import { buildFileTree, isBinaryExt } from "./file-tree.ts"
import { makeTestFileSystem } from "../../test-utils/TestFileSystem.ts"
import {
  MAX_FILE_TREE_FILES,
  MAX_FILE_CONTENT_SIZE,
  HEAVY_DIR_THRESHOLD,
} from "../../types.ts"

const runTree = (
  files: Record<string, string>,
  rootPath = "/root",
) =>
  Effect.runPromise(
    buildFileTree(rootPath).pipe(Effect.provide(makeTestFileSystem(files))),
  )

describe("isBinaryExt", () => {
  it.each([".png", ".jpg", ".zip", ".exe", ".pdf", ".woff2"])(
    "returns true for %s",
    (ext) => expect(isBinaryExt(ext)).toBe(true),
  )

  it.each([".ts", ".md", ".txt", ".json", ".sh", ""])(
    "returns false for %s",
    (ext) => expect(isBinaryExt(ext)).toBe(false),
  )
})

describe("buildFileTree", () => {
  it("returns tree and reports totalFiles for a small directory", async () => {
    const result = await runTree({
      "/root/a.txt": "alpha",
      "/root/b.txt": "beta",
    })
    expect(result.meta.totalFiles).toBe(2)
    expect(result.meta.truncatedTree).toBe(false)
    expect(result.meta.heavyDirs).toEqual([])
    expect(result.tree.length).toBe(2)
    const aNode = result.tree.find((n) => n.name === "a.txt")
    expect(aNode?.file?.content).toBe("alpha")
    expect(aNode?.file?.isTruncated).toBe(false)
  })

  it("flags binary files as truncated and omits their content", async () => {
    const result = await runTree({
      "/root/image.png": "fake-png-bytes",
      "/root/readme.md": "# hi",
    })
    const png = result.tree.find((n) => n.name === "image.png")
    expect(png?.file?.isTruncated).toBe(true)
    expect(png?.file?.content).toBe("")
    const md = result.tree.find((n) => n.name === "readme.md")
    expect(md?.file?.isTruncated).toBe(false)
    expect(md?.file?.content).toBe("# hi")
  })

  it("flags oversized files as truncated", async () => {
    // TestFileSystem reports size = string length, so a string just over the
    // cap gives us a "too big" file without allocating a real buffer.
    const big = "x".repeat(MAX_FILE_CONTENT_SIZE + 1)
    const result = await runTree({
      "/root/huge.txt": big,
      "/root/small.txt": "ok",
    })
    const huge = result.tree.find((n) => n.name === "huge.txt")
    expect(huge?.file?.isTruncated).toBe(true)
    expect(huge?.file?.content).toBe("")
    expect(huge?.file?.size).toBeGreaterThan(MAX_FILE_CONTENT_SIZE)
    const small = result.tree.find((n) => n.name === "small.txt")
    expect(small?.file?.isTruncated).toBe(false)
  })

  it("always skips VCS directories regardless of file limits", async () => {
    const result = await runTree({
      "/root/.git/HEAD": "ref",
      "/root/.git/config": "[core]",
      "/root/.svn/entries": "x",
      "/root/.hg/hgrc": "x",
      "/root/keep.txt": "keep",
    })
    const names = result.tree.map((n) => n.name)
    expect(names).not.toContain(".git")
    expect(names).not.toContain(".svn")
    expect(names).not.toContain(".hg")
    expect(names).toContain("keep.txt")
    // totalFiles only counts non-VCS files.
    expect(result.meta.totalFiles).toBe(1)
  })

  it("stops including file content once totalFiles exceeds MAX_FILE_TREE_FILES", async () => {
    // Build (MAX + 5) tiny files under a top-level dir.
    const files: Record<string, string> = {}
    const N = MAX_FILE_TREE_FILES + 5
    for (let i = 0; i < N; i++) {
      files[`/root/many/file${i}.txt`] = "x"
    }
    const result = await runTree(files)

    // totalFiles is incremented for every file regardless of cap.
    expect(result.meta.totalFiles).toBe(N)
    expect(result.meta.truncatedTree).toBe(true)
    // The "many" subtree should be marked as a heavy dir because it has many
    // files above the threshold.
    const heavy = result.meta.heavyDirs.find((d) => d.path === "many")
    expect(heavy).toBeDefined()
    expect(heavy!.fileCount).toBe(N)
  })

  it("does not flag a small dir as heavy", async () => {
    // Just under the heavy-dir threshold AND below the file-tree cap.
    const N = HEAVY_DIR_THRESHOLD - 1
    const files: Record<string, string> = {}
    for (let i = 0; i < N; i++) files[`/root/small/file${i}.txt`] = "x"
    const result = await runTree(files)
    expect(result.meta.heavyDirs).toEqual([])
  })

  it("sorts directories before files within a level, then alphabetically", async () => {
    const result = await runTree({
      "/root/z.txt": "z",
      "/root/a.txt": "a",
      "/root/dirB/file.txt": "x",
      "/root/dirA/file.txt": "x",
    })
    const names = result.tree.map((n) => n.name)
    // Two folders come first (dirA, dirB), then files (a.txt, z.txt).
    expect(names).toEqual(["dirA", "dirB", "a.txt", "z.txt"])
  })
})
