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

    // Typing a new unit name into a DirPicker next to an existing unit: one
    // of the intermediate paths is that unit's own terragrunt.hcl.
    it("puts back a file that was already there instead of removing it", async () => {
      nodeFs.mkdirSync(at("env/vpc"), { recursive: true })
      nodeFs.writeFileSync(at("env/vpc/terragrunt.hcl"), "ORIGINAL")

      const first = await write({ "env/vpc/terragrunt.hcl": "rendered" })
      expect(nodeFs.readFileSync(at("env/vpc/terragrunt.hcl"), "utf-8")).toBe("rendered")
      const second = await write({ "env/vpc-/terragrunt.hcl": "rendered" }, first)
      await write({ "env/vpc-peering/terragrunt.hcl": "rendered" }, second)

      expect(nodeFs.readFileSync(at("env/vpc/terragrunt.hcl"), "utf-8")).toBe("ORIGINAL")
      expect(nodeFs.readdirSync(at("env")).sort()).toEqual(["vpc", "vpc-peering"])
      expect(nodeFs.readFileSync(at("env/vpc-peering/terragrunt.hcl"), "utf-8")).toBe("rendered")
    })

    it("records the original content only for a file that was already there", async () => {
      nodeFs.mkdirSync(baseDir, { recursive: true })
      nodeFs.writeFileSync(at("existing.txt"), "before")

      const record = await write({ "existing.txt": "after", "new.txt": "fresh" })

      const byPath = new Map(record.files.map((f) => [f.path, f]))
      expect(byPath.get("existing.txt")?.original?.toString("utf-8")).toBe("before")
      expect(byPath.get("new.txt")?.original).toBeUndefined()
    })

    it("keeps the first original while the block rewrites the same path", async () => {
      nodeFs.mkdirSync(baseDir, { recursive: true })
      nodeFs.writeFileSync(at("config.yaml"), "ORIGINAL")

      const first = await write({ "config.yaml": "v: 1" })
      const second = await write({ "config.yaml": "v: 2" }, first)
      await write({ "other.yaml": "v: 2" }, second)

      expect(nodeFs.readFileSync(at("config.yaml"), "utf-8")).toBe("ORIGINAL")
    })

    it("keeps a file that was already there when the render matched its content", async () => {
      nodeFs.mkdirSync(at("unit"), { recursive: true })
      nodeFs.writeFileSync(at("unit/terragrunt.hcl"), "a = 1")

      const first = await write({ "unit/terragrunt.hcl": "a = 1" })
      await write({ "elsewhere/terragrunt.hcl": "a = 1" }, first)

      expect(nodeFs.readFileSync(at("unit/terragrunt.hcl"), "utf-8")).toBe("a = 1")
    })

    it("puts back a binary original byte for byte", async () => {
      const bytes = Buffer.from([0xff, 0x00, 0xfe, 0x80, 0x0a])
      nodeFs.mkdirSync(baseDir, { recursive: true })
      nodeFs.writeFileSync(at("blob.bin"), bytes)

      const first = await write({ "blob.bin": "text" })
      await write({ "other.txt": "text" }, first)

      expect(nodeFs.readFileSync(at("blob.bin")).equals(bytes)).toBe(true)
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

    it("leaves the old file in place when the base dir changed", async () => {
      // e.g. target="worktree" after a second <GitClone> became the active
      // worktree: repo A's file must survive, since A may still be opened as a PR.
      const repoA = nodePath.join(tmp, "repo-a")
      const repoB = nodePath.join(tmp, "repo-b")
      const first = await write({ "docs/account.hcl": "x" }, undefined, repoA)

      const second = await write({ "docs/account.hcl": "x" }, first, repoB)

      expect(nodeFs.readFileSync(at("docs/account.hcl", repoA), "utf-8")).toBe("x")
      expect(nodeFs.readFileSync(at("docs/account.hcl", repoB), "utf-8")).toBe("x")
      expect(second.outputDir).toBe(repoB)
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
