/**
 * Which generated files changed since the user last reviewed them, and which
 * of their lines. The Files workspace highlights them until the user moves on
 * from a file, scrolls past its changes or dismisses it; GeneratedFilesContext
 * keeps what was reviewed.
 * Pure functions, so they can be tested without rendering.
 */

import type { File, FileTreeNode } from "@/components/artifacts/code/FileTree"
import { diffDiskContents } from "@/lib/unifiedDiff"

/**
 * What the user last reviewed of each generated file, by path: its content
 * then, or null when it has changed since but what it was is not known (the
 * session's history could not keep it). A file with no entry is one the user
 * has not reviewed at all, so all of it is new to them.
 */
export type ReviewedFiles = ReadonlyMap<string, string | null>

/** How a generated file changed since the user last reviewed it. */
export interface FileChange {
  status: "added" | "modified"
  /** The lines of the file now (1-based) that were added or changed */
  changedLines: ReadonlySet<number>
  /**
   * The lines (1-based) that removed lines stood right before. One past the
   * last line when they ended the file. A removal right before changed lines
   * isn't listed: those lines show the change.
   */
  removedBefore: ReadonlySet<number>
  additions: number
  deletions: number
  /** The first line the change touches, or undefined to show the file from its top */
  firstLine: number | undefined
  /** The last line the change touches, or undefined when it is all of the file */
  lastLine: number | undefined
}

const ADDED: FileChange = {
  status: "added",
  changedLines: new Set(),
  removedBefore: new Set(),
  additions: 0,
  deletions: 0,
  firstLine: undefined,
  lastLine: undefined,
}

/** A modified file whose earlier content is not known, so neither are its lines. */
const MODIFIED_LINES_UNKNOWN: FileChange = { ...ADDED, status: "modified" }

/** The files of a generated file tree, by path (their node id). */
export function filesByPath(tree: readonly FileTreeNode[] | null): Map<string, File> {
  const files = new Map<string, File>()
  const visit = (nodes: readonly FileTreeNode[]) => {
    for (const node of nodes) {
      if (node.type === "file" && node.file) files.set(node.id, node.file)
      if (node.children) visit(node.children)
    }
  }
  visit(tree ?? [])
  return files
}

/**
 * What reviewing `file` now records: its content. A file too large to show
 * has none, so a review of it is "" and its later changes go unnoticed.
 */
export function reviewedContent(file: File): string {
  return file.isTruncated ? "" : file.content
}

/** Every file reviewed as it is now. */
export function reviewAll(files: ReadonlyMap<string, File>): Map<string, string | null> {
  return new Map([...files].map(([path, file]) => [path, reviewedContent(file)]))
}

/** The changes of the files that changed since the user reviewed them, by path. */
export function fileChanges(
  files: ReadonlyMap<string, File>,
  reviewed: ReviewedFiles,
): Map<string, FileChange> {
  const changes = new Map<string, FileChange>()
  for (const [path, file] of files) {
    const before = reviewed.get(path)
    if (before === undefined) {
      changes.set(path, ADDED)
    } else if (file.isTruncated || before === file.content) {
      continue
    } else if (before === null) {
      changes.set(path, MODIFIED_LINES_UNKNOWN)
    } else {
      const change = lineChanges(before, file.content)
      // A change of line endings alone, or of the final newline, has no lines to show.
      if (change.additions > 0 || change.deletions > 0) changes.set(path, change)
    }
  }
  return changes
}

/** The lines of `after` that differ from `before`. */
export function lineChanges(before: string, after: string): FileChange {
  const changedLines = new Set<number>()
  const removedBefore = new Set<number>()
  let deletions = 0
  let removing = false
  let nextLine = 1

  for (const row of diffDiskContents(before, after)) {
    if (row.type === "deletion") {
      deletions++
      removing = true
      continue
    }
    // Context and addition rows are lines of `after`, so they have a number there.
    const line = row.newLineNum!
    if (row.type === "addition") changedLines.add(line)
    else if (removing) removedBefore.add(line)
    removing = false
    nextLine = line + 1
  }
  if (removing) removedBefore.add(nextLine)

  const touched = [...changedLines, ...removedBefore]
  return {
    status: "modified",
    changedLines,
    removedBefore,
    additions: changedLines.size,
    deletions,
    firstLine: touched.length > 0 ? Math.min(...touched) : undefined,
    lastLine: touched.length > 0 ? Math.max(...touched) : undefined,
  }
}

/** Whether two changes highlight the same lines in the same way. */
export function sameChange(a: FileChange | undefined, b: FileChange | undefined): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  return (
    a.status === b.status &&
    a.additions === b.additions &&
    a.deletions === b.deletions &&
    sameSet(a.changedLines, b.changedLines) &&
    sameSet(a.removedBefore, b.removedBefore)
  )
}

function sameSet(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  return a.size === b.size && [...a].every((value) => b.has(value))
}

/** A scroll of the pane that shows the files, by its scrollTop. */
export interface FilesScroll {
  from: number
  to: number
}

/**
 * The files a scroll down went past: those whose end crossed the top of the
 * pane. `ends` is where each changed file ends, in the pane's scroll
 * coordinates: at its last change, or at the end of the file when the change
 * is all of it.
 */
export function scrolledPast(
  ends: ReadonlyMap<string, number>,
  { from, to }: FilesScroll,
): string[] {
  return [...ends].filter(([, end]) => end > from && end <= to).map(([path]) => path)
}

/**
 * The folders (by node id) that hold a changed file at any depth, so a
 * collapsed folder still shows that something in it changed.
 */
export function foldersWithChanges(
  tree: readonly FileTreeNode[],
  changes: ReadonlyMap<string, FileChange>,
): Set<string> {
  const folders = new Set<string>()
  const visit = (node: FileTreeNode): boolean => {
    if (node.type === "file") return changes.has(node.id)
    let changed = false
    for (const child of node.children ?? []) {
      if (visit(child)) changed = true
    }
    if (changed) folders.add(node.id)
    return changed
  }
  for (const node of tree) visit(node)
  return folders
}

// ---------------------------------------------------------------------------
// The generated files and what the user reviewed of them
// ---------------------------------------------------------------------------

export interface FileReviewState {
  fileTree: FileTreeNode[] | null
  reviewed: ReviewedFiles
  /**
   * The file the user selected. It stays highlighted while it is selected,
   * and counts as reviewed as it is when they select another, including
   * whatever changed in it while they had it open.
   */
  selectedPath: string | null
}

export type FileReviewAction =
  /** New files. `reviewed`, when given, replaces what the user reviewed (a resumed session's files). */
  | { type: "tree"; fileTree: FileTreeNode[] | null; reviewed?: ReviewedFiles | undefined }
  /** The user selected a file: the one selected before it counts as reviewed. */
  | { type: "select"; path: string }
  | { type: "dismiss"; paths: readonly string[] }
  | { type: "dismiss-all" }

export const initialFileReviewState: FileReviewState = {
  fileTree: null,
  reviewed: new Map(),
  selectedPath: null,
}

export function fileReviewReducer(
  state: FileReviewState,
  action: FileReviewAction,
): FileReviewState {
  switch (action.type) {
    case "tree": {
      if (action.fileTree === null) return initialFileReviewState
      const files = filesByPath(action.fileTree)
      if (action.reviewed) {
        return { fileTree: action.fileTree, reviewed: action.reviewed, selectedPath: null }
      }
      const { reviewed, selectedPath } = state
      return {
        fileTree: action.fileTree,
        // A file that is gone is new again if it comes back.
        reviewed: [...reviewed.keys()].every((path) => files.has(path))
          ? reviewed
          : new Map([...reviewed].filter(([path]) => files.has(path))),
        selectedPath: selectedPath !== null && files.has(selectedPath) ? selectedPath : null,
      }
    }
    case "select": {
      const files = filesByPath(state.fileTree)
      if (!files.has(action.path)) return state
      const { reviewed, selectedPath } = state
      const left = selectedPath === action.path ? undefined : selectedPath
      const leftFile = left === null || left === undefined ? undefined : files.get(left)
      return {
        ...state,
        // The file the user leaves, as it is now: they saw it change.
        reviewed:
          left && leftFile ? new Map(reviewed).set(left, reviewedContent(leftFile)) : reviewed,
        selectedPath: action.path,
      }
    }
    case "dismiss": {
      const files = filesByPath(state.fileTree)
      const dismissed = action.paths.filter((path) => files.has(path))
      if (dismissed.length === 0) return state
      const reviewed = new Map(state.reviewed)
      for (const path of dismissed) reviewed.set(path, reviewedContent(files.get(path)!))
      return { ...state, reviewed }
    }
    case "dismiss-all":
      return { ...state, reviewed: reviewAll(filesByPath(state.fileTree)) }
  }
}
