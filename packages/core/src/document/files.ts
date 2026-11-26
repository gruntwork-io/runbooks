/**
 * The files a runbook's blocks name: whether each is inside the runbook's
 * folder, its hash, and its text, for the template references in it.
 */
import { createHash } from "node:crypto"
import path from "node:path"
import { Effect, Option, Schema, Stream } from "effect"
import type { RunbookPath } from "@runbooks/blocks-core/contract"
import { hashTemplateDir } from "../domain/boilerplate/templateHash.ts"
import { isContainedIn } from "../path-validation.ts"
import { FileSystem } from "../services/FileSystem.ts"
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
       * A file's bytes. A folder's: each file's path in it, executable bit and
       * bytes, in path order, so a change to any of them changes the hash.
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

/** The most files of a folder read for template references, as `hashTemplateDir` hashes. */
const MAX_FOLDER_FILES = 2000

const VCS_DIRS: ReadonlySet<string> = new Set([".git", ".svn", ".hg"])

const toHash = Schema.decodeSync(ContentHash)
const MISSING: FileFact = { _tag: "Missing" }
const OUTSIDE: FileFact = { _tag: "Outside" }

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
    if (Option.isNone(real) || Option.isNone(realFolder)) return MISSING
    if (!isContainedIn(real.value, realFolder.value)) return OUTSIDE

    if (stat.value.isFile) {
      const bytes = yield* fs.readFileBuffer(resolved).pipe(Effect.option)
      if (Option.isNone(bytes)) return MISSING
      const hash = toHash(`sha256:${createHash("sha256").update(bytes.value).digest("hex")}`)
      const text = new TextDecoder().decode(bytes.value)
      return { _tag: "Found", hash, texts: [{ path: file, text }] }
    }
    if (!stat.value.isDirectory) return MISSING

    const hash = toHash(`sha256:${yield* hashTemplateDir(resolved)}`)
    const entries = yield* fs.walk(resolved).pipe(
      Stream.filter((entry) => entry.isFile && !inVcsDir(entry.relativePath)),
      Stream.take(MAX_FOLDER_FILES),
      Stream.runCollect,
      Effect.orElseSucceed(() => []),
    )
    const texts: FileText[] = []
    for (const entry of [...entries].sort(byRelativePath)) {
      const text = yield* fs.readFile(entry.path).pipe(Effect.option)
      if (Option.isSome(text)) {
        texts.push({ path: path.posix.join(file, entry.relativePath), text: text.value })
      }
    }
    return { _tag: "Found", hash, texts }
  })

function inVcsDir(relativePath: string): boolean {
  return relativePath.split(/[/\\]/).some((segment) => VCS_DIRS.has(segment))
}

const byRelativePath = (a: { relativePath: string }, b: { relativePath: string }) =>
  a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0
