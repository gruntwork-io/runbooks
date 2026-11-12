/**
 * How a block's Terragrunt run ends: with its output, with its errors, or,
 * when it's stopped, only once Terragrunt has exited. Runs a stand-in
 * `terragrunt` script through the real process spawner.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect, Exit, Fiber } from "effect"
import { ChildProcessSpawnerLive } from "../../layers/ChildProcessSpawner.ts"
import type { RunEvent } from "./run.ts"
import { runTerragrunt } from "./terragrunt.ts"

let bin: string
let env: Record<string, string>

/** Installs a `terragrunt` that runs `script` with bash. */
const stub = (script: string) => {
  fs.writeFileSync(path.join(bin, "terragrunt"), `#!/usr/bin/env bash\n${script}\n`, {
    mode: 0o755,
  })
}

beforeAll(() => {
  bin = fs.mkdtempSync(path.join(os.tmpdir(), "terragrunt-stub-"))
  env = { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` }
})
afterAll(() => fs.rmSync(bin, { recursive: true, force: true }))

const run = (onLog?: (event: RunEvent) => void) =>
  runTerragrunt(["plan"], { cwd: bin, env, ...(onLog ? { onLog } : {}) }).pipe(
    Effect.provide(ChildProcessSpawnerLive),
  )

const lines = (events: RunEvent[]) =>
  events.flatMap((event) => (event.kind === "log" ? [event.line] : []))

describe("runTerragrunt", () => {
  it("returns stdout when Terragrunt succeeds", async () => {
    stub('echo "{\\"ok\\": true}"')
    expect(await Effect.runPromise(run())).toBe('{"ok": true}\n')
  })

  it("fails with Terragrunt's last error lines", async () => {
    stub('echo "12:00:00.000 ERROR  No such unit" >&2; exit 1')
    const exit = await Effect.runPromiseExit(run())
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("No such unit")
  })

  it("fails when a signal kills Terragrunt", async () => {
    stub("kill -9 $$")
    const exit = await Effect.runPromiseExit(run())
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("exited with code")
  })

  it("when stopped, settles only after Terragrunt exits, keeping what it wrote meanwhile", async () => {
    const pidFile = path.join(bin, "pid")
    stub(
      [
        `echo $$ > ${pidFile}`,
        `trap 'sleep 0.3; echo "12:00:00.000 INFO   Released the state lock" >&2; exit 1' TERM`,
        'echo "12:00:00.000 INFO   Applying" >&2',
        "sleep 30 &",
        "wait",
      ].join("\n"),
    )
    const events: RunEvent[] = []
    const fiber = Effect.runFork(run((event) => events.push(event)))
    for (let i = 0; i < 100 && !lines(events).includes("Applying"); i++) {
      await Bun.sleep(50)
    }
    expect(lines(events)).toContain("Applying")

    await Effect.runPromise(Fiber.interrupt(fiber))

    expect(lines(events)).toContain("Released the state lock")
    const pid = Number(fs.readFileSync(pidFile, "utf8"))
    expect(() => process.kill(pid, 0)).toThrow()
  })
})
