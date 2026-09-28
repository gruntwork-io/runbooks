import { describe, it, expect } from "bun:test"
import { Cause, Effect, Fiber, Stream } from "effect"
import { collectOutput } from "./ProcessSpawner.ts"
import type { OutputLine, SpawnedProcess } from "./ProcessSpawner.ts"

/** A fake child whose output/exit are supplied by the test; counts kills. */
const fakeProcess = (
  output: Stream.Stream<OutputLine>,
  exitCode: Effect.Effect<number>,
) => {
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
    const result = await Effect.runPromise(Effect.either(collectOutput(proc, 20)))
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") expect(Cause.isTimeoutException(result.left)).toBe(true)
    expect(kills()).toBe(1)
  })

  it("times out and kills a process that never exits after closing its output", async () => {
    const { proc, kills } = fakeProcess(Stream.fromIterable<OutputLine>([{ line: "done", source: "stdout" }]), Effect.never)
    const result = await Effect.runPromise(Effect.either(collectOutput(proc, 20)))
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") expect(Cause.isTimeoutException(result.left)).toBe(true)
    expect(kills()).toBe(1)
  })

  it("kills the process when the reader is interrupted", async () => {
    const { proc, kills } = fakeProcess(Stream.never, Effect.never)
    const fiber = Effect.runFork(collectOutput(proc, 60_000))
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(kills()).toBe(1)
  })
})
