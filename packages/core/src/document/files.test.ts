import path from "node:path"
import { Effect } from "effect"
import { testFileSystem } from "../test-utils/TestFileSystem.ts"
import { runbookFilesContract, type Tree, treeEntries } from "../test-utils/runbookFilesContract.ts"

const FOLDER = "/w/rb"

/** Each folder `file` is in, up to the root. */
const ancestors = (file: string): ReadonlyArray<string> => {
  const dirs: string[] = []
  for (let dir = path.posix.dirname(file); dir !== "/"; dir = path.posix.dirname(dir))
    dirs.push(dir)
  return dirs
}

runbookFilesContract("in memory", {
  lay: (tree: Tree) => {
    const at = (relative: string) => path.posix.join(FOLDER, relative)
    const entries = treeEntries(tree)
    const links = Object.fromEntries(
      entries.flatMap(([relative, entry]) =>
        entry.kind === "link" ? [[at(relative), at(entry.to)]] : [],
      ),
    )
    const fileSystem = testFileSystem({}, [], links)
    const made = Effect.gen(function* () {
      // A mode applies when a file or folder is made, so the folders the tree names come first.
      for (const [relative, entry] of entries) {
        if (entry.kind === "folder") {
          yield* fileSystem.mkdir(
            at(relative),
            entry.mode === undefined ? {} : { mode: entry.mode },
          )
        }
      }
      for (const [relative, entry] of entries) {
        if (entry.kind !== "file") continue
        const { content, mode } = entry
        yield* fileSystem.writeFile(
          at(relative),
          typeof content === "string" ? content : Buffer.from(content),
          mode === undefined ? {} : { mode },
        )
      }
      for (const [relative] of entries) {
        for (const dir of ancestors(at(relative))) yield* fileSystem.mkdir(dir)
      }
      return { folder: FOLDER, fileSystem }
    })
    return Effect.runPromise(made)
  },
})
