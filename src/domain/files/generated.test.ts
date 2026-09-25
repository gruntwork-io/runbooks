import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { Effect, Exit } from "effect"
import * as nodeFs from "node:fs"
import * as nodePath from "node:path"
import * as os from "node:os"
import {
  DEFAULT_GENERATED_DIR,
  checkGeneratedFiles,
  deleteGeneratedFiles,
  resolveToAbsolutePath,
} from "./generated.ts"
import { NodeFileSystemLive } from "../../layers/NodeFileSystem.ts"
import { PathValidationError } from "../../errors/index.ts"

// These tests use a real temp directory and the real NodeFileSystem layer:
// the in-memory TestFileSystem's walk never stats entries, so it cannot model
// the symlink cases below. Delete is destructive, so its edges are pinned
// against the real filesystem too.

describe("generated files", () => {
  // realpath'd because resolveToAbsolutePath resolves symlinks in the working
  // directory (macOS /var -> /private/var).
  let workingDir: string
  let generatedDir: string

  beforeEach(() => {
    workingDir = nodeFs.realpathSync(
      nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "generated-files-")),
    )
    generatedDir = nodePath.join(workingDir, DEFAULT_GENERATED_DIR)
  })

  afterEach(() => {
    nodeFs.rmSync(workingDir, { recursive: true, force: true })
  })

  const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)
  const check = (outputPath: string = DEFAULT_GENERATED_DIR) =>
    checkGeneratedFiles(workingDir, outputPath).pipe(Effect.provide(NodeFileSystemLive))
  const del = (outputPath: string = DEFAULT_GENERATED_DIR) =>
    deleteGeneratedFiles(workingDir, outputPath).pipe(Effect.provide(NodeFileSystemLive))

  const write = (relPath: string, content = "x") => {
    const full = nodePath.join(generatedDir, relPath)
    nodeFs.mkdirSync(nodePath.dirname(full), { recursive: true })
    nodeFs.writeFileSync(full, content)
  }

  describe("resolveToAbsolutePath", () => {
    const resolve = (base: string, raw: string) =>
      resolveToAbsolutePath(base, raw).pipe(Effect.provide(NodeFileSystemLive))

    it("resolves a relative path against the realpath of the working directory", async () => {
      const unresolved = nodePath.join(workingDir, "link-to-wd")
      nodeFs.symlinkSync(workingDir, unresolved)

      expect(await run(resolve(unresolved, "nested/out"))).toBe(
        nodePath.join(workingDir, "nested", "out"),
      )
    })

    it("returns an absolute path unchanged", async () => {
      const abs = nodePath.join(os.tmpdir(), "somewhere-else")
      expect(await run(resolve(workingDir, abs))).toBe(abs)
    })

    it("rejects an empty path", async () => {
      const exit = await Effect.runPromiseExit(resolve(workingDir, ""))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(PathValidationError)
      }
    })
  })

  describe("when the directory does not exist", () => {
    it("check reports no files at the resolved path", async () => {
      expect(await run(check())).toEqual({
        hasFiles: false,
        absoluteOutputPath: generatedDir,
        relativeOutputPath: DEFAULT_GENERATED_DIR,
        fileCount: 0,
      })
    })

    it("delete succeeds without creating it", async () => {
      const result = await run(del())
      expect(result.success).toBe(true)
      expect(result.deletedCount).toBe(0)
      expect(nodeFs.existsSync(generatedDir)).toBe(false)
    })
  })

  describe("when the path is a file, not a directory", () => {
    beforeEach(() => {
      nodeFs.writeFileSync(generatedDir, "not a dir")
    })

    it("check fails with PathValidationError", async () => {
      const exit = await Effect.runPromiseExit(check())
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(PathValidationError)
        expect((exit.cause.error as PathValidationError).message).toContain("not a directory")
      }
    })

    it("delete fails and leaves the file in place", async () => {
      const exit = await Effect.runPromiseExit(del())
      expect(Exit.isFailure(exit)).toBe(true)
      expect(nodeFs.readFileSync(generatedDir, "utf8")).toBe("not a dir")
    })
  })

  it("counts nested files (not directories) and delete empties the directory but keeps it", async () => {
    write("a.txt")
    write("sub/b.txt")
    write("sub/deeper/c.txt")
    nodeFs.mkdirSync(nodePath.join(generatedDir, "empty-dir"))

    const checked = await run(check())
    expect(checked.hasFiles).toBe(true)
    expect(checked.fileCount).toBe(3)

    const deleted = await run(del())
    expect(deleted.success).toBe(true)
    expect(deleted.deletedCount).toBe(3)
    expect(nodeFs.statSync(generatedDir).isDirectory()).toBe(true)
    expect(nodeFs.readdirSync(generatedDir)).toEqual([])
  })

  it("does not fail on dangling or looping symlinks, and delete removes them", async () => {
    // A link whose target is gone (deleted between sessions, or a cloned repo
    // with a relative link) and a self-referencing link (ELOOP when followed).
    // Following either used to fail the whole walk, which failed both the
    // check and the delete.
    write("a.txt")
    nodeFs.symlinkSync(nodePath.join(workingDir, "missing-target"), nodePath.join(generatedDir, "dangling"))
    nodeFs.symlinkSync("loop", nodePath.join(generatedDir, "loop"))

    const checked = await run(check())
    expect(checked.hasFiles).toBe(true)
    expect(checked.fileCount).toBe(1)

    const deleted = await run(del())
    expect(deleted.success).toBe(true)
    expect(deleted.deletedCount).toBe(1)
    expect(nodeFs.readdirSync(generatedDir)).toEqual([])
  })

  it("does not follow a symlink to a directory outside the generated dir", async () => {
    // Delete removes the link itself and never touches what it points to.
    const outside = nodePath.join(workingDir, "outside")
    nodeFs.mkdirSync(outside)
    nodeFs.writeFileSync(nodePath.join(outside, "keep.txt"), "keep")
    write("a.txt")
    nodeFs.symlinkSync(outside, nodePath.join(generatedDir, "outside-link"))

    expect((await run(check())).fileCount).toBe(1)

    await run(del())
    expect(nodeFs.readdirSync(generatedDir)).toEqual([])
    expect(nodeFs.readFileSync(nodePath.join(outside, "keep.txt"), "utf8")).toBe("keep")
  })

  it("resolves a relative outputPath override against the working directory", async () => {
    const custom = nodePath.join(workingDir, "custom", "out")
    nodeFs.mkdirSync(custom, { recursive: true })
    nodeFs.writeFileSync(nodePath.join(custom, "file.txt"), "x")

    expect(await run(check("custom/out"))).toEqual({
      hasFiles: true,
      absoluteOutputPath: custom,
      relativeOutputPath: "custom/out",
      fileCount: 1,
    })

    const deleted = await run(del("custom/out"))
    expect(deleted.deletedCount).toBe(1)
    expect(nodeFs.readdirSync(custom)).toEqual([])
  })
})
