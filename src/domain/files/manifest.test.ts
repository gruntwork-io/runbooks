import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import {
  hashFileContent,
  FileManifestStore,
  computeDiff,
  buildManifestFromDirectory,
} from "./manifest.ts"
import { makeTestFileSystem } from "../../test-utils/TestFileSystem.ts"

describe("hashFileContent", () => {
  it("returns consistent SHA-256 hex for known input", () => {
    const hash1 = hashFileContent("hello")
    const hash2 = hashFileContent("hello")
    expect(hash1).toBe(hash2)
    expect(hash1).toHaveLength(64) // SHA-256 hex = 64 chars
  })

  it("returns different hashes for different inputs", () => {
    expect(hashFileContent("a")).not.toBe(hashFileContent("b"))
  })

  it("handles empty string", () => {
    const hash = hashFileContent("")
    expect(hash).toHaveLength(64)
  })
})

describe("FileManifestStore", () => {
  it("returns undefined for missing key", () => {
    const store = new FileManifestStore()
    expect(store.get("missing")).toBeUndefined()
  })

  it("set then get round-trips correctly", () => {
    const store = new FileManifestStore()
    const manifest = [{ path: "file.txt", contentHash: "abc123" }]
    store.set("tpl1", manifest)
    expect(store.get("tpl1")).toEqual(manifest)
  })

  it("delete removes entry", () => {
    const store = new FileManifestStore()
    store.set("tpl1", [])
    store.delete("tpl1")
    expect(store.get("tpl1")).toBeUndefined()
  })

  it("clear removes all entries", () => {
    const store = new FileManifestStore()
    store.set("tpl1", [])
    store.set("tpl2", [])
    store.clear()
    expect(store.get("tpl1")).toBeUndefined()
    expect(store.get("tpl2")).toBeUndefined()
  })

  it("stores multiple templates independently", () => {
    const store = new FileManifestStore()
    const m1 = [{ path: "a.txt", contentHash: "h1" }]
    const m2 = [{ path: "b.txt", contentHash: "h2" }]
    store.set("tpl1", m1)
    store.set("tpl2", m2)
    expect(store.get("tpl1")).toEqual(m1)
    expect(store.get("tpl2")).toEqual(m2)
  })
})

describe("computeDiff", () => {
  it("returns all empty for empty inputs", () => {
    const result = computeDiff([], [])
    expect(result).toEqual({ orphaned: [], created: [], modified: [], unchanged: [] })
  })

  it("detects all created when old is empty", () => {
    const result = computeDiff([], [
      { path: "a.txt", contentHash: "h1" },
      { path: "b.txt", contentHash: "h2" },
    ])
    expect(result.created).toEqual(["a.txt", "b.txt"])
    expect(result.orphaned).toEqual([])
  })

  it("detects all orphaned when new is empty", () => {
    const result = computeDiff(
      [{ path: "a.txt", contentHash: "h1" }],
      [],
    )
    expect(result.orphaned).toEqual(["a.txt"])
    expect(result.created).toEqual([])
  })

  it("detects unchanged when hashes match", () => {
    const entries = [{ path: "a.txt", contentHash: "h1" }]
    const result = computeDiff(entries, entries)
    expect(result.unchanged).toEqual(["a.txt"])
    expect(result.modified).toEqual([])
  })

  it("detects modified when hashes differ", () => {
    const result = computeDiff(
      [{ path: "a.txt", contentHash: "h1" }],
      [{ path: "a.txt", contentHash: "h2" }],
    )
    expect(result.modified).toEqual(["a.txt"])
  })

  it("handles mixed scenario", () => {
    const result = computeDiff(
      [
        { path: "keep.txt", contentHash: "same" },
        { path: "change.txt", contentHash: "old" },
        { path: "remove.txt", contentHash: "gone" },
      ],
      [
        { path: "keep.txt", contentHash: "same" },
        { path: "change.txt", contentHash: "new" },
        { path: "add.txt", contentHash: "fresh" },
      ],
    )
    expect(result.unchanged).toEqual(["keep.txt"])
    expect(result.modified).toEqual(["change.txt"])
    expect(result.orphaned).toEqual(["remove.txt"])
    expect(result.created).toEqual(["add.txt"])
  })
})

describe("buildManifestFromDirectory", () => {
  it("scans directory and returns entries with hashes", async () => {
    const layer = makeTestFileSystem({
      "/root/file1.txt": "content1",
      "/root/sub/file2.txt": "content2",
    })

    const entries = await Effect.runPromise(
      buildManifestFromDirectory("/root").pipe(Effect.provide(layer)),
    )

    expect(entries).toHaveLength(2)
    const paths = entries.map((e) => e.path).sort()
    expect(paths).toEqual(["file1.txt", "sub/file2.txt"])
    expect(entries[0].contentHash).toHaveLength(64)
  })

  it("handles empty directory", async () => {
    const layer = makeTestFileSystem({})

    const entries = await Effect.runPromise(
      buildManifestFromDirectory("/empty").pipe(Effect.provide(layer)),
    )

    expect(entries).toEqual([])
  })
})
