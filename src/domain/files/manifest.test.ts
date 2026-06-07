import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { Effect } from "effect"
import * as nodeFs from "node:fs"
import * as nodePath from "node:path"
import * as os from "node:os"
import {
  hashFileContent,
  FileManifestStore,
  computeDiff,
  applyDiffFromContent,
} from "./manifest.ts"
import { NodeFileSystemLive } from "../../layers/NodeFileSystem.ts"
import { FileSystem } from "../../services/FileSystem.ts"
import { Layer, Stream } from "effect"
import type { ManifestDiffResult, TemplateManifest } from "../../types.ts"

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
    const manifest: TemplateManifest = { templateId: "tpl1", outputDir: "/out", files: [{ path: "file.txt", contentHash: "abc123" }] }
    store.set("tpl1", manifest)
    expect(store.get("tpl1")).toEqual(manifest)
  })

  it("delete removes entry", () => {
    const store = new FileManifestStore()
    store.set("tpl1", { templateId: "tpl1", outputDir: "/out", files: [] })
    store.delete("tpl1")
    expect(store.get("tpl1")).toBeUndefined()
  })

  it("clear removes all entries", () => {
    const store = new FileManifestStore()
    store.set("tpl1", { templateId: "tpl1", outputDir: "/out", files: [] })
    store.set("tpl2", { templateId: "tpl2", outputDir: "/out", files: [] })
    store.clear()
    expect(store.get("tpl1")).toBeUndefined()
    expect(store.get("tpl2")).toBeUndefined()
  })

  it("stores multiple templates independently", () => {
    const store = new FileManifestStore()
    const m1: TemplateManifest = { templateId: "tpl1", outputDir: "/out", files: [{ path: "a.txt", contentHash: "h1" }] }
    const m2: TemplateManifest = { templateId: "tpl2", outputDir: "/out", files: [{ path: "b.txt", contentHash: "h2" }] }
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

// ---------------------------------------------------------------------------
// applyDiffFromContent — writes created/modified files from an in-memory
// content map, deletes orphans, and restores manually-deleted unchanged files.
//
// These tests use a real temp directory because we exercise symlinks and
// empty-parent cleanup, which the in-memory TestFileSystem doesn't model.
// ---------------------------------------------------------------------------

describe("applyDiffFromContent", () => {
  let tmp: string
  let outputDir: string

  beforeEach(() => {
    tmp = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "manifest-content-"))
    outputDir = nodePath.join(tmp, "out")
    nodeFs.mkdirSync(outputDir, { recursive: true })
  })

  afterEach(() => {
    nodeFs.rmSync(tmp, { recursive: true, force: true })
  })

  const runApply = (
    diff: ManifestDiffResult,
    contents: ReadonlyMap<string, string> = new Map<string, string>(),
  ) =>
    Effect.runPromise(
      applyDiffFromContent(diff, contents, outputDir).pipe(
        Effect.provide(NodeFileSystemLive),
      ),
    )

  it("writes created/modified files and removes orphans", async () => {
    // Output starts with a stale a.txt and an orphan.
    nodeFs.writeFileSync(nodePath.join(outputDir, "a.txt"), "old-a")
    nodeFs.writeFileSync(nodePath.join(outputDir, "orphan.txt"), "bye")

    const result = await runApply(
      {
        created: ["b/c.txt"],
        modified: ["a.txt"],
        orphaned: ["orphan.txt"],
        unchanged: [],
      },
      new Map([
        ["a.txt", "new-a"],
        ["b/c.txt", "new-c"],
      ]),
    )

    expect(result).toEqual({ written: 2, deleted: 1 })
    expect(nodeFs.readFileSync(nodePath.join(outputDir, "a.txt"), "utf8")).toBe(
      "new-a",
    )
    expect(
      nodeFs.readFileSync(nodePath.join(outputDir, "b", "c.txt"), "utf8"),
    ).toBe("new-c")
    expect(nodeFs.existsSync(nodePath.join(outputDir, "orphan.txt"))).toBe(false)
  })

  it("writes plain created files from a content map", async () => {
    const result = await runApply(
      { created: ["a.txt", "b/c.txt"], modified: [], orphaned: [], unchanged: [] },
      new Map([
        ["a.txt", "hello"],
        ["b/c.txt", "nested"],
      ]),
    )

    expect(result).toEqual({ written: 2, deleted: 0 })
    expect(nodeFs.readFileSync(nodePath.join(outputDir, "a.txt"), "utf8")).toBe(
      "hello",
    )
    expect(
      nodeFs.readFileSync(nodePath.join(outputDir, "b", "c.txt"), "utf8"),
    ).toBe("nested")
  })

  it("restores a manually deleted unchanged file when its content is available", async () => {
    // outputDir is empty — file was manually removed between renders.
    const result = await runApply(
      { created: [], modified: [], orphaned: [], unchanged: ["keep.txt"] },
      new Map([["keep.txt", "keep"]]),
    )
    expect(result.written).toBe(1)
    expect(nodeFs.readFileSync(nodePath.join(outputDir, "keep.txt"), "utf8")).toBe(
      "keep",
    )
  })

  it("removes empty parent directories after deleting an orphan", async () => {
    // Output has nested/sub/leaf.txt; nothing else in nested/ or nested/sub/.
    const nestedDir = nodePath.join(outputDir, "nested", "sub")
    nodeFs.mkdirSync(nestedDir, { recursive: true })
    nodeFs.writeFileSync(nodePath.join(nestedDir, "leaf.txt"), "x")

    const result = await runApply({
      created: [],
      modified: [],
      orphaned: ["nested/sub/leaf.txt"],
      unchanged: [],
    })

    expect(result.deleted).toBe(1)
    // Both parents collapse — but the outputDir itself is never removed.
    expect(nodeFs.existsSync(nodePath.join(outputDir, "nested", "sub"))).toBe(false)
    expect(nodeFs.existsSync(nodePath.join(outputDir, "nested"))).toBe(false)
    expect(nodeFs.existsSync(outputDir)).toBe(true)
  })

  it("stops collapsing parents at the first non-empty directory", async () => {
    const nestedDir = nodePath.join(outputDir, "nested", "sub")
    nodeFs.mkdirSync(nestedDir, { recursive: true })
    nodeFs.writeFileSync(nodePath.join(nestedDir, "leaf.txt"), "x")
    // Sibling keeps `nested/` non-empty after the leaf is deleted.
    nodeFs.writeFileSync(nodePath.join(outputDir, "nested", "sibling.txt"), "stay")

    await runApply({
      created: [],
      modified: [],
      orphaned: ["nested/sub/leaf.txt"],
      unchanged: [],
    })

    expect(nodeFs.existsSync(nodePath.join(outputDir, "nested", "sub"))).toBe(false)
    expect(nodeFs.existsSync(nodePath.join(outputDir, "nested", "sibling.txt"))).toBe(
      true,
    )
  })

  // -------------------------------------------------------------------------
  // Safety: unsafe diff paths are rejected before touching disk
  // -------------------------------------------------------------------------

  const unsafeCases: Array<{
    label: string
    bucket: keyof ManifestDiffResult
    pathValue: string
  }> = [
    { label: "created with ../", bucket: "created", pathValue: "../evil.txt" },
    { label: "created with absolute path", bucket: "created", pathValue: "/etc/passwd" },
    { label: "modified with ../", bucket: "modified", pathValue: "../evil.txt" },
    { label: "modified with absolute path", bucket: "modified", pathValue: "/etc/passwd" },
    { label: "orphaned with ../", bucket: "orphaned", pathValue: "../evil.txt" },
    { label: "orphaned with absolute path", bucket: "orphaned", pathValue: "/etc/passwd" },
    { label: "unchanged with ../", bucket: "unchanged", pathValue: "../evil.txt" },
  ]

  for (const { label, bucket, pathValue } of unsafeCases) {
    it(`rejects unsafe diff: ${label}`, async () => {
      const diff: ManifestDiffResult = {
        created: [],
        modified: [],
        orphaned: [],
        unchanged: [],
      }
      ;(diff as unknown as Record<string, string[]>)[bucket] = [pathValue]

      // A tripwire file we expect to remain on disk regardless of the diff.
      const tripwireDir = nodePath.join(tmp, "tripwire")
      nodeFs.mkdirSync(tripwireDir, { recursive: true })
      const tripwire = nodePath.join(tripwireDir, "evil.txt")
      nodeFs.writeFileSync(tripwire, "DO NOT DELETE")

      const result = await Effect.runPromise(
        applyDiffFromContent(diff, new Map([[pathValue, "x"]]), outputDir).pipe(
          Effect.provide(NodeFileSystemLive),
          Effect.either,
        ),
      )

      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect((result.left as unknown as { _tag: string })._tag).toBe(
          "PathTraversalError",
        )
      }
      // The tripwire file must still exist.
      expect(nodeFs.existsSync(tripwire)).toBe(true)
    })
  }

  it("symlink-attack: deleting an orphan that is a symlink does not remove the target outside outputDir", async () => {
    // target lives outside outputDir
    const targetDir = nodePath.join(tmp, "outside")
    nodeFs.mkdirSync(targetDir, { recursive: true })
    const target = nodePath.join(targetDir, "real.txt")
    nodeFs.writeFileSync(target, "keep me")

    // Create a symlink inside outputDir pointing to the outside file.
    const linkPath = nodePath.join(outputDir, "link.txt")
    nodeFs.symlinkSync(target, linkPath)

    const result = await runApply({
      created: [],
      modified: [],
      orphaned: ["link.txt"],
      unchanged: [],
    })

    expect(result.deleted).toBe(1)
    // The symlink itself should be gone.
    expect(nodeFs.existsSync(linkPath)).toBe(false)
    // The real file outside outputDir must still exist.
    expect(nodeFs.existsSync(target)).toBe(true)
    expect(nodeFs.readFileSync(target, "utf8")).toBe("keep me")
  })
})

// ---------------------------------------------------------------------------
// Idempotent re-render: a diff with only `unchanged` (and files present)
// performs zero writes.
// ---------------------------------------------------------------------------

describe("applyDiffFromContent idempotency", () => {
  it("emits zero writes when re-rendering identical content", async () => {
    let writeCount = 0
    let rmCount = 0

    // Hand-rolled spying layer. `exists` always returns true so the
    // unchanged branch in restoreMissingUnchanged decides there's nothing
    // to restore — meaning the whole render produces zero writes.
    const spyLayer = Layer.succeed(FileSystem, {
      readFile: () => Effect.succeed(""),
      readFileBuffer: () => Effect.succeed(Buffer.from("")),
      readdir: () => Effect.succeed([]),
      readdirWithTypes: () => Effect.succeed([]),
      stat: () =>
        Effect.succeed({
          size: 0,
          isFile: true,
          isDirectory: false,
          mtime: new Date(),
        }),
      exists: () => Effect.succeed(true),
      writeFile: () => {
        writeCount += 1
        return Effect.void
      },
      mkdir: () => Effect.void,
      rm: () => {
        rmCount += 1
        return Effect.void
      },
      copyFile: () => Effect.void,
      mkdtemp: () => Effect.succeed("/tmp/x"),
      realpath: (p) => Effect.succeed(p),
      walk: () => Stream.empty,
      watch: () => Stream.empty,
    })

    const result = await Effect.runPromise(
      applyDiffFromContent(
        { created: [], modified: [], orphaned: [], unchanged: ["a.txt"] },
        new Map([["a.txt", ""]]),
        "/out",
      ).pipe(Effect.provide(spyLayer)),
    )

    expect(result).toEqual({ written: 0, deleted: 0 })
    expect(writeCount).toBe(0)
    expect(rmCount).toBe(0)
  })
})
