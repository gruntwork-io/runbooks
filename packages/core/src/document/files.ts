/**
 * The files a runbook's blocks name: whether each is inside the runbook's
 * folder, its hash, and its text, for the template references in it and for
 * a run. Each file is read once: its hash and its text come from the same
 * bytes, so a run gets what the person trusted.
 */
import { createHash } from "node:crypto"
import path from "node:path"
import { Effect, Option, Schema } from "effect"
import type { RunbookPath } from "@runbooks/blocks-core/contract"
import { isContainedIn } from "../path-validation.ts"
import { type FileStat, FileSystem } from "../services/FileSystem.ts"
import { ContentHash } from "./document.ts"

/** One file's text, by its path relative to the runbook's folder. */
export interface FileText {
  readonly path: string
  readonly text: string
}

/**
 * What is at one path a block names. Each `path` in it is relative to the
 * runbook's folder, as `FileText.path` is.
 */
export type FileFact =
  | {
      readonly _tag: "Found"
      /**
       * A file's: its bytes. A folder's: each file's path in it, executable
       * bit and bytes, so a change to any of them changes the hash. Each is
       * tagged with its kind, so a file never hashes as a folder does.
       */
      readonly hash: ContentHash
      /** The file, or each file in the folder: the text of the bytes hashed. */
      readonly texts: ReadonlyArray<FileText>
    }
  | { readonly _tag: "Missing" }
  /** Outside the runbook's folder, written so or through a symbolic link. */
  | { readonly _tag: "Outside" }
  /**
   * Neither a file nor a folder: a symbolic link in the folder, a named
   * pipe, a socket, a device. It is not read.
   */
  | { readonly _tag: "NotAFile"; readonly path: string }
  /** A file or folder that can't be read. */
  | { readonly _tag: "Unreadable"; readonly path: string }
  /**
   * Over one of `RUNBOOK_FILE_LIMITS`, at `path`: the file or the folder too
   * deep, or the folder named, for its file count or total bytes. Nothing
   * of it is kept.
   */
  | { readonly _tag: "OverLimit"; readonly limit: RunbookFileLimit; readonly path: string }

/**
 * The most a path a block names may hold. A runbook is its author's, so a
 * path over a limit is refused, never cut short: the hash covers all a run
 * gets.
 */
export const RUNBOOK_FILE_LIMITS = {
  /** Bytes in one file. */
  fileBytes: 1024 * 1024,
  /** Bytes in all of one folder's files. */
  folderBytes: 8 * 1024 * 1024,
  /** Files and folders in one folder, at any depth. */
  entries: 2000,
  /** Folders inside the one named, one in another. */
  depth: 16,
} as const

export type RunbookFileLimit = keyof typeof RUNBOOK_FILE_LIMITS

/** Version control folders: neither hashed nor given to a run. */
const VCS_DIRS: ReadonlySet<string> = new Set([".git", ".svn", ".hg"])

const toHash = Schema.decodeSync(ContentHash)
const MISSING: FileFact = { _tag: "Missing" }
const OUTSIDE: FileFact = { _tag: "Outside" }
const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** What is at `file`, a path relative to `folder`, the runbook's folder. */
export const readRunbookFile = (
  folder: string,
  file: RunbookPath,
): Effect.Effect<FileFact, never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const resolved = path.resolve(folder, file)
    if (!isContainedIn(resolved, folder)) return OUTSIDE
    const stat = yield* fs.stat(resolved).pipe(Effect.option)
    if (Option.isNone(stat)) return MISSING
    const real = yield* fs.realpath(resolved).pipe(Effect.option)
    const realFolder = yield* fs.realpath(folder).pipe(Effect.option)
    if (Option.isNone(realFolder)) return MISSING
    // It exists: macOS resolves no path to a file its user can't read.
    if (Option.isNone(real)) return { _tag: "Unreadable", path: file }
    if (!isContainedIn(real.value, realFolder.value)) return OUTSIDE

    if (stat.value.isDirectory) return yield* readFolder(real.value, file)
    if (!stat.value.isFile) return { _tag: "NotAFile", path: file }
    const read = yield* readBytes(real.value, file, stat.value)
    if (read._tag !== "Read") return read.fact
    return {
      _tag: "Found",
      hash: fileHash(read.bytes),
      texts: [{ path: file, text: textOf(read.bytes) }],
    }
  })

/** A file's bytes, or why they weren't read: it is over the limit, or can't be read. */
type ReadBytes =
  | { readonly _tag: "Read"; readonly bytes: Uint8Array }
  | {
      readonly _tag: "NotRead"
      readonly fact: Extract<FileFact, { readonly _tag: "OverLimit" | "Unreadable" }>
    }

/** The bytes of the regular file at `at`, shown as `shown`, read whole once. */
const readBytes = (
  at: string,
  shown: string,
  stat: FileStat,
): Effect.Effect<ReadBytes, never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const over: ReadBytes = {
      _tag: "NotRead",
      fact: { _tag: "OverLimit", limit: "fileBytes", path: shown },
    }
    if (stat.size > RUNBOOK_FILE_LIMITS.fileBytes) return over
    const read = yield* fs.readFileBuffer(at).pipe(Effect.result)
    if (read._tag === "Failure")
      return { _tag: "NotRead", fact: { _tag: "Unreadable", path: shown } }
    // It may have grown since `stat`.
    if (read.success.length > RUNBOOK_FILE_LIMITS.fileBytes) return over
    return { _tag: "Read", bytes: read.success }
  })

/** Why a path inside the runbook's folder can't be taken whole. */
type Refusal = Extract<FileFact, { readonly _tag: "NotAFile" | "Unreadable" | "OverLimit" }>

/** One file a folder holds, as read. */
interface FolderFile {
  /** Relative to the folder, with `/` between names. */
  readonly path: string
  readonly executable: boolean
  readonly bytes: Uint8Array
}

/**
 * The folder at `real`, which the block names as `named`: each file in it,
 * hashed and kept, or the first reason it can't be taken whole. A symbolic
 * link in it is not followed, and nothing is read past a limit.
 */
const readFolder = (real: string, named: RunbookPath): Effect.Effect<FileFact, never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const files: FolderFile[] = []
    let entries = 0
    let bytes = 0
    const shown = (relative: string) => (relative === "" ? named : path.posix.join(named, relative))

    /** Reads the folder at `relative`, `depth` below the named one, into `files`: a problem stops it. */
    const walk = (
      relative: string,
      depth: number,
    ): Effect.Effect<Refusal | undefined, never, FileSystem> =>
      Effect.gen(function* () {
        const listed = yield* fs.readdirWithTypes(path.join(real, relative)).pipe(Effect.option)
        if (Option.isNone(listed)) return { _tag: "Unreadable", path: shown(relative) }
        for (const entry of [...listed.value].sort(byName)) {
          if (VCS_DIRS.has(entry.name)) continue
          const child = relative === "" ? entry.name : `${relative}/${entry.name}`
          entries += 1
          if (entries > RUNBOOK_FILE_LIMITS.entries) {
            return { _tag: "OverLimit", limit: "entries", path: named }
          }
          if (entry.isDirectory) {
            if (depth + 1 > RUNBOOK_FILE_LIMITS.depth) {
              return { _tag: "OverLimit", limit: "depth", path: shown(child) }
            }
            const problem = yield* walk(child, depth + 1)
            if (problem !== undefined) return problem
            continue
          }
          if (!entry.isFile) return { _tag: "NotAFile", path: shown(child) }
          const at = path.join(real, child)
          const stat = yield* fs.stat(at).pipe(Effect.option)
          if (Option.isNone(stat)) return { _tag: "Unreadable", path: shown(child) }
          const overFolder: Refusal = { _tag: "OverLimit", limit: "folderBytes", path: named }
          if (bytes + stat.value.size > RUNBOOK_FILE_LIMITS.folderBytes) return overFolder
          const read = yield* readBytes(at, shown(child), stat.value)
          if (read._tag !== "Read") return read.fact
          bytes += read.bytes.length
          if (bytes > RUNBOOK_FILE_LIMITS.folderBytes) return overFolder
          files.push({ path: child, executable: isExecutable(stat.value), bytes: read.bytes })
        }
        return undefined
      })

    const problem = yield* walk("", 0)
    if (problem !== undefined) return problem
    return {
      _tag: "Found",
      hash: folderHash(files),
      texts: files.map((file) => ({ path: shown(file.path), text: textOf(file.bytes) })),
    }
  })

/**
 * The tag each hash starts with. Neither starts the other, so a file whose
 * bytes are some folder's framing still hashes apart from that folder.
 */
const FILE_TAG = "file\n"
const FOLDER_TAG = "folder\n"

/** SHA-256 over the file tag and a named file's bytes. */
export function fileHash(bytes: Uint8Array): ContentHash {
  return toHash(`sha256:${createHash("sha256").update(FILE_TAG).update(bytes).digest("hex")}`)
}

/**
 * SHA-256 over the folder tag, then each file's path, executable bit and
 * bytes, in the order read. A length goes before the path and the bytes, so
 * "a" + "bc" and "ab" + "c" hash apart.
 */
function folderHash(files: ReadonlyArray<FolderFile>): ContentHash {
  const hash = createHash("sha256").update(FOLDER_TAG)
  for (const file of files) {
    const name = encoder.encode(file.path)
    hash.update(`${name.length}:`).update(name)
    hash.update(file.executable ? "x" : "-")
    hash.update(`${file.bytes.length}:`).update(file.bytes)
  }
  return toHash(`sha256:${hash.digest("hex")}`)
}

/**
 * Whether the owner may run the file, the bit git keeps: the others follow
 * the umask, which differs from one clone to the next. Windows keeps none.
 */
function isExecutable(stat: FileStat): boolean {
  return Option.exists(stat.mode, (mode) => (mode & 0o100) !== 0)
}

/** The bytes as UTF-8, a sequence that isn't UTF-8 replaced. */
function textOf(bytes: Uint8Array): string {
  return decoder.decode(bytes)
}

const byName = (a: { readonly name: string }, b: { readonly name: string }) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0
