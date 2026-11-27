import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import { TestReport } from "./contract.ts"
import { tempFolder } from "./test-utils/runCliForTest.ts"

// The `runbooks` binary as a person runs it, over the registry it ships
// with and the Node layers: `runbooks test` runs a runbook's scripts with no
// window. It gets PATH from this process's environment and nothing else, a
// home folder of its own, and no bun cache, so the test sees what it writes.
//
// The fixture is Command's end-to-end runbook. Each of its steps checks
// something Command promises (outputs, envFrom, env values, the run's
// folder, the log helpers, a failing exit code), so a Command that breaks
// one fails this test.

const MAIN = path.join(import.meta.dirname, "main.ts")
const FIXTURE = path.resolve(import.meta.dirname, "../../../blocks/command/testdata/end-to-end")

let folder: ReturnType<typeof tempFolder>

beforeEach(() => {
  folder = tempFolder()
})

afterEach(() => {
  folder.remove()
})

describe("runbooks test", () => {
  /** Runs `runbooks test` on a copy of the fixture, its test file `testFile` if given. */
  const runTest = (testFile?: string) => {
    const runbook = path.join(folder.path, "end-to-end")
    const home = path.join(folder.path, "home")
    cpSync(FIXTURE, runbook, { recursive: true })
    if (testFile !== undefined) writeFileSync(path.join(runbook, "runbook_test.yml"), testFile)
    mkdirSync(home)
    const ran = spawnSync(process.execPath, [MAIN, "test", runbook], {
      env: { PATH: process.env["PATH"], HOME: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
      encoding: "utf8",
      timeout: 60_000,
    })
    return { ran, runbook, home }
  }

  it("runs a runbook's scripts with no window, from a copy of it, and exits 0 when its tests pass", () => {
    const { ran, runbook, home } = runTest()
    expect(ran.stdout).toContain("✓ end-to-end")
    expect(ran.stdout).toContain("Results: 1 passed, 0 failed, 0 skipped")
    expect(ran.status).toBe(0)
    // The scripts ran in the run's folder: nothing was written beside the runbook.
    expect(readdirSync(runbook).sort()).toEqual(["runbook.mdx", "runbook_test.yml", "scripts"])
    expect(readdirSync(home)).toEqual([])
  })

  it("exits 1 when a test fails, saying which step", () => {
    const { ran } = runTest(
      "version: 1\ntests:\n  - name: wrong\n    steps:\n      - block: fails\n        expect: success\n",
    )
    expect(ran.stdout).toContain("✗ wrong")
    expect(ran.stdout).toContain("fails")
    expect(ran.stdout).toContain("Results: 0 passed, 1 failed, 0 skipped")
    expect(ran.status).toBe(1)
  })
})

// Stopping `runbooks test` with signals, as a person at a terminal and a CI
// runner do. The fixture's one block runs a script that starts two sleeps in
// its process group and writes its own pid and theirs to a file, so the test
// can tell whether any of them outlived the CLI.
describe("stopping runbooks test", () => {
  const STOP_FIXTURE = path.resolve(import.meta.dirname, "../../../blocks/command/testdata/stop")
  /** How long a stopped script has to end before it is killed: the spawner's grace. */
  const STOP_GRACE_MILLIS = 5_000

  interface Run {
    readonly cli: ChildProcess
    readonly pids: () => ReadonlyArray<number>
    readonly stdout: () => string
    readonly stderr: () => string
    /** How the CLI ended, once it has. */
    readonly ended: () =>
      | { readonly code: number | null; readonly signal: string | null }
      | undefined
  }

  let run: Run | undefined

  afterEach(() => {
    // A failed test may leave the CLI or the script's processes running.
    if (run !== undefined) {
      if (run.ended() === undefined) run.cli.kill("SIGKILL")
      for (const pid of run.pids().filter(alive)) process.kill(pid, "SIGKILL")
      run = undefined
    }
  })

  /** Whether `pid` is a live process: a zombie waiting to be reaped has ended. */
  function alive(pid: number): boolean {
    const ps = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" })
    const stat = ps.stdout.trim()
    return stat !== "" && !stat.startsWith("Z")
  }

  /** Polls `check` until it holds, and fails the test after `millis`. */
  async function eventually(what: string, millis: number, check: () => boolean): Promise<void> {
    const deadline = Date.now() + millis
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`Gave up after ${millis} ms waiting for ${what}.`)
      await Bun.sleep(20)
    }
  }

  /**
   * Starts `runbooks test --output json` on the runbook, and returns once
   * its script and the processes it starts are running. `stop` says what
   * SIGTERM does to them, as `scripts/sleeps.sh` describes.
   */
  async function start(stop: "ends" | "ignored" | "outlived"): Promise<Run> {
    const runbook = path.join(folder.path, "stop")
    const pidsFile = path.join(folder.path, "pids")
    const home = path.join(folder.path, "home")
    const tmp = path.join(folder.path, "tmp")
    cpSync(STOP_FIXTURE, runbook, { recursive: true })
    mkdirSync(home)
    mkdirSync(tmp)
    let stdout = ""
    let stderr = ""
    let ended: ReturnType<Run["ended"]>
    const cli = spawn(process.execPath, [MAIN, "test", runbook, "--output", "json"], {
      env: {
        PATH: process.env["PATH"],
        HOME: home,
        TMPDIR: tmp,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        SLEEPS_PIDS_FILE: pidsFile,
        ...(stop === "ignored" ? { SLEEPS_IGNORE_STOP: "1" } : {}),
        ...(stop === "outlived" ? { SLEEPS_CLEANED_FILE: path.join(folder.path, "cleaned") } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    cli.stdout!.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk))
    cli.stderr!.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk))
    cli.on("close", (code, signal) => (ended = { code, signal }))
    const readPids = () =>
      existsSync(pidsFile)
        ? readFileSync(pidsFile, "utf8").split("\n").filter(Boolean).map(Number)
        : []
    run = {
      cli,
      pids: readPids,
      stdout: () => stdout,
      stderr: () => stderr,
      ended: () => ended,
    }
    await eventually("the script and its processes to start", 30_000, () => {
      if (ended !== undefined) throw new Error(`runbooks test ended first:\n${stderr}`)
      return readPids().length === (stop === "outlived" ? 4 : 3)
    })
    return run
  }

  /** Waits for the CLI to exit, then for every process its script started to end. */
  async function finish(r: Run) {
    await eventually("runbooks test to exit", 30_000, () => r.ended() !== undefined)
    const exitedAt = Date.now()
    // Each was sent SIGKILL by the time the CLI exited, if not before, so
    // this only waits for the kernel to finish them. One left running is
    // asleep for minutes.
    await eventually("the script's processes to end", 5_000, () => !r.pids().some(alive)).catch(
      () => undefined,
    )
    return { ...r.ended()!, exitedAt, survivors: r.pids().filter(alive) }
  }

  const reportOf = (r: Run) => Schema.decodeUnknownSync(TestReport)(JSON.parse(r.stdout()))

  /** Whether the report has been written in full. */
  const reported = (r: Run) => {
    try {
      reportOf(r)
      return true
    } catch {
      return false
    }
  }

  it("stops on Ctrl-C: cancels the running block, ends its processes, and exits 1", async () => {
    const r = await start("ends")
    r.cli.kill("SIGINT")
    const { code, survivors } = await finish(r)
    expect(survivors).toEqual([])
    expect(code).toBe(1)
    expect(r.stderr()).toContain("the running block was cancelled, and nothing after it ran")
    expect(reportOf(r).failure).toEqual({ _tag: "Cancelled" })
  }, 60_000)

  it("stops on SIGTERM as on Ctrl-C", async () => {
    const r = await start("ends")
    r.cli.kill("SIGTERM")
    const { code, survivors } = await finish(r)
    expect(survivors).toEqual([])
    expect(code).toBe(1)
    expect(r.stderr()).toContain("the running block was cancelled, and nothing after it ran")
    expect(reportOf(r).failure).toEqual({ _tag: "Cancelled" })
  }, 60_000)

  it("kills a script that ignores the stop once its grace is over, then exits 1", async () => {
    const r = await start("ignored")
    r.cli.kill("SIGINT")
    const { code, survivors } = await finish(r)
    expect(survivors).toEqual([])
    expect(code).toBe(1)
    expect(reportOf(r).failure).toEqual({ _tag: "Cancelled" })
  }, 60_000)

  it("gives processes that outlive the stopped script their grace, then kills what is left", async () => {
    const r = await start("outlived")
    const cleanedFile = path.join(folder.path, "cleaned")
    r.cli.kill("SIGINT")
    await eventually("runbooks test to exit", 30_000, () => r.ended() !== undefined)
    // The one that cleans up on SIGTERM had the time to before the CLI exited.
    expect(existsSync(cleanedFile) ? readFileSync(cleanedFile, "utf8") : "").toBe("cleaned\n")
    const { code, survivors } = await finish(r)
    expect(survivors).toEqual([])
    expect(code).toBe(1)
  }, 60_000)

  it("ends the grace on a second Ctrl-C after the script has ended, killing the processes that outlived it", async () => {
    const r = await start("outlived")
    const stopped = Date.now()
    r.cli.kill("SIGINT")
    const script = r.pids()[0]!
    await eventually("the script to end", 10_000, () => !alive(script))
    r.cli.kill("SIGINT")
    const { code, exitedAt, survivors } = await finish(r)
    expect(exitedAt - stopped).toBeLessThan(STOP_GRACE_MILLIS)
    expect(survivors).toEqual([])
    // The report comes once the stop has ended, so there is none.
    expect(reported(r)).toBe(false)
    expect(code).toBe(130)
  }, 60_000)

  for (const [second, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)
    it(`ends the grace on ${second} during the stop: kills the script's processes at once, and exits ${code} with no report`, async () => {
      const r = await start("ignored")
      const stopped = Date.now()
      r.cli.kill("SIGINT")
      // The CLI waits out the grace of a script that ignores the stop.
      await eventually("the stop", 30_000, () => r.stderr().includes("Stopping:"))
      r.cli.kill(second)
      const ended = await finish(r)
      expect(ended.survivors).toEqual([])
      expect(ended.exitedAt - stopped).toBeLessThan(STOP_GRACE_MILLIS)
      expect(r.stderr()).toContain("Stopped at once")
      expect(r.stdout()).toBe("")
      expect(ended.code).toBe(code)
    }, 60_000)
})
