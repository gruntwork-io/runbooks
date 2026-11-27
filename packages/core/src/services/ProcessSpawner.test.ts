import { describe, it, expect } from "bun:test"
import { Cause, Effect, Fiber, Stream } from "effect"
import { collectOutput, linesCut, wholeLines } from "./ProcessSpawner.ts"
import type { OutputLine, SpawnedProcess } from "./ProcessSpawner.ts"

/** A fake child whose output/exit are supplied by the test; counts kills. */
const fakeProcess = (output: Stream.Stream<OutputLine>, exitCode: Effect.Effect<number>) => {
  let kills = 0
  const proc: SpawnedProcess = {
    output,
    exitCode,
    kill: Effect.sync(() => {
      kills++
    }),
  }
  return { proc, kills: () => kills }
}

describe("wholeLines", () => {
  it("joins each line's pieces, per source, without a line break between them", async () => {
    const pieces: OutputLine[] = [
      { line: "ab", source: "stdout", continues: true },
      { line: "warn", source: "stderr", continues: true },
      { line: "cd", source: "stdout", continues: true },
      { line: "ing", source: "stderr" },
      { line: "ef", source: "stdout" },
      { line: "g", source: "stdout" },
    ]
    const lines = await Effect.runPromise(
      Stream.runCollect(wholeLines(Stream.fromIterable(pieces))),
    )
    expect([...lines]).toEqual([
      { line: "warning", source: "stderr" },
      { line: "abcdef", source: "stdout" },
      { line: "g", source: "stdout" },
    ])
  })
})

describe("linesCut", () => {
  it("joins each line's pieces per source, keeps no more of one than it may, and counts the rest", async () => {
    const pieces: OutputLine[] = [
      { line: "abc", source: "stdout", continues: true },
      { line: "short", source: "stderr" },
      { line: "defgh", source: "stdout", continues: true },
      { line: "ij", source: "stdout" },
      { line: "whole", source: "stdout" },
      { line: "toolong", source: "stderr" },
      { line: "half", source: "stdout", continues: true },
    ]
    const lines = await Effect.runPromise(
      Stream.runCollect(linesCut(Stream.fromIterable(pieces), 5)),
    )
    expect([...lines]).toEqual([
      { line: "short", source: "stderr", cut: 0 },
      { line: "abcde", source: "stdout", cut: 5 },
      { line: "whole", source: "stdout", cut: 0 },
      { line: "toolo", source: "stderr", cut: 2 },
      // Output that ended mid-line.
      { line: "half", source: "stdout", cut: 0 },
    ])
  })
})

describe("collectOutput", () => {
  it("returns every line in arrival order with its source, plus the exit code", async () => {
    const lines: OutputLine[] = [
      { line: "one", source: "stdout" },
      { line: "warn", source: "stderr" },
      { line: "two", source: "stdout" },
    ]
    const { proc, kills } = fakeProcess(Stream.fromIterable(lines), Effect.succeed(3))
    const result = await Effect.runPromise(collectOutput(proc, 1_000))
    expect(result).toEqual({ exitCode: 3, lines })
    // Killed even on success: a CLI that closed its pipes but lingers is reaped.
    expect(kills()).toBe(1)
  })

  it("times out and kills a process whose output never ends", async () => {
    const { proc, kills } = fakeProcess(Stream.never, Effect.succeed(0))
    const result = await Effect.runPromise(Effect.result(collectOutput(proc, 20)))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(Cause.isTimeoutError(result.failure)).toBe(true)
    expect(kills()).toBe(1)
  })

  it("times out and kills a process that never exits after closing its output", async () => {
    const { proc, kills } = fakeProcess(
      Stream.fromIterable<OutputLine>([{ line: "done", source: "stdout" }]),
      Effect.never,
    )
    const result = await Effect.runPromise(Effect.result(collectOutput(proc, 20)))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(Cause.isTimeoutError(result.failure)).toBe(true)
    expect(kills()).toBe(1)
  })

  it("kills the process when the reader is interrupted", async () => {
    const { proc, kills } = fakeProcess(Stream.never, Effect.never)
    const fiber = Effect.runFork(collectOutput(proc, 60_000))
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(kills()).toBe(1)
  })
})
