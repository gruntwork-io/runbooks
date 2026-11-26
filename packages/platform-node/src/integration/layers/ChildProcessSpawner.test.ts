/**
 * The spawner against real processes: how a signal reads as an exit code,
 * and that a reader slower than its child gets every line.
 */
import { describe, expect, it } from "bun:test"
import { Effect, Stream } from "effect"
import { collectOutput, ProcessSpawner } from "@runbooks/core/services/ProcessSpawner"
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

  it("gives a line longer than the limit whole to collectOutput, so JSON on one line parses", async () => {
    // As system-ca.ts reads the CA store: one JSON line, longer than the limit.
    // The child builds it: Linux caps one argument at 128K characters.
    const build = (length: number) => ({
      certificates: Array.from({ length }, (_, i) => `cert-${i}-${"x".repeat(50)}`),
    })
    const value = build(3000)
    expect(JSON.stringify(value).length).toBeGreaterThan(2 * MAX_LINE_LENGTH)
    const { exitCode, lines } = await Effect.runPromise(
      Effect.gen(function* () {
        const spawner = yield* ProcessSpawner
        const proc = yield* spawner.spawn(process.execPath, [
          "-e",
          `process.stdout.write(JSON.stringify((${build.toString()})(3000)))`,
        ])
        return yield* collectOutput(proc, 30_000)
      }).pipe(Effect.provide(ChildProcessSpawnerLive)),
    )
    expect(exitCode).toBe(0)
    const stdout = lines.filter((l) => l.source === "stdout").map((l) => l.line)
    expect(JSON.parse(stdout.join("\n"))).toEqual(value)
  })

  it("gives the exit code to a caller that never reads output, however much the child writes", async () => {
    const code = await Effect.runPromise(
      Effect.gen(function* () {
        const spawner = yield* ProcessSpawner
        const proc = yield* spawner.spawn("/bin/sh", ["-c", "yes 0123456789 | head -c 40000000"])
        return yield* proc.exitCode
      }).pipe(Effect.provide(ChildProcessSpawnerLive)),
    )
    expect(code).toBe(0)
  }, 30_000)

  it("gives the exit code to a reader that stops after the first line", async () => {
    const [first, code] = await Effect.runPromise(
      Effect.gen(function* () {
        const spawner = yield* ProcessSpawner
        const proc = yield* spawner.spawn("/bin/sh", ["-c", "yes 0123456789 | head -c 40000000"])
        const taken = yield* Stream.runCollect(Stream.take(proc.output, 1))
        return [[...taken][0]?.line, yield* proc.exitCode] as const
      }).pipe(Effect.provide(ChildProcessSpawnerLive)),
    )
    expect(first).toBe("0123456789")
    expect(code).toBe(0)
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
