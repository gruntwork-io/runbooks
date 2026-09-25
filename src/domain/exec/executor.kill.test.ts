/**
 * End-to-end cancellation test for a long-running script block.
 *
 * Unlike executor.test.ts (which stubs the spawner), this drives the REAL layer
 * stack — NodeFileSystem + ProcessEnvironment + ChildProcessSpawner — exactly as
 * the exec:run IPC handler does: an `Effect.scoped` program that spawns the
 * process and drains its output. We then interrupt the fiber, which is precisely
 * what `exec:cancel` does when it aborts the run's AbortController (the signal is
 * wired into runPromise, and aborting interrupts the fiber). Interruption closes
 * the scope, which runs the `process.kill` finalizer.
 *
 * The script spawns a long-lived *grandchild* (`sleep`) in the background and
 * records its PID. The wrapper bash process is the spawner's direct child; the
 * sleeper is its child. Crucially, the wrapper traps EXIT but not SIGTERM, so on
 * termination bash dies WITHOUT reaping its background job. The grandchild
 * therefore survives unless the whole process group is signaled. Asserting the
 * grandchild is dead is what proves the process-group kill works — killing only
 * the direct child (the old `proc.kill()` behavior) would leave it orphaned and
 * running, which is the real-world failure where terragrunt/tofu kept running
 * after "Stop".
 *
 * The same stack also covers the other two ways a run ends: `timeoutMs` must
 * kill a script that is still running, and a script that finishes on its own
 * must NOT take down background jobs it deliberately left running.
 */
import { describe, it, expect, afterEach } from "bun:test"
import { Effect, Fiber, Layer, Stream } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { executeScript, type ExecEvent } from "./executor.ts"
import type { ExecRequest } from "../../types.ts"
import { NodeFileSystemLive } from "../../layers/NodeFileSystem.ts"
import { ProcessEnvironmentLive } from "../../layers/ProcessEnvironment.ts"
import { ChildProcessSpawnerLive } from "../../layers/ChildProcessSpawner.ts"

const liveLayer = Layer.mergeAll(
  NodeFileSystemLive,
  ProcessEnvironmentLive,
  ChildProcessSpawnerLive,
)

/** True if a process with `pid` is still alive (signal 0 = existence probe). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // ESRCH → gone. EPERM → exists but owned by another user (still "alive").
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** Poll `pred` until it's true or the deadline passes. */
async function waitUntil(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return pred()
}

describe("executeScript cancellation (e2e, real process tree)", () => {
  let grandchildPid: number | null = null
  let pidFile: string | null = null

  afterEach(() => {
    // Safety net: never leak a real `sleep` if an assertion failed mid-test.
    if (grandchildPid !== null && isAlive(grandchildPid)) {
      try {
        process.kill(grandchildPid, "SIGKILL")
      } catch {
        /* already gone */
      }
    }
    if (pidFile && fs.existsSync(pidFile)) {
      try {
        fs.rmSync(pidFile)
      } catch {
        /* best effort */
      }
    }
    grandchildPid = null
    pidFile = null
  })

  it(
    "interrupting a running block kills the whole process group, not just the direct child",
    async () => {
      pidFile = path.join(
        os.tmpdir(),
        `runbook-killtest-${process.pid}-${Math.random().toString(36).slice(2)}.pid`,
      )

      // Background a long-lived grandchild, record its PID, then block forever so
      // the "block" stays running until we cancel it.
      const script = [
        "sleep 600 &",
        `echo $! > '${pidFile}'`,
        "wait",
        "",
      ].join("\n")

      const program = Effect.scoped(
        Effect.gen(function* () {
          const { logStream, completionEffect } = yield* executeScript(
            script,
            "bash",
            {},
            { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, workDir: os.tmpdir() },
            "",
            "",
          )
          // Draining the log stream parks the fiber while the process runs —
          // this is the interruptible point cancellation acts on.
          yield* Stream.runForEach(logStream, () => Effect.void)
          yield* completionEffect
        }),
      ).pipe(Effect.provide(liveLayer))

      const fiber = Effect.runFork(program)

      // Wait for the grandchild to come up and publish its PID.
      const started = await waitUntil(
        () => fs.existsSync(pidFile!) && fs.readFileSync(pidFile!, "utf8").trim() !== "",
        8000,
      )
      expect(started).toBe(true)

      grandchildPid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10)
      expect(Number.isInteger(grandchildPid)).toBe(true)
      expect(grandchildPid).toBeGreaterThan(0)
      expect(isAlive(grandchildPid)).toBe(true)

      // Cancel: interrupting the fiber mirrors exec:cancel aborting the signal.
      // This awaits the scope's finalizers, so the kill has been issued on return.
      await Effect.runPromise(Fiber.interrupt(fiber))

      // The grandchild must die. SIGTERM to the group is enough for `sleep`; the
      // generous window also covers the SIGKILL escalation path.
      const died = await waitUntil(() => !isAlive(grandchildPid!), 10000)
      expect(died).toBe(true)
    },
    20000,
  )
})

/**
 * Run a block to completion the way exec:run does: drain the log stream, then
 * run completionEffect, inside one scope that closes before this returns.
 * `pauseBeforeCompletionMs` holds the fiber between the two phases, standing in
 * for slow completion processing.
 */
async function runToCompletion(
  script: string,
  request: ExecRequest,
  pauseBeforeCompletionMs = 0,
): Promise<{ events: ExecEvent[]; elapsedMs: number }> {
  const startedAt = Date.now()
  const events = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { logStream, completionEffect } = yield* executeScript(
          script,
          "bash",
          request,
          { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, workDir: os.tmpdir() },
          "",
          "",
        )
        const logs = Array.from(yield* Stream.runCollect(logStream))
        if (pauseBeforeCompletionMs > 0) yield* Effect.sleep(pauseBeforeCompletionMs)
        const completion = yield* completionEffect
        return [...logs, ...completion]
      }),
    ).pipe(Effect.provide(liveLayer)),
  )
  return { events, elapsedMs: Date.now() - startedAt }
}

const statusOf = (events: ExecEvent[]) =>
  events.find((e): e is Extract<ExecEvent, { _tag: "status" }> => e._tag === "status")?.event

const logLines = (events: ExecEvent[]) =>
  events.flatMap((e) => (e._tag === "log" ? [e.event.line] : []))

describe("executeScript timeoutMs (e2e, real process)", () => {
  it(
    "kills a script that outlives timeoutMs and reports it as failed",
    async () => {
      const { events, elapsedMs } = await runToCompletion(
        "echo start\nsleep 10\necho end\n",
        { timeoutMs: 300 },
      )

      expect(statusOf(events)).toEqual({ status: "fail", exitCode: -1 })
      const lines = logLines(events)
      expect(lines).toContain("start")
      expect(lines).not.toContain("end")
      expect(lines.some((l) => l.includes("timed out"))).toBe(true)
      // Well short of the 10 s the script would otherwise run for.
      expect(elapsedMs).toBeLessThan(5000)
    },
    20000,
  )

  it(
    "times out a script whose background job keeps stdout open",
    async () => {
      // bash exits right after the echo, but the backgrounded sleep inherits
      // stdout, so the output stream stays open until something kills it.
      const { events, elapsedMs } = await runToCompletion("sleep 10 &\necho done\n", {
        timeoutMs: 300,
      })

      expect(statusOf(events)).toEqual({ status: "fail", exitCode: -1 })
      expect(elapsedMs).toBeLessThan(5000)
    },
    20000,
  )

  it(
    "does not flag a run that exited before the deadline",
    async () => {
      // Completion runs after the deadline has passed. The watchdog must have
      // stopped when the process closed instead of firing anyway.
      const { events } = await runToCompletion("echo hi\n", { timeoutMs: 1000 }, 1500)

      expect(statusOf(events)).toEqual({ status: "success", exitCode: 0 })
      expect(logLines(events).some((l) => l.includes("timed out"))).toBe(false)
    },
    20000,
  )
})

describe("executeScript success path (e2e, real process tree)", () => {
  let backgroundPid: number | null = null
  let pidFile: string | null = null

  afterEach(() => {
    if (backgroundPid !== null && isAlive(backgroundPid)) {
      try {
        process.kill(backgroundPid, "SIGKILL")
      } catch {
        /* already gone */
      }
    }
    if (pidFile) fs.rmSync(pidFile, { force: true })
    backgroundPid = null
    pidFile = null
  })

  it(
    "leaves background jobs a finished script started running",
    async () => {
      pidFile = path.join(
        os.tmpdir(),
        `runbook-bgtest-${process.pid}-${Math.random().toString(36).slice(2)}.pid`,
      )
      // The pattern for starting a port-forward or dev server for later blocks:
      // background it with its output redirected so the block can finish.
      const script = [
        "nohup sleep 60 >/dev/null 2>&1 &",
        `echo $! > '${pidFile}'`,
        "",
      ].join("\n")

      const { events } = await runToCompletion(script, {})
      expect(statusOf(events)).toEqual({ status: "success", exitCode: 0 })

      backgroundPid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10)
      expect(backgroundPid).toBeGreaterThan(0)

      // The scope has closed. Wait past the 5 s SIGKILL escalation a group kill
      // would have scheduled, then check the job is still running.
      await new Promise((r) => setTimeout(r, 6000))
      expect(isAlive(backgroundPid)).toBe(true)
    },
    20000,
  )
})
