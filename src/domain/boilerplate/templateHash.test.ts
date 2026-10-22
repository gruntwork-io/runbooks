import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { Effect, Layer } from "effect"
import * as nodeFs from "node:fs"
import * as nodePath from "node:path"
import * as os from "node:os"
import { hashTemplateDir } from "./templateHash.ts"
import { NodeFileSystemLive } from "../../layers/NodeFileSystem.ts"
import { FileSystem } from "../../services/FileSystem.ts"

// Runs against real temp directories: the hash is over what a directory walk
// finds, so the walk is what is under test.
describe("hashTemplateDir", () => {
  let tmp: string

  beforeEach(() => {
    tmp = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "template-hash-"))
  })

  afterEach(() => {
    nodeFs.rmSync(tmp, { recursive: true, force: true })
  })

  /** A template directory named `name` with `files` (relative path -> content). */
  function template(name: string, files: Record<string, string>): string {
    const dir = nodePath.join(tmp, name)
    nodeFs.mkdirSync(dir, { recursive: true })
    for (const [rel, content] of Object.entries(files)) {
      nodeFs.mkdirSync(nodePath.dirname(nodePath.join(dir, rel)), { recursive: true })
      nodeFs.writeFileSync(nodePath.join(dir, rel), content)
    }
    return dir
  }

  const hash = (dir: string) =>
    Effect.runPromise(hashTemplateDir(dir).pipe(Effect.provide(NodeFileSystemLive)))

  const BASE = {
    "boilerplate.yml": "variables: []\n",
    "main.tf": 'resource "x" "y" {}\n',
    "modules/vpc/main.tf": "# vpc\n",
  }

  it("is the same for two directories with the same files, whatever order they were written in", async () => {
    const a = template("a", BASE)
    const b = template("b", {
      "modules/vpc/main.tf": BASE["modules/vpc/main.tf"],
      "main.tf": BASE["main.tf"],
      "boilerplate.yml": BASE["boilerplate.yml"],
    })

    expect(await hash(a)).toMatch(/^[0-9a-f]{64}$/)
    expect(await hash(a)).toBe(await hash(b))
  })

  it("changes when a file's content changes", async () => {
    const before = await hash(template("a", BASE))

    const after = await hash(template("b", { ...BASE, "modules/vpc/main.tf": "# vpc v2\n" }))

    expect(after).not.toBe(before)
  })

  it("changes when a file is renamed, added or removed", async () => {
    const base = await hash(template("base", BASE))
    const { "main.tf": main, ...withoutMain } = BASE

    const renamed = await hash(template("renamed", { ...withoutMain, "root.tf": main }))
    const added = await hash(template("added", { ...BASE, "outputs.tf": "" }))
    const removed = await hash(template("removed", withoutMain))

    expect(new Set([base, renamed, added, removed]).size).toBe(4)
  })

  it("keeps a path apart from the content that follows it", async () => {
    const a = await hash(template("a", { a: "bc" }))
    const b = await hash(template("b", { ab: "c" }))

    expect(a).not.toBe(b)
  })

  it("leaves out version control directories and empty directories", async () => {
    const base = await hash(template("base", BASE))
    const dir = template("vcs", {
      ...BASE,
      ".git/HEAD": "ref: refs/heads/main\n",
      ".svn/entries": "12\n",
      ".hg/store/data": "x",
      "modules/.git/config": "[core]\n",
    })
    nodeFs.mkdirSync(nodePath.join(dir, "empty"))

    expect(await hash(dir)).toBe(base)
  })

  it("counts a file it can't read as empty", async () => {
    if (process.getuid?.() === 0) return // root reads any file
    const empty = await hash(template("empty", { ...BASE, "secret.tf": "" }))
    const dir = template("unreadable", { ...BASE, "secret.tf": "hidden" })
    nodeFs.chmodSync(nodePath.join(dir, "secret.tf"), 0o000)

    expect(await hash(dir)).toBe(empty)
  })

  it("is the hash of nothing for a directory that does not exist", async () => {
    const missing = await hash(nodePath.join(tmp, "missing"))

    expect(missing).toBe(await hash(template("empty", {})))
  })

  it("reads files 16 directories down, and none deeper", async () => {
    const levels = (n: number) => Array.from({ length: n }, (_, i) => `d${i}`).join("/")
    const base = await hash(template("base", BASE))

    const at16 = await hash(template("at16", { ...BASE, [`${levels(16)}/f`]: "x" }))
    const at17 = await hash(template("at17", { ...BASE, [`${levels(17)}/f`]: "x" }))

    expect(at16).not.toBe(base)
    expect(at17).toBe(base)
  })

  it("is the same whatever order the file system lists a directory in", async () => {
    const dir = template("a", { ...BASE, "a.tf": "1", "b.tf": "2", "modules/z.tf": "3" })
    const real = Effect.runSync(Effect.provide(FileSystem, NodeFileSystemLive))
    const backwards = Layer.succeed(FileSystem, {
      ...real,
      readdirWithTypes: (p: string) =>
        real.readdirWithTypes(p).pipe(Effect.map((entries) => [...entries].reverse())),
    })

    const listedBackwards = await Effect.runPromise(
      hashTemplateDir(dir).pipe(Effect.provide(backwards)),
    )

    expect(listedBackwards).toBe(await hash(dir))
  })

  it("does not follow a symbolic link", async () => {
    const outside = template("outside", { "secret.txt": "x" })
    const base = await hash(template("base", BASE))
    const dir = template("linked", BASE)
    nodeFs.symlinkSync(nodePath.join(outside, "secret.txt"), nodePath.join(dir, "link.txt"))
    nodeFs.symlinkSync(outside, nodePath.join(dir, "linked-dir"))

    expect(await hash(dir)).toBe(base)
  })

  it("reads the first 2000 files in sorted order, and none after", async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 2000; i++) files[`f${String(i).padStart(4, "0")}`] = "x"
    const full = await hash(template("full", files))

    // "z" sorts after every f####: the 2001st file.
    const extra = await hash(template("extra", { ...files, z: "changed" }))
    // "e" sorts first, pushing f1999 out.
    const first = await hash(template("first", { ...files, e: "x" }))

    expect(extra).toBe(full)
    expect(first).not.toBe(full)
  })
})
