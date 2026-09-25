/**
 * Write a `<TemplateInline generateFile>` block's rendered output to disk.
 *
 * Each key of `files` is the block's `outputPath` (e.g. `README.md` or
 * `docs/account.hcl`), so it names a file relative to `baseDir`, not a
 * directory. Parent directories are created as needed because the
 * FileSystem service's `writeFile` does not create them.
 */

import path from "node:path"
import { Effect } from "effect"

import { FileSystem } from "../../services/FileSystem.ts"
import { validateRelativePathIn } from "../../path-validation.ts"

export const writeInlineRenderedFiles = (
  files: Readonly<Record<string, string>>,
  baseDir: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem

    // Validate every path before writing any, so one bad key writes nothing.
    for (const name of Object.keys(files)) {
      yield* validateRelativePathIn(name, baseDir)
    }

    for (const [name, content] of Object.entries(files)) {
      const filePath = path.resolve(baseDir, name)
      yield* fs.mkdir(path.dirname(filePath), { recursive: true })
      yield* fs.writeFile(filePath, content)
    }
  })
