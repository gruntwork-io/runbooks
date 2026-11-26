// Each world is a folder of its own under the OS's temp folder; nothing
// touches HOME. The unreadable cases need a user other than root, as CI's.
import { afterAll } from "bun:test"
import * as nodeFs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"
import { Effect } from "effect"
import { FileSystem } from "@runbooks/core/services/FileSystem"
import {
  runbookFilesContract,
  type Tree,
  treeEntries,
} from "@runbooks/core/test-utils/runbookFilesContract"
import { NodeFileSystemLive } from "../../layers/NodeFileSystem.ts"

const worlds: string[] = []
/** Folders laid out without the owner's permissions, given them back before they are removed. */
const locked: string[] = []

afterAll(() => {
  for (const folder of locked) nodeFs.chmodSync(folder, 0o700)
  for (const world of worlds) nodeFs.rmSync(world, { recursive: true, force: true })
})

const fileSystem = Effect.runSync(Effect.provide(FileSystem, NodeFileSystemLive))

runbookFilesContract("on disk", {
  lay: (tree: Tree) => {
    const world = nodeFs.realpathSync(
      nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "runbook-files-")),
    )
    worlds.push(world)
    const folder = nodePath.join(world, "rb")
    nodeFs.mkdirSync(folder)
    const entries = treeEntries(tree)
    for (const [relative, entry] of entries) {
      const at = nodePath.resolve(folder, relative)
      nodeFs.mkdirSync(nodePath.dirname(at), { recursive: true })
      switch (entry.kind) {
        case "file":
          nodeFs.writeFileSync(at, entry.content)
          nodeFs.chmodSync(at, entry.mode ?? 0o644)
          break
        case "link":
          nodeFs.symlinkSync(nodePath.resolve(folder, entry.to), at)
          break
        case "folder":
          nodeFs.mkdirSync(at, { recursive: true })
          break
      }
    }
    // A folder's mode last, once what it holds is written.
    for (const [relative, entry] of entries) {
      if (entry.kind !== "folder") continue
      const at = nodePath.resolve(folder, relative)
      locked.push(at)
      nodeFs.chmodSync(at, entry.mode ?? 0o755)
    }
    return Promise.resolve({ folder, fileSystem })
  },
})
