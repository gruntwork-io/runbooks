import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { Effect, Exit } from "effect"
import * as nodeFs from "node:fs"
import * as nodePath from "node:path"
import * as os from "node:os"
import { writeInlineRenderedFiles } from "./writeInlineRenderedFiles.ts"
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

  const run = (files: Record<string, string>) =>
    Effect.runPromiseExit(
      writeInlineRenderedFiles(files, baseDir).pipe(Effect.provide(NodeFileSystemLive)),
    )

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
})
