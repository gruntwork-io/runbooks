import { describe, it, expect } from "vitest"
import {
  buildDiffSections,
  diffDiskContents,
  diffLineArrays,
  diskLines,
  generateUnifiedDiff,
  getExpandedLines,
  headLines,
  type DiffLine,
} from "./unifiedDiff"

/** The rows as they read in the view: prefix + content. */
const rows = (lines: DiffLine[] | undefined) =>
  lines?.map(
    (l) => `${l.type === "addition" ? "+" : l.type === "deletion" ? "-" : " "}${l.content}`,
  )

const counts = (lines: DiffLine[] | undefined) => ({
  additions: lines?.filter((l) => l.type === "addition").length,
  deletions: lines?.filter((l) => l.type === "deletion").length,
})

// originalContent is rebuilt from `git show` lines (no final newline);
// newContent is read from disk (keeps it).
const modified = (originalContent: string | undefined, newContent: string | undefined) =>
  generateUnifiedDiff({ changeType: "modified", originalContent, newContent })

describe("headLines", () => {
  it("treats empty content as zero lines", () => {
    expect(headLines("")).toEqual([])
  })

  it("treats every newline as a line separator", () => {
    expect(headLines("a")).toEqual(["a"])
    expect(headLines("a\nb")).toEqual(["a", "b"])
    expect(headLines("a\n")).toEqual(["a", ""])
  })
})

describe("diskLines", () => {
  it("treats empty content as zero lines", () => {
    expect(diskLines("")).toEqual([])
  })

  it("drops one trailing newline", () => {
    expect(diskLines("a")).toEqual(["a"])
    expect(diskLines("a\n")).toEqual(["a"])
    expect(diskLines("a\n\n")).toEqual(["a", ""])
    expect(diskLines("\n")).toEqual([""])
  })

  it("ends lines at CRLF and a lone CR, as readline does", () => {
    expect(diskLines("a\r\nb\r\n")).toEqual(["a", "b"])
    expect(diskLines("a\r\n\r\n")).toEqual(["a", ""])
    expect(diskLines("a\rb\r")).toEqual(["a", "b"])
  })
})

describe("generateUnifiedDiff", () => {
  it("renders an added file as numbered additions", () => {
    expect(generateUnifiedDiff({ changeType: "added", newContent: "a\nb\n" })).toEqual([
      { type: "addition", content: "a", newLineNum: 1 },
      { type: "addition", content: "b", newLineNum: 2 },
    ])
  })

  it("renders a deleted file as numbered deletions", () => {
    expect(generateUnifiedDiff({ changeType: "deleted", originalContent: "a\nb" })).toEqual([
      { type: "deletion", content: "a", oldLineNum: 1 },
      { type: "deletion", content: "b", oldLineNum: 2 },
    ])
  })

  it("numbers old and new lines independently for a modified file", () => {
    expect(modified("a\nb\nc", "a\nB\nc\nd\n")).toEqual([
      { type: "context", content: "a", oldLineNum: 1, newLineNum: 1 },
      { type: "deletion", content: "b", oldLineNum: 2 },
      { type: "addition", content: "B", newLineNum: 2 },
      { type: "context", content: "c", oldLineNum: 3, newLineNum: 3 },
      { type: "addition", content: "d", newLineNum: 4 },
    ])
  })

  it("renders a modified file that was empty in HEAD as all additions", () => {
    expect(rows(modified("", "a\nb\n"))).toEqual(["+a", "+b"])
  })

  it("renders a modified file truncated to empty as all deletions", () => {
    expect(rows(modified("a\nb", ""))).toEqual(["-a", "-b"])
  })

  it("renders empty added and deleted files as no lines", () => {
    expect(generateUnifiedDiff({ changeType: "added", newContent: "" })).toEqual([])
    expect(generateUnifiedDiff({ changeType: "deleted", originalContent: "" })).toEqual([])
  })

  it("returns undefined when a side the change type needs is missing", () => {
    expect(modified(undefined, "a\n")).toBeUndefined()
    expect(modified("a", undefined)).toBeUndefined()
    expect(generateUnifiedDiff({ changeType: "added" })).toBeUndefined()
    expect(generateUnifiedDiff({ changeType: "deleted" })).toBeUndefined()
  })

  it("does not report a change for the trailing newline only disk content has", () => {
    expect(rows(modified("a\nb", "a\nb\n"))).toEqual([" a", " b"])
  })

  // A file ending in a blank line ("x\n\n" in HEAD) comes back from `git show`
  // as the lines ['x', ''], so originalContent is 'x\n': that '\n' separates
  // two lines rather than ending the file.
  it("keeps the blank last line of HEAD content", () => {
    expect(rows(modified("x\n", "y\n\n"))).toEqual(["-x", "+y", " "])
    expect(counts(modified("x\n", "y\n\n"))).toEqual({ additions: 1, deletions: 1 })
  })

  it("renders a deleted file ending in a blank line as one deletion per line", () => {
    expect(rows(generateUnifiedDiff({ changeType: "deleted", originalContent: "x\n" }))).toEqual([
      "-x",
      "-",
    ])
  })

  // `git show` lines come through readline, which drops the CR of a CRLF line
  // ending; disk content keeps it.
  it("does not report a change for the CRs only disk content has", () => {
    expect(rows(modified("a\nb\nc", "a\r\nB\r\nc\r\n"))).toEqual([" a", "-b", "+B", " c"])
  })

  it("renders an added CRLF file without the CRs", () => {
    expect(rows(generateUnifiedDiff({ changeType: "added", newContent: "a\r\nb\r\n" }))).toEqual([
      "+a",
      "+b",
    ])
  })

  // Expected counts are what `git diff --numstat` reported for the same edit,
  // which is what the file header's +N/-M badge shows.
  it.each([
    {
      name: "deleting the first of two blocks",
      before: 'module "a" {\n  source = "./a"\n}\n\nmodule "b" {\n  source = "./b"\n}',
      after: 'module "b" {\n  source = "./b"\n}\n',
      additions: 0,
      deletions: 4,
    },
    {
      name: "lines that repeat in the new file",
      before: "b\nc\n}",
      after: "}\na\nc\nb\nc\n}\n",
      additions: 3,
      deletions: 0,
    },
    {
      name: "inserting a block between two others",
      before: 'resource "x" "a" {\n}\n\nresource "x" "c" {\n}',
      after: 'resource "x" "a" {\n}\n\nresource "x" "b" {\n}\n\nresource "x" "c" {\n}\n',
      additions: 3,
      deletions: 0,
    },
    {
      name: "edits in several places",
      before: [
        'variable "region" {',
        '  default = "us-east-1"',
        "}",
        "",
        'variable "name" {',
        '  default = "app"',
        "}",
        "",
        'variable "size" {',
        "  default = 1",
        "}",
        "",
        'variable "tags" {',
        "  default = {}",
        "}",
      ].join("\n"),
      after: [
        'variable "region" {',
        '  default = "eu-west-1"',
        "}",
        "",
        'variable "name" {',
        '  default = "app"',
        "}",
        "",
        'variable "size" {',
        "  default = 1",
        "}",
        "",
        'variable "tags" {',
        '  default = { env = "prod" }',
        "}",
        "",
        'variable "extra" {',
        "  default = true",
        "}",
        "",
      ].join("\n"),
      additions: 6,
      deletions: 2,
    },
  ])("matches git numstat counts: $name", ({ before, after, additions, deletions }) => {
    expect(counts(modified(before, after))).toEqual({ additions, deletions })
  })

  it("shows the deleted block, not a rewrite, when the second block remains", () => {
    const before = 'module "a" {\n  source = "./a"\n}\n\nmodule "b" {\n  source = "./b"\n}'
    const after = 'module "b" {\n  source = "./b"\n}\n'
    expect(rows(modified(before, after))).toEqual([
      '-module "a" {',
      '-  source = "./a"',
      "-}",
      "-",
      ' module "b" {',
      " " + '  source = "./b"',
      " }",
    ])
  })
})

describe("diffDiskContents", () => {
  it("diffs two versions read from disk, numbering both sides", () => {
    expect(
      diffDiskContents("#!/bin/bash\necho before\n", "#!/bin/bash\necho after\necho done\n"),
    ).toEqual([
      { type: "context", content: "#!/bin/bash", oldLineNum: 1, newLineNum: 1 },
      { type: "deletion", content: "echo before", oldLineNum: 2 },
      { type: "addition", content: "echo after", newLineNum: 2 },
      { type: "addition", content: "echo done", newLineNum: 3 },
    ])
  })

  it("has no changed rows when only the line endings or the final newline differ", () => {
    expect(rows(diffDiskContents("a\nb\n", "a\r\nb\r\n"))).toEqual([" a", " b"])
    expect(rows(diffDiskContents("a\nb\n", "a\nb"))).toEqual([" a", " b"])
  })
})

describe("diffLineArrays", () => {
  it("puts deletions before insertions in a replaced region", () => {
    expect(diffLineArrays(["x", "a", "y"], ["x", "b", "y"])).toEqual([
      { type: "equal", value: "x" },
      { type: "delete", value: "a" },
      { type: "insert", value: "b" },
      { type: "equal", value: "y" },
    ])
  })

  it("finds a minimal diff when the changed region has no common prefix or suffix", () => {
    const ops = diffLineArrays(["a", "b", "c", "a", "b", "b", "a"], ["c", "b", "a", "b", "a", "c"])
    // The classic Myers example: the shortest edit script has 5 edits.
    expect(ops.filter((op) => op.type !== "equal")).toHaveLength(5)
    expect(ops.filter((op) => op.type !== "insert").map((op) => op.value)).toEqual([
      "a",
      "b",
      "c",
      "a",
      "b",
      "b",
      "a",
    ])
    expect(ops.filter((op) => op.type !== "delete").map((op) => op.value)).toEqual([
      "c",
      "b",
      "a",
      "b",
      "a",
      "c",
    ])
  })

  it("keeps a longest common subsequence of lines on random edits", () => {
    // Short files drawn from a few repeated lines, like '}' and blank lines,
    // are where a greedy diff goes wrong.
    let seed = 1
    const random = (n: number) => {
      seed = (seed * 48271) % 2147483647
      return seed % n
    }
    const randomLines = () =>
      Array.from({ length: random(12) }, () => ["}", "", "a", "b"][random(4)]!)
    // dp[i][j] is the LCS length of a[..i] and b[..j]; every index read is in
    // the (a.length + 1) x (b.length + 1) table.
    const lcsLength = (a: string[], b: string[]) => {
      const dp = Array.from({ length: a.length + 1 }, () =>
        Array.from({ length: b.length + 1 }, () => 0),
      )
      const at = (i: number, j: number) => dp[i]![j]!
      for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
          dp[i]![j] =
            a[i - 1] === b[j - 1] ? at(i - 1, j - 1) + 1 : Math.max(at(i - 1, j), at(i, j - 1))
        }
      }
      return at(a.length, b.length)
    }

    for (let i = 0; i < 500; i++) {
      const oldLines = randomLines()
      const newLines = randomLines()
      const ops = diffLineArrays(oldLines, newLines)
      expect(ops.filter((op) => op.type !== "insert").map((op) => op.value)).toEqual(oldLines)
      expect(ops.filter((op) => op.type !== "delete").map((op) => op.value)).toEqual(newLines)
      expect(ops.filter((op) => op.type === "equal")).toHaveLength(lcsLength(oldLines, newLines))
    }
  })

  it("falls back to delete-all then insert-all past the edit limit, keeping the common ends", () => {
    const ops = diffLineArrays(["head", "a", "b", "tail"], ["head", "c", "d", "tail"], 2)
    expect(ops).toEqual([
      { type: "equal", value: "head" },
      { type: "delete", value: "a" },
      { type: "delete", value: "b" },
      { type: "insert", value: "c" },
      { type: "insert", value: "d" },
      { type: "equal", value: "tail" },
    ])
  })

  it("falls back on a large rewrite instead of searching without bound", () => {
    const oldLines = Array.from({ length: 20000 }, (_, i) => `old ${i}`)
    const newLines = Array.from({ length: 20000 }, (_, i) => `new ${i}`)
    const ops = diffLineArrays(oldLines, newLines)
    expect(ops).toHaveLength(40000)
    expect(ops[0]).toEqual({ type: "delete", value: "old 0" })
    expect(ops[20000]).toEqual({ type: "insert", value: "new 0" })
  })
})

describe("buildDiffSections", () => {
  const context = (n: number, oldFrom = 1, newFrom = oldFrom): DiffLine[] =>
    Array.from({ length: n }, (_, i) => ({
      type: "context",
      content: `c${oldFrom + i}`,
      oldLineNum: oldFrom + i,
      newLineNum: newFrom + i,
    }))
  const addition = (content: string, newLineNum: number): DiffLine => ({
    type: "addition",
    content,
    newLineNum,
  })

  const shape = (lines: DiffLine[]) =>
    buildDiffSections(lines, 3).map((s) =>
      s.type === "lines" ? `lines:${s.lines?.length}` : `${s.position}:${s.collapsedCount}`,
    )

  it("returns no sections for an empty diff", () => {
    expect(buildDiffSections([])).toEqual([])
  })

  it("collapses a diff with no changes into one top section", () => {
    expect(buildDiffSections(context(5))).toEqual([
      { type: "collapsed", collapsedCount: 5, startOldLine: 1, startNewLine: 1, position: "top" },
    ])
  })

  it("collapses the unchanged runs above and below a change", () => {
    const lines = [...context(10), addition("x", 11), ...context(10, 11, 12)]
    expect(shape(lines)).toEqual(["top:7", "lines:7", "bottom:7"])
    const [top, visible, bottom] = buildDiffSections(lines, 3)
    expect(top).toMatchObject({ startOldLine: 1, startNewLine: 1 })
    expect(visible?.lines?.[0]?.content).toBe("c8")
    expect(visible?.lines?.[6]?.content).toBe("c13")
    expect(bottom).toMatchObject({ startOldLine: 14, startNewLine: 15 })
  })

  it("adds no collapsed section when a change is within the context of either end", () => {
    expect(shape([addition("x", 1), ...context(3)])).toEqual(["lines:4"])
    expect(shape([...context(3), addition("x", 4)])).toEqual(["lines:4"])
  })

  it("merges changes separated by at most twice the context size", () => {
    expect(shape([addition("x", 1), ...context(6), addition("y", 8)])).toEqual(["lines:8"])
  })

  it("collapses the gap between changes separated by more than twice the context size", () => {
    const lines = [addition("x", 1), ...context(7), addition("y", 9)]
    expect(shape(lines)).toEqual(["lines:4", "middle:1", "lines:4"])
    expect(buildDiffSections(lines, 3)[1]).toMatchObject({ startOldLine: 4 })
  })
})

describe("getExpandedLines", () => {
  it("returns exactly the lines hidden behind each collapsed section", () => {
    const diffLines = generateUnifiedDiff({
      changeType: "modified",
      originalContent: Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n"),
      newContent: Array.from({ length: 30 }, (_, i) =>
        i === 9 || i === 24 ? `changed ${i + 1}` : `line ${i + 1}`,
      ).join("\n"),
    })!
    const sections = buildDiffSections(diffLines, 3)
    expect(sections.map((s) => s.type)).toEqual([
      "collapsed",
      "lines",
      "collapsed",
      "lines",
      "collapsed",
    ])

    // Expanding every collapsed section reproduces the full diff, in order.
    const expanded = sections.flatMap((s, i) =>
      s.type === "collapsed" ? getExpandedLines(diffLines, sections, i) : (s.lines ?? []),
    )
    expect(expanded).toEqual(diffLines)

    sections.forEach((s, i) => {
      if (s.type !== "collapsed") return
      const hidden = getExpandedLines(diffLines, sections, i)
      expect(hidden).toHaveLength(s.collapsedCount!)
      expect(hidden[0]!.oldLineNum).toBe(s.startOldLine)
      expect(hidden[0]!.newLineNum).toBe(s.startNewLine)
    })
  })
})
