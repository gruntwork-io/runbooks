/**
 * How the files a block names differ on disk from the text the session
 * holds (`FilesOnDisk`): a line diff of each file, in hunks with a few lines
 * of context, bounded by `LIMITS.maxDiffChars`. Pure: the watcher reads the
 * files, and the session decides when a block shows them.
 *
 * The line diff is Myers' algorithm, ported from the app's
 * `web/src/lib/unifiedDiff.ts`, with the same bound on the edits it
 * searches for.
 */
import { createHash } from "node:crypto"
import { Schema } from "effect"
import { RunbookPath } from "@runbooks/blocks-core/contract"
import { ContentHash } from "../document/document.ts"
import type { FileFact } from "../document/files.ts"
import { fileProblem } from "../document/parse.ts"
import {
  type DiffHunk,
  type DiffLine,
  type FileOnDisk,
  type FilesOnDisk,
  LIMITS,
} from "./protocol.ts"

/**
 * Most deleted plus inserted lines the line diff searches for. Myers'
 * algorithm takes O((N+M)·D) time and O(D²) memory for D edits, so an
 * unbounded search on a large rewrite would hold the engine. Past it, the
 * changed region is all deletions followed by all additions.
 */
const MAX_EDIT_LENGTH = 1000

/** Lines of context a hunk shows before and after a change. */
const CONTEXT_LINES = 3

const toPath = Schema.decodeSync(RunbookPath)
const toHash = Schema.decodeSync(ContentHash)

interface Op {
  readonly kind: DiffLine["kind"]
  readonly text: string
}

/**
 * A file's lines, as `readline` ends them: at `\n`, `\r\n` or a lone `\r`,
 * without the ending, the final one included. An empty text has none, so
 * texts that differ only in line endings or a final newline have the same.
 */
function linesOf(text: string): ReadonlyArray<string> {
  const lf = text.replace(/\r\n?/g, "\n")
  return lf === "" ? [] : lf.replace(/\n$/, "").split("\n")
}

/**
 * The hunks between `held`, the text the session holds, and `disk`: each
 * change with `CONTEXT_LINES` around it, changes no more than twice that
 * apart in one hunk. None when their lines are the same.
 */
export function diffHunks(
  held: string,
  disk: string,
  maxEditLength: number = MAX_EDIT_LENGTH,
): ReadonlyArray<DiffHunk> {
  const ops = diffLines(linesOf(held), linesOf(disk), maxEditLength)
  // Where each op is in each text, from 1.
  const heldAt: number[] = []
  const diskAt: number[] = []
  let heldLine = 1
  let diskLine = 1
  for (const op of ops) {
    heldAt.push(heldLine)
    diskAt.push(diskLine)
    if (op.kind !== "addition") heldLine++
    if (op.kind !== "deletion") diskLine++
  }
  // Each run of changes no more than twice the context apart, by its first and last op.
  const groups: Array<{ readonly first: number; last: number }> = []
  ops.forEach((op, index) => {
    if (op.kind === "context") return
    const group = groups.at(-1)
    if (group !== undefined && index - group.last <= 2 * CONTEXT_LINES + 1) group.last = index
    else groups.push({ first: index, last: index })
  })
  return groups.flatMap(({ first, last }) => {
    const from = Math.max(0, first - CONTEXT_LINES)
    const [line, ...rest] = ops.slice(from, last + CONTEXT_LINES + 1)
    return line === undefined
      ? []
      : [{ heldLine: heldAt[from] ?? 1, diskLine: diskAt[from] ?? 1, lines: [line, ...rest] }]
  })
}

/**
 * A minimal line diff (Myers). Within each changed region, deletions come
 * before additions. A region that needs more than `maxEditLength` edits is
 * all deletions, then all additions.
 */
function diffLines(
  held: ReadonlyArray<string>,
  disk: ReadonlyArray<string>,
  maxEditLength: number,
): ReadonlyArray<Op> {
  // The common prefix and suffix are always equal lines. Trimming them keeps
  // the search small for the usual localized edit to a large file.
  let start = 0
  while (start < held.length && start < disk.length && held[start] === disk[start]) start++
  let heldEnd = held.length
  let diskEnd = disk.length
  while (heldEnd > start && diskEnd > start && held[heldEnd - 1] === disk[diskEnd - 1]) {
    heldEnd--
    diskEnd--
  }
  const heldMiddle = held.slice(start, heldEnd)
  const diskMiddle = disk.slice(start, diskEnd)
  const middle = myers(heldMiddle, diskMiddle, maxEditLength) ?? [
    ...heldMiddle.map((text): Op => ({ kind: "deletion", text })),
    ...diskMiddle.map((text): Op => ({ kind: "addition", text })),
  ]
  return [
    ...held.slice(0, start).map((text): Op => ({ kind: "context", text })),
    ...middle,
    ...held.slice(heldEnd).map((text): Op => ({ kind: "context", text })),
  ]
}

/** Myers' O(ND) diff. Undefined if it needs more than `maxEditLength` edits. */
function myers(
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
  maxEditLength: number,
): ReadonlyArray<Op> | undefined {
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
      // Move down from diagonal k+1 (an addition) or right from k-1 (a
      // deletion), whichever got further, then follow any run of equal lines.
      const fromAbove = v[offset + k + 1] ?? 0
      const fromLeft = v[offset + k - 1] ?? 0
      let x = k === -d || (k !== d && fromLeft < fromAbove) ? fromAbove : fromLeft + 1
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

function backtrack(
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
  trace: ReadonlyArray<Int32Array>,
): ReadonlyArray<Op> {
  const ops: Op[] = []
  let x = a.length
  let y = b.length
  // The walk retraces the path `myers` found, so every diagonal it reads is
  // within trace[d] and x, y stay within a and b.
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d] ?? new Int32Array()
    const at = (k: number) => v[k + d + 1] ?? 0
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      x--
      y--
      ops.push({ kind: "context", text: a[x] ?? "" })
    }
    if (d > 0) {
      if (x === prevX) {
        y--
        ops.push({ kind: "addition", text: b[y] ?? "" })
      } else {
        x--
        ops.push({ kind: "deletion", text: a[x] ?? "" })
      }
    }
  }
  return ops.reverse()
}

/** Whether two facts about one path are the same: the same bytes, or the same reason they were not read. */
export function sameFact(a: FileFact | undefined, b: FileFact | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  if (a._tag === "Found" || b._tag === "Found")
    return a._tag === "Found" && b._tag === "Found" && a.hash === b.hash
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Whether two sets of facts name the same paths, each with the same fact. */
export const sameFiles = (
  a: ReadonlyMap<RunbookPath, FileFact>,
  b: ReadonlyMap<RunbookPath, FileFact>,
): boolean =>
  a.size === b.size && Array.from(a).every(([named, fact]) => sameFact(fact, b.get(named)))

/** Each file's text in what is at a path, by its path. None for a path with no file. */
const textsOf = (fact: FileFact | undefined): ReadonlyMap<string, string> =>
  new Map(fact?._tag === "Found" ? fact.texts.map(({ path, text }) => [path, text]) : [])

/** How `named` differs on disk (`disk`) from what the session holds there (`held`). */
function changesAt(
  named: RunbookPath,
  held: FileFact | undefined,
  disk: FileFact,
): ReadonlyArray<FileOnDisk> {
  switch (disk._tag) {
    case "Found":
    case "Missing": {
      const before = textsOf(held)
      const after = textsOf(disk)
      const paths = Array.from(new Set([...before.keys(), ...after.keys()])).sort()
      const changes = paths.flatMap((path): ReadonlyArray<FileOnDisk> => {
        const was = before.get(path)
        const now = after.get(path)
        if (was === now) return []
        return [
          {
            _tag: "Changed",
            path: toPath(path),
            change: was === undefined ? "created" : now === undefined ? "deleted" : "modified",
            hunks: diffHunks(was ?? "", now ?? ""),
          },
        ]
      })
      // The bytes differ but no file's text does: an executable bit in a folder it names.
      return changes.length === 0 && disk._tag === "Found"
        ? [{ _tag: "Changed", path: named, change: "modified", hunks: [] }]
        : changes
    }
    case "Outside":
    case "NotAFile":
    case "Unreadable":
    case "OverLimit":
      return [{ _tag: "Unreadable", path: named, reason: `${named}${fileProblem(named, disk)}` }]
  }
}

/**
 * `files`, less the lines and files past `LIMITS.maxDiffChars` as the
 * protocol counts them, and whether any were left out.
 */
function bounded(files: ReadonlyArray<FileOnDisk>): {
  readonly files: ReadonlyArray<FileOnDisk>
  readonly truncated: boolean
} {
  let left = LIMITS.maxDiffChars
  const kept: FileOnDisk[] = []
  for (const file of files) {
    const own = file.path.length + (file._tag === "Unreadable" ? file.reason.length : 0)
    if (own > left) return { files: kept, truncated: true }
    left -= own
    if (file._tag === "Unreadable") {
      kept.push(file)
      continue
    }
    const hunks: DiffHunk[] = []
    for (const hunk of file.hunks) {
      const lines: DiffLine[] = []
      for (const line of hunk.lines) {
        const cost = line.text.length + 1
        if (cost > left) {
          const [first, ...rest] = lines
          if (first !== undefined) hunks.push({ ...hunk, lines: [first, ...rest] })
          kept.push({ ...file, hunks })
          return { files: kept, truncated: true }
        }
        left -= cost
        lines.push(line)
      }
      hunks.push(hunk)
    }
    kept.push(file)
  }
  return { files: kept, truncated: false }
}

/**
 * What a block that names `paths` shows of its files on disk: each that
 * differs from what the session holds (`held`), as the watcher last read it
 * (`disk`). None while every path is as held. Its hash is over what is on
 * disk at each path, so it changes exactly when one of them does.
 */
export function filesOnDiskOf(
  paths: ReadonlyArray<RunbookPath>,
  held: ReadonlyMap<RunbookPath, FileFact>,
  disk: ReadonlyMap<RunbookPath, FileFact>,
): FilesOnDisk | undefined {
  const changes = paths.flatMap((path) => {
    const now = disk.get(path)
    const was = held.get(path)
    return now === undefined || sameFact(was, now) ? [] : changesAt(path, was, now)
  })
  const sorted = [...changes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const { files, truncated } = bounded(sorted)
  const [first, ...rest] = files
  // Only a path longer than `maxDiffChars`, which no file system allows, leaves none.
  if (first === undefined) return undefined
  const onDisk = paths.map((path) => {
    const fact = disk.get(path) ?? held.get(path)
    return [path, fact?._tag === "Found" ? fact.hash : (fact ?? null)]
  })
  return {
    hash: toHash(`sha256:${createHash("sha256").update(JSON.stringify(onDisk)).digest("hex")}`),
    files: [first, ...rest],
    ...(truncated ? { truncated: true as const } : {}),
  }
}
