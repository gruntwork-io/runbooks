/**
 * Line diff and unified-diff layout for the Changed files view
 * (ChangedFilesView). Pure functions, so the diff rows and the collapsed
 * context sections can be tested without rendering.
 */

import type { WorkspaceFileChange } from '@/hooks/useGitFileChanges'

export interface DiffLine {
  type: 'context' | 'addition' | 'deletion'
  content: string
  oldLineNum?: number
  newLineNum?: number
}

export interface DiffSection {
  type: 'lines' | 'collapsed'
  lines?: DiffLine[]
  collapsedCount?: number
  startOldLine?: number
  startNewLine?: number
  position?: 'top' | 'middle' | 'bottom' // For collapsed sections
}

export interface DiffOp {
  type: 'equal' | 'delete' | 'insert'
  value: string
}

/**
 * Most deleted plus inserted lines the line diff searches for. Myers' algorithm
 * takes O((N+M)·D) time and O(D²) memory for D edits, and "Load diff" passes
 * files of any size, so an unbounded search on a large rewrite would freeze
 * the renderer. Past the cap the changed region renders as all deletions
 * followed by all insertions.
 */
export const MAX_EDIT_LENGTH = 1000

/**
 * Split file content into lines. An empty string is zero lines, not one blank
 * line. One trailing newline is dropped: originalContent is rebuilt from the
 * lines of `git show`, which loses the final newline, while newContent is read
 * from disk and keeps it.
 */
export function toLines(content: string): string[] {
  return content === '' ? [] : content.replace(/\n$/, '').split('\n')
}

/**
 * Build the unified diff rows for a changed file. Returns undefined when a side
 * the change type needs is missing (git could not provide it), so the view can
 * say the diff is unavailable instead of rendering an empty body. An empty side
 * is real content: a modified file that was empty in HEAD renders as all
 * additions.
 */
export function generateUnifiedDiff(
  change: Pick<WorkspaceFileChange, 'changeType' | 'originalContent' | 'newContent'>,
): DiffLine[] | undefined {
  const { changeType, originalContent, newContent } = change

  if (changeType === 'added') {
    if (newContent === undefined) return undefined
    return toLines(newContent).map((content, i) => ({
      type: 'addition',
      content,
      newLineNum: i + 1,
    }))
  }

  if (changeType === 'deleted') {
    if (originalContent === undefined) return undefined
    return toLines(originalContent).map((content, i) => ({
      type: 'deletion',
      content,
      oldLineNum: i + 1,
    }))
  }

  if (originalContent === undefined || newContent === undefined) return undefined

  const lines: DiffLine[] = []
  let oldLineNum = 1
  let newLineNum = 1

  for (const op of diffLineArrays(toLines(originalContent), toLines(newContent))) {
    if (op.type === 'equal') {
      lines.push({
        type: 'context',
        content: op.value,
        oldLineNum: oldLineNum++,
        newLineNum: newLineNum++,
      })
    } else if (op.type === 'delete') {
      lines.push({
        type: 'deletion',
        content: op.value,
        oldLineNum: oldLineNum++,
      })
    } else {
      lines.push({
        type: 'addition',
        content: op.value,
        newLineNum: newLineNum++,
      })
    }
  }

  return lines
}

/**
 * Minimal line diff (Myers). Within each changed region, deletions come before
 * insertions. If the region needs more than `maxEditLength` edits it falls
 * back to deleting every old line and inserting every new one.
 */
export function diffLineArrays(
  oldLines: string[],
  newLines: string[],
  maxEditLength: number = MAX_EDIT_LENGTH,
): DiffOp[] {
  // The common prefix and suffix are always equal lines. Trimming them keeps
  // the search small for the usual localized edit to a large file.
  let start = 0
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start++
  }
  let oldEnd = oldLines.length
  let newEnd = newLines.length
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--
    newEnd--
  }

  const oldMiddle = oldLines.slice(start, oldEnd)
  const newMiddle = newLines.slice(start, newEnd)
  const middle = myersDiff(oldMiddle, newMiddle, maxEditLength) ?? [
    ...oldMiddle.map((value): DiffOp => ({ type: 'delete', value })),
    ...newMiddle.map((value): DiffOp => ({ type: 'insert', value })),
  ]

  return [
    ...oldLines.slice(0, start).map((value): DiffOp => ({ type: 'equal', value })),
    ...middle,
    ...oldLines.slice(oldEnd).map((value): DiffOp => ({ type: 'equal', value })),
  ]
}

/** Myers' O(ND) diff. Returns undefined if it needs more than `maxEditLength` edits. */
function myersDiff(a: string[], b: string[], maxEditLength: number): DiffOp[] | undefined {
  const n = a.length
  const m = b.length
  const max = Math.min(n + m, maxEditLength)
  // v[offset + k] is the furthest x reached on diagonal k (where y = x - k).
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  // trace[d] is v for diagonals -d-1..d+1 as it stood before step d: all the
  // backtrack needs to recover the edit taken at step d.
  const trace: Int32Array[] = []

  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      // Move down from diagonal k+1 (an insertion) or right from k-1 (a
      // deletion), whichever got further, then follow any run of equal lines.
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
        ? v[offset + k + 1]
        : v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) return backtrack(a, b, trace)
    }
  }

  return undefined
}

function backtrack(a: string[], b: string[], trace: Int32Array[]): DiffOp[] {
  const ops: DiffOp[] = []
  let x = a.length
  let y = b.length

  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d]
    const at = (k: number) => v[k + d + 1]
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK

    while (x > prevX && y > prevY) {
      x--
      y--
      ops.push({ type: 'equal', value: a[x] })
    }
    if (d > 0) {
      if (x === prevX) {
        y--
        ops.push({ type: 'insert', value: b[y] })
      } else {
        x--
        ops.push({ type: 'delete', value: a[x] })
      }
    }
  }

  return ops.reverse()
}

/**
 * Group diff lines into visible sections (each change with `contextSize` lines
 * around it) and collapsed sections for the unchanged runs between them.
 * Changes separated by at most 2 * contextSize unchanged lines share a section.
 */
export function buildDiffSections(diffLines: DiffLine[], contextSize: number = 3): DiffSection[] {
  const result: DiffSection[] = []

  // Find all change indices
  const changeIndices: number[] = []
  diffLines.forEach((line, i) => {
    if (line.type !== 'context') {
      changeIndices.push(i)
    }
  })

  if (changeIndices.length === 0) {
    // No changes - collapse entire file (reaches both beginning and end)
    if (diffLines.length > 0) {
      result.push({
        type: 'collapsed',
        collapsedCount: diffLines.length,
        startOldLine: diffLines[0].oldLineNum,
        startNewLine: diffLines[0].newLineNum,
        position: 'top', // Starts at beginning, use ArrowUpToLine
      })
    }
    return result
  }

  let currentPos = 0

  for (let i = 0; i < changeIndices.length; i++) {
    const changeStart = changeIndices[i]

    // Find the end of this change block (consecutive changes)
    let changeEnd = changeStart
    while (i + 1 < changeIndices.length && changeIndices[i + 1] <= changeEnd + contextSize * 2 + 1) {
      i++
      changeEnd = changeIndices[i]
    }

    const contextStart = Math.max(currentPos, changeStart - contextSize)
    const contextEnd = Math.min(diffLines.length - 1, changeEnd + contextSize)

    // Add collapsed section before this change (if there's a gap)
    if (contextStart > currentPos) {
      const collapsedLines = diffLines.slice(currentPos, contextStart)
      if (collapsedLines.length > 0) {
        // Determine position based on whether it reaches beginning of file
        const startsAtBeginning = currentPos === 0

        result.push({
          type: 'collapsed',
          collapsedCount: collapsedLines.length,
          startOldLine: collapsedLines[0].oldLineNum,
          startNewLine: collapsedLines[0].newLineNum,
          position: startsAtBeginning ? 'top' : 'middle',
        })
      }
    }

    // Add the visible lines (context + changes)
    result.push({
      type: 'lines',
      lines: diffLines.slice(contextStart, contextEnd + 1),
    })

    currentPos = contextEnd + 1
  }

  // Add trailing collapsed section if needed
  if (currentPos < diffLines.length) {
    const collapsedLines = diffLines.slice(currentPos)
    // This section reaches the end of the file
    result.push({
      type: 'collapsed',
      collapsedCount: collapsedLines.length,
      startOldLine: collapsedLines[0].oldLineNum,
      startNewLine: collapsedLines[0].newLineNum,
      position: 'bottom',
    })
  }

  return result
}

/** The diff lines hidden behind collapsed section `sectionIndex`. */
export function getExpandedLines(
  diffLines: DiffLine[],
  sections: DiffSection[],
  sectionIndex: number,
): DiffLine[] {
  // Find the section boundaries in diffLines
  let lineStart = 0
  for (let i = 0; i < sectionIndex; i++) {
    const section = sections[i]
    if (section.type === 'lines') {
      lineStart += section.lines?.length || 0
    } else {
      lineStart += section.collapsedCount || 0
    }
  }
  const section = sections[sectionIndex]
  return diffLines.slice(lineStart, lineStart + (section.collapsedCount || 0))
}
