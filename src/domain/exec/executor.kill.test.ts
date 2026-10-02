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
 * must NOT take down background jobs it deliberately left running. It also
 * checks that lines written to the log files reach the log stream while the
 * script runs, in order, and all of them before the status event, and that a
 * background job can keep logging once the run has ended.
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
  } catch (err) {
    // ESRCH → gone. EPERM → exists but owned by another user (still "alive").
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
  // A killed job whose parent has exited stays a zombie until init reaps it,
  // which some container inits take a second or more to do. It has exited, so
  // count it as dead. No procfs (macOS): the signal-0 probe is the answer.
  if (process.platform !== "linux") return true
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
    return stat[stat.lastIndexOf(")") + 2] !== "Z"
  } catch {
    return false // reaped since the probe above
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

  it("interrupting a running block kills the whole process group, not just the direct child", async () => {
    pidFile = path.join(
      os.tmpdir(),
      `runbook-killtest-${process.pid}-${Math.random().toString(36).slice(2)}.pid`,
    )

    // Background a long-lived grandchild, record its PID, then block forever so
    // the "block" stays running until we cancel it.
    const script = ["sleep 600 &", `echo $! > '${pidFile}'`, "wait", ""].join("\n")

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
  }, 20000)
})

/**
 * Run a block to completion the way exec:run does: drain the log stream, then
 * run completionEffect, inside one scope that closes before this returns.
 * `pauseBeforeCompletionMs` holds the fiber between the two phases, standing in
 * for slow completion processing. `blockAfterSpawnMs` blocks the event loop
 * right after the spawn, standing in for a busy main process that reads
 * nothing from the child meanwhile. `onLogLine` sees each log line as it
 * arrives.
 */
async function runToCompletion(
  script: string,
  request: ExecRequest,
  pauseBeforeCompletionMs = 0,
  {
    language = "bash",
    blockAfterSpawnMs = 0,
    onLogLine,
  }: { language?: string; blockAfterSpawnMs?: number; onLogLine?: (line: string) => void } = {},
): Promise<{ events: ExecEvent[]; elapsedMs: number; logFilePath: string }> {
  const startedAt = Date.now()
  const { events, logFilePath } = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { logStream, completionEffect, logFilePath } = yield* executeScript(
          script,
          language,
          request,
          { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, workDir: os.tmpdir() },
          "",
          "",
        )
        const blockUntil = Date.now() + blockAfterSpawnMs
        while (Date.now() < blockUntil) {
          // Busy-wait: nothing else on the event loop runs until this ends.
        }
        const logs: ExecEvent[] = []
        yield* Stream.runForEach(logStream, (event) =>
          Effect.sync(() => {
            logs.push(event)
            onLogLine?.(event.event.line)
          }),
        )
        if (pauseBeforeCompletionMs > 0) yield* Effect.sleep(pauseBeforeCompletionMs)
        const completion = yield* completionEffect
        return { events: [...logs, ...completion], logFilePath }
      }),
    ).pipe(Effect.provide(liveLayer)),
  )
  return { events, elapsedMs: Date.now() - startedAt, logFilePath }
}

const statusOf = (events: ExecEvent[]) =>
  events.find((e): e is Extract<ExecEvent, { _tag: "status" }> => e._tag === "status")?.event

const logLines = (events: ExecEvent[]) =>
  events.flatMap((e) => (e._tag === "log" ? [e.event.line] : []))

describe("executeScript timeoutMs (e2e, real process)", () => {
  it("kills a script that outlives timeoutMs and reports it as failed", async () => {
    // The deadline leaves bash ample time to print "start" even on a loaded
    // machine, so the log assertion can't race the kill.
    const { events, elapsedMs } = await runToCompletion("echo start\nsleep 10\necho end\n", {
      timeoutMs: 2000,
    })

    expect(statusOf(events)).toEqual({ status: "fail", exitCode: -1 })
    const lines = logLines(events)
    expect(lines).toContain("start")
    expect(lines).not.toContain("end")
    expect(lines.some((l) => l.includes("timed out"))).toBe(true)
    // Well short of the 10 s the script would otherwise run for, and of the
    // 2 s + 5 s SIGKILL escalation, so SIGTERM is what stopped it.
    expect(elapsedMs).toBeLessThan(6000)
  }, 20000)

  it("writes the timeout notice to the log file, after the script's output", async () => {
    // The log file is what "Copy log file path" and "Copy prompt for LLM"
    // hand out, so it has to say why the output stops, as the UI does.
    const logFilePath = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const run = yield* executeScript(
            "echo start\nsleep 10\n",
            "bash",
            { timeoutMs: 2000 },
            { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, workDir: os.tmpdir() },
            "",
            "",
          )
          yield* Stream.runDrain(run.logStream)
          yield* run.completionEffect
          return run.logFilePath
        }),
      ).pipe(Effect.provide(liveLayer)),
    )

    try {
      const lines = fs.readFileSync(logFilePath, "utf8").trimEnd().split("\n")
      expect(lines[0]).toBe("start")
      expect(lines.at(-1)).toBe("Script execution timed out after 2 seconds")
    } finally {
      fs.rmSync(path.dirname(logFilePath), { recursive: true, force: true })
    }
  }, 20000)

  it("times out a script whose background job keeps stdout open", async () => {
    // bash exits right after the echo, but the backgrounded sleep inherits
    // stdout, so the output stream stays open until something kills it.
    const { events, elapsedMs } = await runToCompletion("sleep 10 &\necho done\n", {
      timeoutMs: 300,
    })

    expect(statusOf(events)).toEqual({ status: "fail", exitCode: -1 })
    expect(elapsedMs).toBeLessThan(5000)
  }, 20000)

  it("does not flag a run that exited before the deadline", async () => {
    // Completion runs after the deadline has passed. The watchdog must have
    // stopped when the process closed instead of firing anyway.
    const { events } = await runToCompletion("echo hi\n", { timeoutMs: 1000 }, 1500)

    expect(statusOf(events)).toEqual({ status: "success", exitCode: 0 })
    expect(logLines(events).some((l) => l.includes("timed out"))).toBe(false)
  }, 20000)
})

describe("executeScript log files (e2e, real process)", () => {
  // Log lines start with "[<ISO-8601 zulu timestamp>] ": the helpers write
  // one, and Runbooks adds one to a line written straight to a per-level
  // log file.
  const unstamped = (lines: string[]) =>
    lines.map((l) => l.replace(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\] /, ""))

  let dir: string | null = null
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  it("shows log file lines while the script runs, in order with its stdout", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "runbook-live-log-"))
    const marker = (name: string) => path.join(dir!, name)
    // The script waits until the test has seen a line before it goes on. A
    // line that only arrived once the script exited would stall it until
    // timeoutMs failed the run.
    const waitFor = (name: string) => `while [ ! -e '${marker(name)}' ]; do sleep 0.05; done`
    const script = [
      'log_info "first"',
      'echo "second"',
      waitFor("saw-second"),
      'log_warn "third"',
      waitFor("saw-third"),
      'echo "fourth"',
      "",
    ].join("\n")

    const { events } = await runToCompletion(script, { timeoutMs: 10000 }, 0, {
      onLogLine: (line) => {
        if (line === "second") fs.writeFileSync(marker("saw-second"), "")
        if (line.endsWith("[WARN]  third")) fs.writeFileSync(marker("saw-third"), "")
      },
    })

    expect(statusOf(events)).toEqual({ status: "success", exitCode: 0 })
    // "first" goes to a file and "second" down a pipe. The spawner reads
    // the log files whenever a pipe has data, before splitting it into
    // lines, so "first" still comes first.
    expect(unstamped(logLines(events))).toEqual([
      "[INFO]  first",
      "second",
      "[WARN]  third",
      "fourth",
    ])
  }, 20000)

  it("keeps the helpers' lines of different levels in the order the script wrote them", async () => {
    const script = [
      "DEBUG=true",
      'log_info "step 1: starting"',
      'log_error "step 1 failed"',
      'log_debug "retry 1"',
      'log_info "step 2: retrying"',
      'log_warn "step 2 slow"',
      'echo "retrying"',
      'log_info "step 3: done"',
      "",
    ].join("\n")

    // With the event loop blocked, the script has written every line before
    // the spawner reads any of them.
    const { events } = await runToCompletion(script, {}, 0, { blockAfterSpawnMs: 500 })

    expect(statusOf(events)).toEqual({ status: "success", exitCode: 0 })
    const shown = unstamped(logLines(events))
    expect(shown.filter((l) => l !== "retrying")).toEqual([
      "[INFO]  step 1: starting",
      "[ERROR] step 1 failed",
      "[DEBUG] retry 1",
      "[INFO]  step 2: retrying",
      "[WARN]  step 2 slow",
      "[INFO]  step 3: done",
    ])
    expect(shown).toContain("retrying")
  }, 20000)

  it("reads the log files to the end before the status event", async () => {
    const script = [
      "get_value() {",
      '  log_info "looking up"',
      "  echo value",
      "}",
      "v=$(get_value)",
      'echo "v=[$v]"',
      // More than one read's worth (64 KiB) in a single write.
      'seq 1 20000 | sed "s/^/bulk /" >> "$RUNBOOK_INFO_LOG"',
      'echo "straight to the file" >> "$RUNBOOK_ERROR_LOG"',
      'echo "[WARN] from a tool" >> "$RUNBOOK_LOG"',
      'echo "[INFO] not a helper line" >> "$RUNBOOK_ERROR_LOG"',
      "printf 'no newline at the end' >> \"$RUNBOOK_WARN_LOG\"",
      "",
    ].join("\n")

    // bash exits while the event loop is blocked, so nothing is read from
    // the log files before the process closes: the final read has to get
    // every line, including the last one that has no newline.
    const { events, logFilePath } = await runToCompletion(script, {}, 0, {
      blockAfterSpawnMs: 500,
    })

    try {
      expect(statusOf(events)).toEqual({ status: "success", exitCode: 0 })
      const lines = logLines(events)
      const shown = unstamped(lines)
      const bulk = shown.filter((l) => l.startsWith("[INFO]  bulk "))
      expect(bulk).toHaveLength(20000)
      expect(bulk.at(-1)).toBe("[INFO]  bulk 20000")
      expect(shown.filter((l) => !l.startsWith("[INFO]  bulk "))).toEqual(
        expect.arrayContaining([
          "[INFO]  looking up",
          "v=[value]",
          "[ERROR] straight to the file",
          // RUNBOOK_LOG's lines name their own level: shown as written.
          "[WARN] from a tool",
          "[ERROR] [INFO] not a helper line",
          "[WARN]  no newline at the end",
        ]),
      )
      // Every line came through the log stream, ahead of the status.
      const tags = events.map((e) => e._tag)
      expect(tags.lastIndexOf("log")).toBeLessThan(tags.indexOf("status"))

      // exec.log gets the same lines, in the same order.
      const written = () => fs.readFileSync(logFilePath, "utf8").split("\n").slice(0, -1)
      await waitUntil(() => written().length >= lines.length, 5000)
      expect(written()).toEqual(lines)
    } finally {
      fs.rmSync(path.dirname(logFilePath), { recursive: true, force: true })
    }
  }, 20000)

  it.skipIf(!Bun.which("python3"))(
    "gives a script in another language the same log files",
    async () => {
      const script = [
        "import os",
        'with open(os.environ["RUNBOOK_ERROR_LOG"], "a") as log:',
        '    print("from python", file=log)',
        'print("to stdout")',
        "",
      ].join("\n")

      const { events } = await runToCompletion(script, {}, 0, { language: "python3" })

      expect(statusOf(events)).toEqual({ status: "success", exitCode: 0 })
      expect(unstamped(logLines(events)).sort()).toEqual(["[ERROR] from python", "to stdout"])
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

  it("leaves background jobs a finished script started running", async () => {
    pidFile = path.join(
      os.tmpdir(),
      `runbook-bgtest-${process.pid}-${Math.random().toString(36).slice(2)}.pid`,
    )
    // The pattern for starting a port-forward or dev server for later blocks:
    // background it with its output redirected so the block can finish.
    const script = ["nohup sleep 60 >/dev/null 2>&1 &", `echo $! > '${pidFile}'`, ""].join("\n")

    const { events } = await runToCompletion(script, {})
    expect(statusOf(events)).toEqual({ status: "success", exitCode: 0 })

    backgroundPid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10)
    expect(backgroundPid).toBeGreaterThan(0)

    // The scope has closed, so a group kill would already have sent SIGTERM,
    // which ends `sleep` at once (the SIGKILL escalation only matters for a
    // job that ignores SIGTERM). Give that a moment to land, then check the
    // job is still running.
    await new Promise((r) => setTimeout(r, 1000))
    expect(isAlive(backgroundPid)).toBe(true)
  }, 20000)

  it("lets a background job keep logging after the run ends, to its own stderr", async () => {
    pidFile = path.join(
      os.tmpdir(),
      `runbook-bgtest-${process.pid}-${Math.random().toString(36).slice(2)}.pid`,
    )
    const outFile = `${pidFile}.out`
    // The job inherits set -e. Once the run ends, its log file is deleted,
    // so a log call that failed on the append would end the job.
    const script = [
      "set -euo pipefail",
      `( for i in $(seq 1 100); do log_info "heartbeat $i"; sleep 0.1; done ) > '${outFile}' 2>&1 &`,
      `echo $! > '${pidFile}'`,
      "",
    ].join("\n")

    try {
      const { events } = await runToCompletion(script, {})
      expect(statusOf(events)).toEqual({ status: "success", exitCode: 0 })

      backgroundPid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10)
      expect(backgroundPid).toBeGreaterThan(0)

      // The run's scope has closed, so the log files are gone. The job's
      // next log lines go to its stderr, and it keeps running.
      const out = () => (fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : "")
      await waitUntil(() => out().split("\n").filter(Boolean).length >= 3, 5000)
      expect(out()).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\] \[INFO\]  heartbeat \d+$/m)
      expect(out()).not.toContain("No such file")
      expect(isAlive(backgroundPid)).toBe(true)
    } finally {
      fs.rmSync(outFile, { force: true })
    }
  }, 20000)
})
