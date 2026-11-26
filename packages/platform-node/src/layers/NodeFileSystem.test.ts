import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as nodeFs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"
import { Effect, Option, Result, Stream } from "effect"
import { FileSystem, type FileSystemShape } from "@runbooks/core/services/FileSystem"
import { NodeFileSystemLive, WALK_BUFFER } from "./NodeFileSystem.ts"

let root = ""

beforeEach(() => {
  root = nodeFs.realpathSync(nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "runbooks-fs-")))
})

afterEach(() => {
  nodeFs.rmSync(root, { recursive: true, force: true })
})

const readUpTo = (path: string, maxBytes: number) =>
  Effect.runPromise(
    Effect.result(
      Effect.gen(function* () {
        const fs = yield* FileSystem
        return yield* fs.readFileUpTo(path, maxBytes)
      }).pipe(Effect.provide(NodeFileSystemLive)),
    ),
  )

describe("readFileUpTo", () => {
  it("reads a file whole when it fits, and says when it was cut off", async () => {
    const file = nodePath.join(root, "f")
    nodeFs.writeFileSync(file, "0123456789")
    expect(await readUpTo(file, 10)).toEqual(
      Result.succeed({ text: "0123456789", truncated: false }),
    )
    expect(await readUpTo(file, 4)).toEqual(Result.succeed({ text: "0123", truncated: true }))
  })

  it("reads nothing that is not a regular file, and says a missing file is missing", async () => {
    const folder = await readUpTo(root, 10)
    expect(Result.isFailure(folder) && folder.failure._tag).toBe("FileReadError")
    const missing = await readUpTo(nodePath.join(root, "none"), 10)
    expect(Result.isFailure(missing) && missing.failure._tag).toBe("FileNotFoundError")
  })
})

const withFs = <A, E>(f: (fs: FileSystemShape) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* f(yield* FileSystem)
    }).pipe(Effect.provide(NodeFileSystemLive)),
  )

/** A path's permission bits, read without the layer. */
const modeOf = (path: string) => nodeFs.statSync(path).mode & 0o777

describe("modes", () => {
  it("create a folder, and each parent it makes, and a file with the mode asked for", async () => {
    const folder = nodePath.join(root, "state", "s1", "block")
    const file = nodePath.join(folder, "key.json")
    await withFs((fs) =>
      Effect.andThen(
        fs.mkdir(folder, { recursive: true, mode: 0o700 }),
        fs.writeFile(file, "{}", { mode: 0o600 }),
      ),
    )
    expect([modeOf(nodePath.join(root, "state")), modeOf(folder), modeOf(file)]).toEqual([
      0o700, 0o700, 0o600,
    ])
  })

  it("are what stat reports, and never change one that is there", async () => {
    const file = nodePath.join(root, "open.txt")
    nodeFs.writeFileSync(file, "x", { mode: 0o644 })
    const stat = await withFs((fs) =>
      Effect.andThen(fs.writeFile(file, "y", { mode: 0o600 }), fs.stat(file)),
    )
    expect(Option.getOrNull(stat.mode)).toBe(0o644)
    expect(modeOf(file)).toBe(0o644)
  })
})

describe("walk", () => {
  it("reads every entry under a folder, with its size, and a link as neither file nor folder", async () => {
    nodeFs.mkdirSync(nodePath.join(root, "a", "b"), { recursive: true })
    nodeFs.writeFileSync(nodePath.join(root, "a", "b", "f.txt"), "12345")
    nodeFs.symlinkSync(nodePath.join(root, "none"), nodePath.join(root, "a", "link"))
    const entries = await withFs((fs) => Stream.runCollect(fs.walk(root)))
    const brief = entries
      .map((e) => `${e.relativePath} ${e.isFile ? "file" : e.isDirectory ? "folder" : "other"}`)
      .sort()
    expect(brief).toEqual(["a folder", "a/b folder", "a/b/f.txt file", "a/link other"])
    expect(entries.find((e) => e.isFile)).toMatchObject({
      path: nodePath.join(root, "a", "b", "f.txt"),
      size: 5,
    })
  })

  it("fails with a read error on a folder that is not there", async () => {
    const walked = await withFs((fs) =>
      Effect.result(Stream.runCollect(fs.walk(nodePath.join(root, "none")))),
    )
    expect(Result.isFailure(walked) && walked.failure._tag).toBe("FileReadError")
  })

  it("reads no more than its buffer ahead of a reader that waits", async () => {
    const count = 4 * WALK_BUFFER
    const fill = (text: string) => {
      for (let i = 0; i < count; i++) nodeFs.writeFileSync(nodePath.join(root, `f${i}`), text)
    }
    fill("")
    const sizes: number[] = []
    await withFs((fs) =>
      fs.walk(root).pipe(
        Stream.runForEach((entry) =>
          Effect.gen(function* () {
            if (sizes.length === 0) {
              // Wait, long enough for an unbounded walk to read every entry,
              // then grow every file: an entry read from now on is 1 byte.
              yield* Effect.sleep("200 millis")
              fill("x")
            }
            sizes.push(entry.size)
          }),
        ),
      ),
    )
    expect(sizes).toHaveLength(count)
    // Read before the files grew: the chunk the reader took, a full buffer,
    // and the entry waiting to go in.
    const ahead = sizes.filter((size) => size === 0).length
    expect(ahead).toBeLessThanOrEqual(2 * WALK_BUFFER + 1)
  })
})
