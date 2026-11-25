import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as nodeFs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"
import { Effect, Result } from "effect"
import { FileSystem } from "@runbooks/core/services/FileSystem"
import { NodeFileSystemLive } from "./NodeFileSystem.ts"

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
