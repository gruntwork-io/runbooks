/**
 * A hash of a template directory's files, so a block can tell that the files
 * it would render changed even though its values did not.
 */
import { createHash } from "crypto"
import { Effect } from "effect"
import { FileSystem } from "../../services/FileSystem.ts"

// A template is the author's, and so may be any size: the walk stops at these
// limits. A change past them goes unnoticed; one within them does not.
const MAX_FILES = 2000
const MAX_DEPTH = 16

/**
 * SHA-256 over the path, relative to `dir`, and the content of each file
 * under it, in sorted order. VCS directories are skipped. Files and
 * directories that can't be read count as empty.
 */
export const hashTemplateDir = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const hash = createHash("sha256")
    let files = 0

    const walk = (relative: string, depth: number): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        if (depth > MAX_DEPTH) return
        const entries = yield* fs
          .readdirWithTypes(relative === "" ? dir : `${dir}/${relative}`)
          .pipe(Effect.orElseSucceed(() => []))
        const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        for (const entry of sorted) {
          if (files >= MAX_FILES) return
          const path = relative === "" ? entry.name : `${relative}/${entry.name}`
          if (entry.isDirectory) {
            if (VCS_DIRS.has(entry.name)) continue
            yield* walk(path, depth + 1)
          } else if (entry.isFile) {
            files++
            const content = yield* fs
              .readFile(`${dir}/${path}`)
              .pipe(Effect.orElseSucceed(() => ""))
            // Lengths keep "a" + "bc" apart from "ab" + "c".
            hash.update(`${path.length}:${path}${content.length}:`).update(content)
          }
        }
      })

    yield* walk("", 0)
    return hash.digest("hex")
  })

const VCS_DIRS = new Set([".git", ".svn", ".hg"])
