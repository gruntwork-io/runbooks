import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { Effect, Exit } from "effect"
import * as nodeFs from "node:fs"
import * as nodePath from "node:path"
import * as os from "node:os"
import { writeInlineRenderedFiles, type InlineWriteRecord } from "./writeInlineRenderedFiles.ts"
import { NodeFileSystemLive } from "../../layers/NodeFileSystem.ts"

// Runs against a real temp directory: the bug this pins was a key being
// treated as a directory and a missing parent directory, both of which only
// show up on a real filesystem.
describe("writeInlineRenderedFiles", () => {
  let tmp: string
  let baseDir: string

  beforeEach(() => {
    tmp = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "inline-render-"))
    baseDir = nodePath.join(tmp, "output")
  })

  afterEach(() => {
    nodeFs.rmSync(tmp, { recursive: true, force: true })
  })

  const run = (files: Record<string, string>, previous?: InlineWriteRecord, dir = baseDir) =>
    Effect.runPromiseExit(
      writeInlineRenderedFiles(files, dir, previous).pipe(Effect.provide(NodeFileSystemLive)),
    )

  /** Run a render that must succeed and return what it recorded. */
  const write = async (files: Record<string, string>, previous?: InlineWriteRecord, dir = baseDir) => {
    const exit = await run(files, previous, dir)
    if (!Exit.isSuccess(exit)) throw new Error(`render failed: ${String(exit.cause)}`)
    return exit.value
  }

  const at = (rel: string, dir = baseDir) => nodePath.join(dir, rel)

  it("writes a top-level key as a file named by the key, not as a directory", async () => {
    const exit = await run({ "README.md": "# Hello" })

    expect(Exit.isSuccess(exit)).toBe(true)
    const written = nodePath.join(baseDir, "README.md")
    expect(nodeFs.statSync(written).isFile()).toBe(true)
    expect(nodeFs.readFileSync(written, "utf-8")).toBe("# Hello")
  })

  it("creates the parent directories of a nested key", async () => {
    const exit = await run({ "docs/env/account.hcl": 'account_name = "dev"' })

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(nodeFs.readFileSync(nodePath.join(baseDir, "docs/env/account.hcl"), "utf-8")).toBe(
      'account_name = "dev"',
    )
  })

  it("overwrites a file written by an earlier render", async () => {
    await run({ "config.yaml": "v: 1" })
    const exit = await run({ "config.yaml": "v: 2" })

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(nodeFs.readFileSync(nodePath.join(baseDir, "config.yaml"), "utf-8")).toBe("v: 2")
  })

  it("rejects a key that escapes the base directory and writes nothing", async () => {
    const exit = await run({ "ok.txt": "fine", "../escape.txt": "nope" })

    expect(Exit.isFailure(exit)).toBe(true)
    expect(nodeFs.existsSync(nodePath.join(tmp, "escape.txt"))).toBe(false)
    expect(nodeFs.existsSync(nodePath.join(baseDir, "ok.txt"))).toBe(false)
  })

  it("rejects an absolute key", async () => {
    const outside = nodePath.join(tmp, "abs.txt")
    const exit = await run({ [outside]: "nope" })

    expect(Exit.isFailure(exit)).toBe(true)
    expect(nodeFs.existsSync(outside)).toBe(false)
  })

  // The DirPicker case: outputPath is "{{ .outputs.picker.PATH }}/terragrunt.hcl"
  // and every pick re-renders at a new path. The block must end up owning one
  // file, not one per intermediate selection.
  describe("with the block's previous render", () => {
    it("records each file it wrote with the hash of its content", async () => {
      const record = await write({ "acct/terragrunt.hcl": "a = 1" })

      expect(record.outputDir).toBe(baseDir)
      expect(record.files).toHaveLength(1)
      expect(record.files[0].path).toBe("acct/terragrunt.hcl")
      expect(record.files[0].contentHash).toMatch(/^[0-9a-f]{64}$/)
    })

    it("removes the file at the old path and the directories that leaves empty", async () => {
      const first = await write({ "acct/terragrunt.hcl": "a = 1" })
      const second = await write({ "acct/region/terragrunt.hcl": "a = 1" }, first)
      await write({ "other/env/terragrunt.hcl": "a = 1" }, second)

      expect(nodeFs.existsSync(at("acct"))).toBe(false)
      expect(nodeFs.readFileSync(at("other/env/terragrunt.hcl"), "utf-8")).toBe("a = 1")
      // The output dir itself is never removed.
      expect(nodeFs.readdirSync(baseDir)).toEqual(["other"])
    })

    it("keeps a directory that still holds other files", async () => {
      nodeFs.mkdirSync(at("acct"), { recursive: true })
      nodeFs.writeFileSync(at("acct/account.hcl"), "keep me")
      const first = await write({ "acct/terragrunt.hcl": "a = 1" })

      await write({ "elsewhere/terragrunt.hcl": "a = 1" }, first)

      expect(nodeFs.existsSync(at("acct/terragrunt.hcl"))).toBe(false)
      expect(nodeFs.readFileSync(at("acct/account.hcl"), "utf-8")).toBe("keep me")
    })

    it("keeps the old file when it no longer holds what the block wrote", async () => {
      const first = await write({ "a/terragrunt.hcl": "a = 1" })
      nodeFs.writeFileSync(at("a/terragrunt.hcl"), "a = 1 # edited by hand")

      await write({ "b/terragrunt.hcl": "a = 1" }, first)

      expect(nodeFs.readFileSync(at("a/terragrunt.hcl"), "utf-8")).toBe("a = 1 # edited by hand")
    })

    it("rewrites in place when the path did not change", async () => {
      const first = await write({ "config.yaml": "v: 1" })

      const second = await write({ "config.yaml": "v: 2" }, first)

      expect(nodeFs.readFileSync(at("config.yaml"), "utf-8")).toBe("v: 2")
      expect(second.files[0].contentHash).not.toBe(first.files[0].contentHash)
    })

    it("ignores an old file that is already gone", async () => {
      const first = await write({ "a.txt": "x" })
      nodeFs.rmSync(at("a.txt"))

      await write({ "b.txt": "x" }, first)

      expect(nodeFs.readFileSync(at("b.txt"), "utf-8")).toBe("x")
    })

    it("removes the old file from the directory it was written in when the base dir changed", async () => {
      const worktree = nodePath.join(tmp, "worktree")
      const first = await write({ "out.txt": "x" })

      await write({ "out.txt": "x" }, first, worktree)

      expect(nodeFs.existsSync(at("out.txt"))).toBe(false)
      expect(nodeFs.readFileSync(at("out.txt", worktree), "utf-8")).toBe("x")
    })

    it("can turn a file path into a directory path", async () => {
      const first = await write({ docs: "as a file" })

      await write({ "docs/account.hcl": "as a dir" }, first)

      expect(nodeFs.readFileSync(at("docs/account.hcl"), "utf-8")).toBe("as a dir")
    })

    it("removes nothing when the new path is rejected", async () => {
      const first = await write({ "keep.txt": "x" })

      const exit = await run({ "../escape.txt": "nope" }, first)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(nodeFs.readFileSync(at("keep.txt"), "utf-8")).toBe("x")
    })
  })
})
