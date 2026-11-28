import { describe, expect, it } from "bun:test"
import { Effect, Fiber, Stream } from "effect"
import type { FileChangeEvent } from "../services/FileSystem.ts"
import { testFileSystem } from "./TestFileSystem.ts"

/** The first `count` events `watch` reports while `change` runs. */
const seen = (
  watch: Stream.Stream<FileChangeEvent, unknown>,
  count: number,
  change: Effect.Effect<unknown, unknown>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const watching = yield* Effect.forkChild(Stream.runCollect(Stream.take(watch, count)), {
        startImmediately: true,
      })
      yield* change
      return yield* Fiber.join(watching)
    }),
  )

describe("the in-memory file system's watch, as chokidar's", () => {
  it("reports a file added, changed and removed directly in a folder watched at depth 0, and none deeper", async () => {
    const fs = testFileSystem({ "/rb/deploy.sh": "echo hi\n" }, ["/rb"])
    const events = await seen(
      fs.watch(["/rb"], { depth: 0 }),
      4,
      Effect.all([
        fs.writeFile("/rb/lib/deep.sh", "deep"),
        fs.writeFile("/rb/new.sh", "new"),
        fs.writeFile("/rb/deploy.sh", "echo there\n"),
        fs.appendFile("/rb/deploy.sh", "echo again\n"),
        fs.rm("/rb/new.sh"),
      ]),
    )
    expect(events).toEqual([
      { type: "add", path: "/rb/new.sh" },
      { type: "change", path: "/rb/deploy.sh" },
      { type: "change", path: "/rb/deploy.sh" },
      { type: "unlink", path: "/rb/new.sh" },
    ])
  })

  it("reports a file at any depth in a folder watched with no depth, and each file a removed folder held", async () => {
    const fs = testFileSystem({ "/rb/lib/a.sh": "a" }, ["/rb", "/rb/lib"])
    const events = await seen(
      fs.watch(["/rb/lib"]),
      3,
      Effect.all([
        fs.writeFile("/rb/other.sh", "not watched"),
        fs.writeFile("/rb/libs.sh", "not in the folder, though its name starts with it"),
        fs.writeFile("/rb/lib/deep/b.sh", "b"),
        fs.copyFile("/rb/lib/a.sh", "/rb/lib/c.sh"),
        fs.rm("/rb/lib/deep", { recursive: true }),
      ]),
    )
    expect(events).toEqual([
      { type: "add", path: "/rb/lib/deep/b.sh" },
      { type: "add", path: "/rb/lib/c.sh" },
      { type: "unlink", path: "/rb/lib/deep/b.sh" },
    ])
  })
})
