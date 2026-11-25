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

/** What is at one path a block names. */
export type FileFact =
  | {
      readonly _tag: "Found"
      /** A file's bytes, or a folder's sorted tree as `hashTemplateDir` hashes it. */
      readonly hash: ContentHash
      /** The file, or each file in the folder, up to `MAX_FOLDER_FILES`. */
      readonly texts: ReadonlyArray<FileText>
    }
  | { readonly _tag: "Missing" }
  /** Outside the runbook's folder, written so or through a symbolic link. */
  | { readonly _tag: "Outside" }

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
