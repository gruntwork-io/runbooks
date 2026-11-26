/**
 * The spawner against real processes: how a signal reads as an exit code,
 * and that a reader slower than its child gets every line.
 */
import { describe, expect, it } from "bun:test"
import { Effect, Stream } from "effect"
import { ProcessSpawner } from "@runbooks/core/services/ProcessSpawner"
import { ChildProcessSpawnerLive } from "../../layers/ChildProcessSpawner.ts"
import { MAX_LINE_LENGTH } from "../../layers/lineSplitter.ts"

/** Runs `script` under /bin/sh, reading its output with `each`, and gives its exit code. */
function run(script: string, each: (line: string) => Effect.Effect<void> = () => Effect.void) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const spawner = yield* ProcessSpawner
      const proc = yield* spawner.spawn("/bin/sh", ["-c", script])
      yield* Stream.runForEach(proc.output, (line) => each(line.line))
      return yield* proc.exitCode
    }).pipe(Effect.provide(ChildProcessSpawnerLive)),
  )
}

describe("the spawner, on real processes", () => {
  it("gives a child killed by a signal 128 plus the signal's number, as a shell does", async () => {
    expect(await run("kill -KILL $$")).toBe(137)
    expect(await run("kill -TERM $$")).toBe(143)
    expect(await run("exit 3")).toBe(3)
  })

  it("gives a reader slower than its child every line, in order", async () => {
    // 40,000 lines of 1,000 characters, 4,000 of each digit, written at once
    // by `yes`, read with a pause every 500 lines: the reader falls five
    // times further behind than the spawner holds before it pauses the child.
    const lengths: number[] = []
    const firsts: string[] = []
    const code = await run(
      'for d in 0 1 2 3 4 5 6 7 8 9; do yes "$(printf "%01000d" 0 | tr 0 $d)" | head -n 4000; done',
      (line) =>
        Effect.gen(function* () {
          lengths.push(line.length)
          if (lengths.length % 4000 === 1) firsts.push(line[0] ?? "")
          if (lengths.length % 500 === 0) yield* Effect.sleep("5 millis")
        }),
    )
    expect(code).toBe(0)
    expect(lengths).toHaveLength(40_000)
    expect(lengths.every((n) => n === 1000)).toBe(true)
    expect(firsts.join("")).toBe("0123456789")
  }, 30_000)

  it("gives a line longer than the limit in pieces", async () => {
    const lengths: number[] = []
    const length = 2 * MAX_LINE_LENGTH + 10
    await run(`head -c ${length} /dev/zero | tr '\\0' a`, (line) =>
      Effect.sync(() => lengths.push(line.length)),
    )
    expect(lengths).toEqual([MAX_LINE_LENGTH, MAX_LINE_LENGTH, 10])
  })
})
