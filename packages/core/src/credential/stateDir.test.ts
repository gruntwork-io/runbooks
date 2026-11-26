import { describe, expect, it } from "bun:test"
import path from "node:path"
import { Effect, Layer, Option, Result, Schema } from "effect"
import { BlockId } from "@runbooks/blocks-core/contract"
import { FileSystem } from "../services/FileSystem.ts"
import { testFileSystem } from "../test-utils/TestFileSystem.ts"
import { isOwnerOnly, prepareStateDir, stateDirOf } from "./stateDir.ts"

const DIR = "/state/s1/cloud"

/** Prepares `DIR` in an in-memory filesystem holding `files` and `folders`, and reads its mode back. */
const prepare = (files: Record<string, string> = {}, folders: ReadonlyArray<string> = []) => {
  const fs = testFileSystem(files, folders)
  return Effect.runPromise(
    Effect.gen(function* () {
      const result = yield* Effect.result(prepareStateDir(DIR))
      const mode = yield* Effect.map(Effect.option(fs.stat(DIR)), (stat) =>
        Option.flatMap(stat, (found) => found.mode),
      )
      return { result, mode: Option.getOrNull(mode) }
    }).pipe(Effect.provide(Layer.succeed(FileSystem, fs))),
  )
}

describe("a credential block's state folder", () => {
  const blockId = Schema.decodeSync(BlockId)

  it("is the same folder each time for one block, so a resumed session finds it", () => {
    expect(stateDirOf("/state/s1", blockId("cloud"))).toBe(
      stateDirOf("/state/s1", blockId("cloud")),
    )
  })

  it("is the session folder's own, named by the id lowercased and a hash of it as written", () => {
    for (const id of ["cloud", "Cloud", "aws-prod", "AWS_PROD", "9"]) {
      const dir = stateDirOf("/state/s1", blockId(id))
      expect(path.dirname(dir)).toBe("/state/s1")
      expect(path.basename(dir)).toMatch(/^[a-z0-9_]+-[0-9a-f]{12}$/)
    }
  })

  it("is made readable by its owner only", async () => {
    const { result, mode } = await prepare()
    expect(Result.isSuccess(result)).toBe(true)
    expect(mode).toBe(0o700)
  })

  it("is refused when others can read it, and the error says how to close it", async () => {
    const { result } = await prepare({}, [DIR])
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure.kind).toBe("providerFailed")
      expect(result.failure.message).toContain(DIR)
      expect(result.failure.message).toContain("mode 755")
      expect(result.failure.message).toContain("chmod 700")
    }
  })

  it("is refused when it is a file", async () => {
    const { result } = await prepare({ [DIR]: "not a folder" })
    expect(Result.isFailure(result) && result.failure.kind).toBe("providerFailed")
  })

  it("counts as owner-only only with no bits for the group or others, or no bits at all (Windows)", () => {
    expect([0o700, 0o600, 0o500].map((mode) => isOwnerOnly(Option.some(mode)))).toEqual([
      true,
      true,
      true,
    ])
    expect([0o710, 0o701, 0o755, 0o640].map((mode) => isOwnerOnly(Option.some(mode)))).toEqual([
      false,
      false,
      false,
      false,
    ])
    expect(isOwnerOnly(Option.none())).toBe(true)
  })
})
