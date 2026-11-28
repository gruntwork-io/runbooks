import { createHash } from "node:crypto"
import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { RunbookPath } from "@runbooks/blocks-core/contract"
import { ContentHash } from "../document/document.ts"
import type { FileFact } from "../document/files.ts"
import { diffHunks, filesOnDiskOf } from "./filesOnDisk.ts"
import { FilesOnDisk, LIMITS } from "./protocol.ts"

const at = Schema.decodeSync(RunbookPath)
const toHash = Schema.decodeSync(ContentHash)
const hashOf = (text: string) => toHash(`sha256:${createHash("sha256").update(text).digest("hex")}`)

/** A file a block names, with `text`. */
const file = (path: string, text: string): FileFact => ({
  _tag: "Found",
  hash: hashOf(`${path}:${text}`),
  texts: [{ path, text }],
})

/** A folder a block names, holding `files`, by path. */
const folder = (name: string, files: Readonly<Record<string, string>>): FileFact => ({
  _tag: "Found",
  hash: hashOf(`${name}:${JSON.stringify(files)}`),
  texts: Object.entries(files).map(([path, text]) => ({ path, text })),
})

const lines = (...all: ReadonlyArray<string>) => all.map((line) => `${line}\n`).join("")

/** What a block naming `named` shows, the session holding `held` and the disk `disk`. */
const shown = (
  named: ReadonlyArray<string>,
  held: Readonly<Record<string, FileFact>>,
  disk: Readonly<Record<string, FileFact>>,
) =>
  filesOnDiskOf(
    named.map((path) => at(path)),
    new Map(Object.entries(held).map(([path, fact]) => [at(path), fact])),
    new Map(Object.entries(disk).map(([path, fact]) => [at(path), fact])),
  )

const context = (text: string) => ({ kind: "context", text }) as const
const deletion = (text: string) => ({ kind: "deletion", text }) as const
const addition = (text: string) => ({ kind: "addition", text }) as const

describe("a block's files on disk", () => {
  it("shows nothing while each file it names is as the session holds it", () => {
    const deploy = file("deploy.sh", lines("echo hi"))
    expect(shown(["deploy.sh"], { "deploy.sh": deploy }, {})).toBeUndefined()
    expect(shown(["deploy.sh"], { "deploy.sh": deploy }, { "deploy.sh": deploy })).toBeUndefined()
  })

  it("shows the lines that changed, with three lines of context, at the line each hunk starts", () => {
    const held = lines("a", "b", "c", "d", "e", "f", "g", "h")
    const disk = lines("a", "b", "c", "d", "E", "f", "g", "h")
    expect(
      shown(
        ["deploy.sh"],
        { "deploy.sh": file("deploy.sh", held) },
        { "deploy.sh": file("deploy.sh", disk) },
      )?.files,
    ).toEqual([
      {
        _tag: "Changed",
        path: at("deploy.sh"),
        change: "modified",
        hunks: [
          {
            heldLine: 2,
            diskLine: 2,
            lines: [
              context("b"),
              context("c"),
              context("d"),
              deletion("e"),
              addition("E"),
              context("f"),
              context("g"),
              context("h"),
            ],
          },
        ],
      },
    ])
  })

  it("puts changes more than six lines apart in hunks of their own, and nearer ones in one", () => {
    const held = lines("1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14")
    const far = lines("X", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "Y")
    const near = lines("X", "2", "3", "4", "5", "6", "7", "Y", "9", "10", "11", "12", "13", "14")
    const hunksOf = (disk: string) =>
      diffHunks(held, disk).map(({ heldLine, diskLine, lines: all }) => ({
        heldLine,
        diskLine,
        count: all.length,
      }))
    expect(hunksOf(far)).toEqual([
      { heldLine: 1, diskLine: 1, count: 5 },
      { heldLine: 11, diskLine: 11, count: 5 },
    ])
    expect(hunksOf(near)).toEqual([{ heldLine: 1, diskLine: 1, count: 13 }])
  })

  it("counts lines from where the held and disk texts differ in length", () => {
    const held = lines("a", "b", "c", "d", "e", "f", "g", "h", "i", "j")
    const disk = lines("new", "a", "b", "c", "d", "e", "f", "g", "h", "I", "j")
    expect(diffHunks(held, disk).map(({ heldLine, diskLine }) => [heldLine, diskLine])).toEqual([
      [1, 1],
      [6, 7],
    ])
  })

  it("shows a file whose text differs only in line endings or a final newline as modified, with no lines", () => {
    const held = file("deploy.sh", "echo hi\necho there\n")
    for (const disk of ["echo hi\r\necho there\r\n", "echo hi\necho there"])
      expect(
        shown(["deploy.sh"], { "deploy.sh": held }, { "deploy.sh": file("deploy.sh", disk) })
          ?.files,
      ).toEqual([{ _tag: "Changed", path: at("deploy.sh"), change: "modified", hunks: [] }])
  })

  it("shows a file new in a folder it names as created, and one gone as deleted, in path order", () => {
    const held = folder("scripts", { "scripts/b.sh": lines("b"), "scripts/c.sh": lines("c") })
    const disk = folder("scripts", { "scripts/a.sh": lines("a"), "scripts/b.sh": lines("b") })
    expect(shown(["scripts"], { scripts: held }, { scripts: disk })?.files).toEqual([
      {
        _tag: "Changed",
        path: at("scripts/a.sh"),
        change: "created",
        hunks: [{ heldLine: 1, diskLine: 1, lines: [addition("a")] }],
      },
      {
        _tag: "Changed",
        path: at("scripts/c.sh"),
        change: "deleted",
        hunks: [{ heldLine: 1, diskLine: 1, lines: [deletion("c")] }],
      },
    ])
  })

  it("shows a file it names that is gone from disk as deleted, and one there again as created", () => {
    const deploy = file("deploy.sh", lines("echo hi"))
    const missing: FileFact = { _tag: "Missing" }
    expect(
      shown(["deploy.sh"], { "deploy.sh": deploy }, { "deploy.sh": missing })?.files,
    ).toMatchObject([{ path: "deploy.sh", change: "deleted" }])
    expect(
      shown(["deploy.sh"], { "deploy.sh": missing }, { "deploy.sh": deploy })?.files,
    ).toMatchObject([{ path: "deploy.sh", change: "created" }])
  })

  it("shows a path it cannot take as it is on disk as unreadable, saying why", () => {
    const held = file("deploy.sh", lines("echo hi"))
    expect(
      shown(["deploy.sh"], { "deploy.sh": held }, { "deploy.sh": { _tag: "Outside" } })?.files,
    ).toEqual([
      {
        _tag: "Unreadable",
        path: at("deploy.sh"),
        reason:
          "deploy.sh, which is outside the runbook's folder. A block can only name files in its runbook's folder.",
      },
    ])
    expect(
      shown(
        ["deploy.sh"],
        { "deploy.sh": held },
        { "deploy.sh": { _tag: "OverLimit", limit: "fileBytes", path: "deploy.sh" } },
      )?.files,
    ).toMatchObject([{ _tag: "Unreadable", reason: expect.stringContaining("is over") }])
  })

  it("lists only the paths the block names, and hashes what is on disk at each of them", () => {
    const one = file("one.sh", lines("1"))
    const two = file("two.sh", lines("2"))
    const changed = file("one.sh", lines("one"))
    const other = file("one.sh", lines("uno"))
    const held = { "one.sh": one, "two.sh": two }
    const first = shown(["one.sh", "two.sh"], held, { "one.sh": changed })
    expect(first?.files.map(({ path }) => path)).toEqual([at("one.sh")])
    expect(shown(["two.sh"], held, { "one.sh": changed })).toBeUndefined()
    expect(shown(["one.sh", "two.sh"], held, { "one.sh": changed })?.hash).toBe(first?.hash)
    expect(shown(["one.sh", "two.sh"], held, { "one.sh": other })?.hash).not.toBe(first?.hash)
  })

  it("falls back to deleting every changed line and adding every new one past the most edits it searches, keeping the lines both start and end with", () => {
    const held = lines("start", "a", "x", "b", "x", "c", "end")
    const disk = lines("start", "x", "a", "x", "b", "x", "end")
    const kinds = (max: number) =>
      diffHunks(held, disk, max).flatMap((hunk) => hunk.lines.map(({ kind }) => kind[0]))
    expect(kinds(1).join("")).toBe("cdddddaaaaac")
    expect(kinds(1000).join("")).not.toBe("cdddddaaaaac")
  })

  it("leaves out the lines and files past the characters a diff may hold, counting each path, reason and line with its ending, and says so", () => {
    const outside: FileFact = { _tag: "Outside" }
    const held = {
      "0.sh": file("0.sh", lines("0")),
      "a.sh": file("a.sh", ""),
      "b.sh": file("b.sh", lines("b")),
    }
    const alone = shown(["0.sh"], held, { "0.sh": outside })?.files[0]
    const reason = alone?._tag === "Unreadable" ? alone.reason : ""
    const left = LIMITS.maxDiffChars - "0.sh".length - reason.length - "a.sh".length
    // A line costs one character more than half of what is left, with its
    // ending: one fits, and a second would, were any cost left uncounted.
    const line = "x".repeat(Math.floor(left / 2))
    const disk = {
      "0.sh": outside,
      "a.sh": file("a.sh", lines(line, line, line)),
      "b.sh": file("b.sh", lines("B")),
    }
    const onDisk = shown(["b.sh", "a.sh", "0.sh"], held, disk)
    expect(onDisk?.truncated).toBe(true)
    expect(onDisk?.files.map(({ path }) => path)).toEqual([at("0.sh"), at("a.sh")])
    const [, kept] = onDisk?.files ?? []
    expect(kept?._tag === "Changed" ? kept.hunks.map((hunk) => hunk.lines.length) : []).toEqual([1])
    // What the bound keeps is what the protocol's own check allows.
    expect(Schema.is(FilesOnDisk)(onDisk)).toBe(true)
  })

  it("lists the files in path order, whatever order the block names them in", () => {
    const held = { "b.sh": file("b.sh", lines("b")), "a.sh": file("a.sh", lines("a")) }
    const disk = { "b.sh": file("b.sh", lines("B")), "a.sh": file("a.sh", lines("A")) }
    expect(shown(["b.sh", "a.sh"], held, disk)?.files.map(({ path }) => path)).toEqual([
      at("a.sh"),
      at("b.sh"),
    ])
  })

  it("shows a folder whose bytes changed but no file's text did as modified, with no lines", () => {
    const held: FileFact = {
      _tag: "Found",
      hash: hashOf("0644"),
      texts: [{ path: "scripts/a.sh", text: "a" }],
    }
    const disk: FileFact = { ...held, hash: hashOf("0755") }
    expect(shown(["scripts"], { scripts: held }, { scripts: disk })?.files).toEqual([
      { _tag: "Changed", path: at("scripts"), change: "modified", hunks: [] },
    ])
  })

  it("says nothing was left out of a diff within the bound", () => {
    const held = { "a.sh": file("a.sh", lines("a")) }
    expect(shown(["a.sh"], held, { "a.sh": file("a.sh", lines("A")) })).not.toHaveProperty(
      "truncated",
    )
  })
})
