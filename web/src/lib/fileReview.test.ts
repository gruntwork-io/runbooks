import { describe, it, expect } from "vitest"
import type { FileTreeNode } from "@/components/artifacts/code/FileTree"
import {
  fileChanges,
  fileReviewReducer,
  filesByPath,
  foldersWithChanges,
  initialFileReviewState,
  lineChanges,
  scrolledPast,
  type FileReviewAction,
  type FileReviewState,
} from "./fileReview"

const file = (path: string, content: string, isTruncated = false): FileTreeNode => {
  const name = path.split("/").pop()!
  return {
    id: path,
    name,
    type: "file",
    children: [],
    file: { name, path, content, language: "hcl", size: content.length, isTruncated },
  }
}

const folder = (path: string, children: FileTreeNode[]): FileTreeNode => ({
  id: path,
  name: path.split("/").pop()!,
  type: "folder",
  children,
})

/** The status of each changed file, by path. */
const statuses = (tree: FileTreeNode[], reviewed: ReadonlyMap<string, string | null>) =>
  Object.fromEntries(
    [...fileChanges(filesByPath(tree), reviewed)].map(([path, change]) => [path, change.status]),
  )

const run = (...actions: FileReviewAction[]): FileReviewState =>
  actions.reduce(fileReviewReducer, initialFileReviewState)

/** The changes the state highlights: each changed file's status and changed lines. */
const highlighted = (state: FileReviewState) =>
  Object.fromEntries(
    [...fileChanges(filesByPath(state.fileTree), state.reviewed)].map(([path, change]) => [
      path,
      `${change.status} ${[...change.changedLines].join(",")}`.trim(),
    ]),
  )

describe("lineChanges", () => {
  it("lists the changed lines of the file now, and starts at the first", () => {
    const change = lineChanges("a\nb\nc\nd\n", "a\nB\nc\nD\ne\n")
    expect([...change.changedLines]).toEqual([2, 4, 5])
    expect(change.removedBefore.size).toBe(0)
    expect(change).toMatchObject({ additions: 3, deletions: 2, firstLine: 2, lastLine: 5 })
  })

  it("marks where lines were removed when nothing took their place", () => {
    const change = lineChanges("a\nb\nc\nd\n", "a\nd\n")
    expect(change.changedLines.size).toBe(0)
    expect([...change.removedBefore]).toEqual([2])
    expect(change).toMatchObject({ additions: 0, deletions: 2, firstLine: 2 })
  })

  it("marks one past the last line when the end of the file was removed", () => {
    const change = lineChanges("a\nb\nc", "a\nb")
    expect([...change.removedBefore]).toEqual([3])
    expect(change.firstLine).toBe(3)
  })

  it("does not mark a removal that changed lines took the place of", () => {
    const change = lineChanges("a\nb\nc\n", "a\nX\n")
    expect([...change.changedLines]).toEqual([2])
    expect(change.removedBefore.size).toBe(0)
    expect(change).toMatchObject({ additions: 1, deletions: 2 })
  })
})

describe("fileChanges", () => {
  const tree = [file("main.tf", "a\nb\n"), file("vars.tf", "x\n")]

  it("calls a file the user never reviewed added", () => {
    expect(statuses(tree, new Map([["vars.tf", "x\n"]]))).toEqual({ "main.tf": "added" })
  })

  it("calls a file whose content differs from the reviewed one modified", () => {
    expect(
      statuses(
        tree,
        new Map([
          ["main.tf", "a\n"],
          ["vars.tf", "x\n"],
        ]),
      ),
    ).toEqual({ "main.tf": "modified" })
  })

  it("calls a file modified without its lines when what the user reviewed is not known", () => {
    const changes = fileChanges(
      filesByPath(tree),
      new Map([
        ["main.tf", null],
        ["vars.tf", "x\n"],
      ]),
    )
    expect(changes.get("main.tf")).toMatchObject({ status: "modified", firstLine: undefined })
    expect(changes.get("main.tf")!.changedLines.size).toBe(0)
  })

  it("ignores a change of line endings or of the final newline", () => {
    expect(
      statuses(
        tree,
        new Map([
          ["main.tf", "a\r\nb"],
          ["vars.tf", "x\n"],
        ]),
      ),
    ).toEqual({})
  })

  it("can't tell a file too large to show changed, but tells it added", () => {
    const large = [file("big.bin", "", true)]
    expect(statuses(large, new Map([["big.bin", ""]]))).toEqual({})
    expect(statuses(large, new Map())).toEqual({ "big.bin": "added" })
  })
})

describe("scrolledPast", () => {
  const ends = new Map([
    ["a.tf", 100],
    ["b.tf", 300],
    ["c.tf", 500],
  ])
  const scroll = (from: number, to: number) => scrolledPast(ends, { from, to })

  it("lists the files whose end crossed the top of the pane", () => {
    expect(scroll(0, 99)).toEqual([])
    expect(scroll(99, 300)).toEqual(["a.tf", "b.tf"])
  })

  it("leaves out files that were already past, and lists none for a scroll up", () => {
    expect(scroll(100, 200)).toEqual([])
    expect(scroll(400, 0)).toEqual([])
  })
})

describe("foldersWithChanges", () => {
  it("lists every folder that holds a changed file, at any depth", () => {
    const tree = [
      folder("infra", [folder("infra/vpc", [file("infra/vpc/main.tf", "a\n")])]),
      folder("docs", [file("docs/README.md", "r\n")]),
    ]
    const changes = fileChanges(filesByPath(tree), new Map([["docs/README.md", "r\n"]]))
    expect([...foldersWithChanges(tree, changes)].sort()).toEqual(["infra", "infra/vpc"])
  })
})

describe("fileReviewReducer", () => {
  const v1 = [file("main.tf", "a\nb\n"), file("vars.tf", "x\n")]
  const v2 = [file("main.tf", "a\nB\n"), file("vars.tf", "X\n")]
  const v3 = [file("main.tf", "a\nB\nc\n"), file("vars.tf", "X\n")]

  it("highlights every file of the first tree as added", () => {
    expect(highlighted(run({ type: "tree", fileTree: v1 }))).toEqual({
      "main.tf": "added",
      "vars.tf": "added",
    })
  })

  it("highlights the lines changed since a file was dismissed", () => {
    const state = run(
      { type: "tree", fileTree: v1 },
      { type: "dismiss-all" },
      { type: "tree", fileTree: v2 },
    )
    expect(highlighted(state)).toEqual({ "main.tf": "modified 2", "vars.tf": "modified 1" })
  })

  it("keeps highlighting the selected file until another file is selected", () => {
    const selected = run(
      { type: "tree", fileTree: v1 },
      { type: "dismiss-all" },
      { type: "tree", fileTree: v2 },
      { type: "select", path: "main.tf" },
    )
    expect(highlighted(selected)).toEqual({ "main.tf": "modified 2", "vars.tf": "modified 1" })

    const next = fileReviewReducer(selected, { type: "select", path: "vars.tf" })
    expect(next.selectedPath).toBe("vars.tf")
    expect(highlighted(next)).toEqual({ "vars.tf": "modified 1" })
  })

  it("shows live edits of the selected file, and reviews them once another file is selected", () => {
    const selected = run(
      { type: "tree", fileTree: v1 },
      { type: "dismiss-all" },
      { type: "tree", fileTree: v2 },
      { type: "select", path: "main.tf" },
      { type: "tree", fileTree: v3 },
    )
    // Every change since the review, including the one made while selected
    expect(highlighted(selected)).toEqual({ "main.tf": "modified 2,3", "vars.tf": "modified 1" })

    const next = fileReviewReducer(selected, { type: "select", path: "vars.tf" })
    expect(highlighted(next)).toEqual({ "vars.tf": "modified 1" })
  })

  it("reviews a file once it is dismissed, selected or not", () => {
    const state = run(
      { type: "tree", fileTree: v1 },
      { type: "dismiss-all" },
      { type: "tree", fileTree: v2 },
      { type: "select", path: "main.tf" },
      { type: "dismiss", paths: ["main.tf"] },
      { type: "dismiss", paths: ["vars.tf", "gone.tf"] },
    )
    expect(state.selectedPath).toBe("main.tf")
    expect(highlighted(state)).toEqual({})
  })

  it("forgets a file that is gone, so it is added again if it comes back", () => {
    const state = run(
      { type: "tree", fileTree: v1 },
      { type: "dismiss-all" },
      { type: "select", path: "vars.tf" },
      { type: "tree", fileTree: [file("main.tf", "a\nb\n")] },
    )
    expect(state.selectedPath).toBeNull()
    const back = fileReviewReducer(state, { type: "tree", fileTree: v1 })
    expect(highlighted(back)).toEqual({ "vars.tf": "added" })
  })

  it("replaces what was reviewed with a resumed session's, and forgets everything on a clear", () => {
    const resumed = run(
      { type: "tree", fileTree: v1 },
      { type: "select", path: "main.tf" },
      { type: "tree", fileTree: v2, reviewed: new Map([["main.tf", "a\nb\n"]]) },
    )
    expect(resumed.selectedPath).toBeNull()
    expect(highlighted(resumed)).toEqual({ "main.tf": "modified 2", "vars.tf": "added" })

    expect(fileReviewReducer(resumed, { type: "tree", fileTree: null })).toBe(
      initialFileReviewState,
    )
  })

  it("ignores a file that is not in the tree", () => {
    const state = run({ type: "tree", fileTree: v1 })
    expect(fileReviewReducer(state, { type: "select", path: "gone.tf" })).toBe(state)
    expect(fileReviewReducer(state, { type: "dismiss", paths: ["gone.tf"] })).toBe(state)
  })
})
