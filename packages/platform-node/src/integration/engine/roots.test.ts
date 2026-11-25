import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as nodeFs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"
import { Effect } from "effect"
import { PathOutsideRoot } from "@runbooks/blocks-core/contract"
import type { BlockStatus } from "@runbooks/blocks-core/status"
import { type UseRootsSession, withRootsSession } from "@runbooks/core/test-utils/rootSessions"
import { NodeFileSystemLive } from "../../layers/NodeFileSystem.ts"

// The engine's roots against the real filesystem, for what only a real
// symbolic link shows. Ported by name from electron/main/ipc/path-guard.test.ts.
// Layout, under a realpath'd temp root (macOS' /var is a symlink):
//   outside/secret.txt
//   outside/Documents/
//   rb/runbook.mdx
//   work/<session>/              <- the session's working folder
//   work/<session>/link -> outside, planted as a cloned repository might ship it
let root = ""
let outside = ""

beforeEach(() => {
  root = nodeFs.realpathSync(nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "runbooks-roots-")))
  outside = nodePath.join(root, "outside")
  nodeFs.mkdirSync(nodePath.join(outside, "Documents"), { recursive: true })
  nodeFs.writeFileSync(nodePath.join(outside, "secret.txt"), "secret")
  nodeFs.mkdirSync(nodePath.join(root, "rb"))
})

afterEach(() => {
  nodeFs.rmSync(root, { recursive: true, force: true })
})

const RUNBOOK = [
  '<Clone id="clone" label="clone" />',
  '<Touch id="link" label="link" root="working" path="link" />',
  '<Touch id="secret" label="secret" root="working" path="link/secret.txt" />',
].join("\n\n")

/** A trusted session of `RUNBOOK`, its working folder holding `link`, a symbolic link to `outside`. */
const withLinkedSession = <A, E>(use: UseRootsSession<A, E>) => {
  const file = nodePath.join(root, "rb", "runbook.mdx")
  nodeFs.writeFileSync(file, RUNBOOK)
  return withRootsSession(
    { file, workingFolders: nodePath.join(root, "work"), fileSystem: NodeFileSystemLive },
    (rb) =>
      Effect.andThen(
        Effect.sync(() => {
          nodeFs.mkdirSync(rb.working, { recursive: true })
          nodeFs.symlinkSync(outside, nodePath.join(rb.working, "link"))
        }),
        use(rb),
      ),
  )
}

const outsideWorking = (working: string, path: string): BlockStatus => ({
  _tag: "Failed",
  error: new PathOutsideRoot({
    root: "working",
    path,
    message: `${path} is outside the working folder, ${working}.`,
  }),
})

describe("the engine's roots, on the real filesystem", () => {
  it("rejects a path in the session that is a symlink to outside it", async () => {
    await withLinkedSession((rb) =>
      Effect.gen(function* () {
        expect(yield* rb.run("link")).toEqual(outsideWorking(rb.working, "link"))
        expect(yield* rb.run("secret")).toEqual(outsideWorking(rb.working, "link/secret.txt"))
        expect(rb.seen.size).toBe(0)
      }),
    )
  })

  it("rejects a destination reached through a symlink that points outside", async () => {
    await withLinkedSession((rb) =>
      Effect.gen(function* () {
        for (const localPath of ["link/Documents", "link"]) {
          yield* rb.set("clone", { localPath })
          expect(yield* rb.run("clone")).toEqual(outsideWorking(rb.working, localPath))
        }
      }),
    )
  })

  it("makes the working folder in the folder the entry point names, and clones inside it", async () => {
    const file = nodePath.join(root, "rb", "runbook.mdx")
    nodeFs.writeFileSync(file, '<Clone id="clone" label="clone" />')
    const working = await withRootsSession(
      { file, workingFolders: nodePath.join(root, "work"), fileSystem: NodeFileSystemLive },
      (rb) =>
        Effect.gen(function* () {
          expect(nodeFs.existsSync(rb.working)).toBe(false)
          const done: BlockStatus = { _tag: "Done", outcome: "success" }
          expect(yield* rb.run("clone")).toEqual(done)
          expect(rb.seen.get("clone")?.paths).toEqual({ target: nodePath.join(rb.working, "repo") })
          return rb.working
        }),
    )
    expect(nodeFs.statSync(working).isDirectory()).toBe(true)
    expect(nodePath.dirname(working)).toBe(nodePath.join(root, "work"))
  })
})
