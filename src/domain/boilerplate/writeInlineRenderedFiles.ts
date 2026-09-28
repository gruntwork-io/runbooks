/**
 * Write a `<TemplateInline generateFile>` block's rendered output to disk.
 *
 * Each key of `files` is the block's `outputPath` (e.g. `README.md` or
 * `docs/account.hcl`), so it names a file relative to `baseDir`, not a
 * directory. Parent directories are created as needed because the
 * FileSystem service's `writeFile` does not create them.
 *
 * The block re-renders on every input or output change, and its outputPath
 * can change with them (e.g. `{{ .outputs.picker.PATH }}/terragrunt.hcl`
 * follows each DirPicker selection). Given what the block's previous render
 * wrote, the file it left at a path this render no longer writes is cleaned
 * up, so the block owns one file rather than one per intermediate path. A
 * file the block created is removed. A file that was already there when the
 * block first wrote to it (e.g. an existing unit's `terragrunt.hcl` in a
 * cloned repo) is put back the way it was, never removed.
 *
 * Cleanup only happens inside the directory this render writes to, as
 * Template's manifest diff only touches its current output dir. When the
 * previous render wrote somewhere else (e.g. `target="worktree"` and another
 * `<GitClone>` has since become the active worktree), its file is left where
 * it is: that repo may still be opened as a pull request.
 */

import path from "node:path"
import { Effect, Either, Option } from "effect"

import { FileSystem } from "../../services/FileSystem.ts"
import { validateRelativePathIn } from "../../path-validation.ts"
import { cleanupEmptyParentDirs, hashFileContent } from "../files/manifest.ts"
import type { ManifestEntry } from "../../types.ts"

/** One file a render wrote: its path relative to the record's outputDir, and the hash of the content written. */
export interface InlineWrittenFile extends ManifestEntry {
  /**
   * Set when the file already existed before the block first wrote to it:
   * what it held then, or `null` if that could not be read. Undefined when
   * the block created the file. Carried forward while the block keeps
   * writing the same path, so it is always the content from before the
   * block touched the file.
   */
  readonly original?: Buffer | null
}

/** What one render wrote: its base dir, and each file it wrote. */
export interface InlineWriteRecord {
  readonly outputDir: string
  readonly files: readonly InlineWrittenFile[]
}

export const writeInlineRenderedFiles = (
  files: Readonly<Record<string, string>>,
  baseDir: string,
  previous?: InlineWriteRecord,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem

    // Validate every path before touching the disk, so one bad key writes
    // (and cleans up) nothing.
    for (const name of Object.keys(files)) {
      yield* validateRelativePathIn(name, baseDir)
    }

    // Clean up stale files first, as Template's manifest diff does, so a
    // path that turns from a file into a directory (or back) can be written.
    // A previous render into another directory is not ours to clean up.
    const previousByPath = new Map<string, InlineWrittenFile>()
    if (previous && path.resolve(previous.outputDir) === path.resolve(baseDir)) {
      for (const entry of previous.files) {
        previousByPath.set(path.resolve(previous.outputDir, entry.path), entry)
      }
      const current = new Set(Object.keys(files).map((name) => path.resolve(baseDir, name)))
      yield* cleanUpStaleFiles(previous, current)
    }

    const written: InlineWrittenFile[] = []
    for (const [name, content] of Object.entries(files)) {
      const filePath = path.resolve(baseDir, name)
      // A path the block already wrote keeps the original recorded then;
      // anything else is read now, before this render overwrites it.
      const kept = previousByPath.get(filePath)
      const original = kept ? kept.original : yield* readOriginal(filePath)
      yield* fs.mkdir(path.dirname(filePath), { recursive: true })
      yield* fs.writeFile(filePath, content)
      written.push({ path: name, contentHash: hashFileContent(content), original })
    }
    return { outputDir: baseDir, files: written } satisfies InlineWriteRecord
  })

/**
 * What `filePath` holds before the block first writes to it: undefined when
 * there is no file, its bytes when there is one, and `null` when something is
 * there that cannot be read, which is then never removed or restored.
 */
const readOriginal = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const read = yield* Effect.either(fs.readFileBuffer(filePath))
    if (Either.isRight(read)) return read.right
    return read.left._tag === "FileNotFoundError" ? undefined : null
  })

/**
 * Clean up each file `previous` wrote that is not in `keep` (absolute paths),
 * but only while it still holds exactly what the block wrote: a file the user
 * or another block has changed since is left alone. A file the block created
 * is removed, along with the directories that leaves empty up to, not
 * including, `previous.outputDir`. A file that was already there is put back
 * to its original content instead, so the block never deletes a file it did
 * not create. Failures are ignored, because a stale file that cannot be
 * cleaned up must not fail the render that replaced it.
 */
const cleanUpStaleFiles = (previous: InlineWriteRecord, keep: ReadonlySet<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    for (const entry of previous.files) {
      const filePath = path.resolve(previous.outputDir, entry.path)
      if (keep.has(filePath)) continue
      const valid = yield* Effect.either(validateRelativePathIn(entry.path, previous.outputDir))
      if (Either.isLeft(valid)) continue
      const content = yield* Effect.option(fs.readFile(filePath))
      if (Option.isNone(content) || hashFileContent(content.value) !== entry.contentHash) continue
      if (entry.original === null) continue
      if (entry.original !== undefined) {
        yield* Effect.ignore(fs.writeFile(filePath, entry.original))
        continue
      }
      const removed = yield* Effect.isSuccess(fs.rm(filePath, { force: true }))
      if (removed) yield* cleanupEmptyParentDirs(path.dirname(filePath), previous.outputDir)
    }
  })
