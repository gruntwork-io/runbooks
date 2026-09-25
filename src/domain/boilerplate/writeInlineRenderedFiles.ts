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
 * wrote, the file it left at a path this render no longer writes is removed,
 * so the block owns one file rather than one per intermediate path.
 */

import path from "node:path"
import { Effect, Either, Option } from "effect"

import { FileSystem } from "../../services/FileSystem.ts"
import { validateRelativePathIn } from "../../path-validation.ts"
import { cleanupEmptyParentDirs, hashFileContent } from "../files/manifest.ts"
import type { ManifestEntry } from "../../types.ts"

/** What one render wrote: its base dir, and each file with the hash of the content written. */
export interface InlineWriteRecord {
  readonly outputDir: string
  readonly files: readonly ManifestEntry[]
}

export const writeInlineRenderedFiles = (
  files: Readonly<Record<string, string>>,
  baseDir: string,
  previous?: InlineWriteRecord,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem

    // Validate every path before touching the disk, so one bad key writes
    // (and removes) nothing.
    for (const name of Object.keys(files)) {
      yield* validateRelativePathIn(name, baseDir)
    }

    // Remove stale files first, as Template's manifest diff does, so a path
    // that turns from a file into a directory (or back) can be written.
    if (previous) {
      const current = new Set(Object.keys(files).map((name) => path.resolve(baseDir, name)))
      yield* removeStaleFiles(previous, current)
    }

    const written: ManifestEntry[] = []
    for (const [name, content] of Object.entries(files)) {
      const filePath = path.resolve(baseDir, name)
      yield* fs.mkdir(path.dirname(filePath), { recursive: true })
      yield* fs.writeFile(filePath, content)
      written.push({ path: name, contentHash: hashFileContent(content) })
    }
    return { outputDir: baseDir, files: written } satisfies InlineWriteRecord
  })

/**
 * Remove each file `previous` wrote that is not in `keep` (absolute paths),
 * but only while it still holds exactly what the block wrote: a file the user
 * or another block has changed since is left alone. Directories this leaves
 * empty are removed up to, not including, `previous.outputDir`. Failures are
 * ignored, because a stale file that cannot be removed must not fail the
 * render that replaced it.
 */
const removeStaleFiles = (previous: InlineWriteRecord, keep: ReadonlySet<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    for (const entry of previous.files) {
      const filePath = path.resolve(previous.outputDir, entry.path)
      if (keep.has(filePath)) continue
      const valid = yield* Effect.either(validateRelativePathIn(entry.path, previous.outputDir))
      if (Either.isLeft(valid)) continue
      const content = yield* Effect.option(fs.readFile(filePath))
      if (Option.isNone(content) || hashFileContent(content.value) !== entry.contentHash) continue
      const removed = yield* Effect.isSuccess(fs.rm(filePath, { force: true }))
      if (removed) yield* cleanupEmptyParentDirs(path.dirname(filePath), previous.outputDir)
    }
  })
