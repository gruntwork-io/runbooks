/**
 * The spawner against real processes: how a signal reads as an exit code.
 */
import { describe, expect, it } from "bun:test"
import { Effect, Stream } from "effect"
import { ProcessSpawner } from "@runbooks/core/services/ProcessSpawner"
import { ChildProcessSpawnerLive } from "../../layers/ChildProcessSpawner.ts"

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
})
