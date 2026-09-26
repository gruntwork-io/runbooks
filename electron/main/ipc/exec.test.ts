/**
 * cancelAllExecutions is what will-quit calls to stop running scripts. Scripts
 * run in their own process group, so nothing else signals them when the app
 * exits. This drives the real exec:run handler on the real runtime (only
 * electron's `ipcMain` is faked) and checks that, by the time
 * cancelAllExecutions resolves, the run has been interrupted and its whole
 * process group has been sent SIGTERM, so quit can go on to exit.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, spyOn } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { mockElectron } from "../test-utils/mock-electron.ts"

type Handler = (event: unknown, params?: unknown) => Promise<unknown>
const handlers = new Map<string, Handler>()
mockElectron({
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      handlers.set(channel, handler)
    },
  },
})

const { registerExecHandlers, cancelAllExecutions } = await import("./exec.ts")
const { runtime, sessionManager, setExecutableRegistry } = await import("./runtime.ts")
const { ExecutableRegistry } = await import("../../../src/domain/registry/executable.ts")

/** True if a process with `pid` is still alive (signal 0 = existence probe). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
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

describe("cancelAllExecutions", () => {
  let tmpDir = ""
  let pidFile = ""
  let executableId = ""
  const grandchildPids: number[] = []
  let killSpy: ReturnType<typeof spyOn<typeof process, "kill">> | null = null

  beforeAll(async () => {
    registerExecHandlers()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-exec-quit-"))
    await runtime.runPromise(sessionManager.createSession(tmpDir))
    pidFile = path.join(tmpDir, "pids")
    // Record the group leader ($$) and a backgrounded grandchild, then block.
    fs.writeFileSync(
      path.join(tmpDir, "long.sh"),
      ["sleep 600 &", `echo "$$ $!" > '${pidFile}'`, "wait", ""].join("\n"),
    )
    const registry = new ExecutableRegistry()
    await runtime.runPromise(
      registry.parseAndRegister(
        path.join(tmpDir, "runbook.mdx"),
        `<Command id="long" path="long.sh" />\n`,
      ),
    )
    setExecutableRegistry(registry)
    ;[executableId] = Object.keys(registry.getAllExecutables())
  })

  afterEach(() => {
    killSpy?.mockRestore()
    killSpy = null
    for (const pid of grandchildPids.splice(0)) {
      if (!isAlive(pid)) continue
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        /* already gone */
      }
    }
    fs.rmSync(pidFile, { force: true })
  })

  afterAll(() => {
    setExecutableRegistry(null)
    fs.rmSync(tmpDir, { recursive: true, force: true })
    // Don't dispose `runtime`: it's a module singleton shared with every other
    // test file in this bun process, and a disposed ManagedRuntime fails every
    // later runPromise with "ManagedRuntime disposed".
  })

  /** Start long.sh via exec:run and wait until it has recorded its pids. */
  async function startLongRun(executionId: string) {
    fs.rmSync(pidFile, { force: true })
    const run = handlers.get("exec:run")!({ sender: { send: () => {} } }, { executableId, executionId })
    const started = await waitUntil(
      () => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim().split(" ").length === 2,
      8000,
    )
    expect(started).toBe(true)
    const [leaderPid, childPid] = fs.readFileSync(pidFile, "utf8").trim().split(" ").map(Number)
    grandchildPids.push(childPid)
    expect(isAlive(childPid)).toBe(true)
    return { run, leaderPid, childPid }
  }

  it("resolves only after every running script's process group has been signalled", async () => {
    const { run, leaderPid, childPid } = await startLongRun("quit-test")

    killSpy = spyOn(process, "kill")
    await cancelAllExecutions()

    // Quit exits right after this resolves, so the SIGTERM must already be out.
    expect(killSpy).toHaveBeenCalledWith(-leaderPid, "SIGTERM")
    expect(await run).toEqual({ status: null, cancelled: true })
    expect(await waitUntil(() => !isAlive(childPid), 10000)).toBe(true)
  }, 20000)

  it("still cancels a run that reused the id of the run it replaced", async () => {
    // Renderer execution ids restart after a reload, so a new run can arrive
    // under the id of one that is still running. exec:run cancels the old run;
    // its cleanup must not remove the new run's entry.
    const first = await startLongRun("1")
    const second = await startLongRun("1")
    expect(await first.run).toEqual({ status: null, cancelled: true })

    killSpy = spyOn(process, "kill")
    await cancelAllExecutions()

    expect(killSpy).toHaveBeenCalledWith(-second.leaderPid, "SIGTERM")
    expect(await second.run).toEqual({ status: null, cancelled: true })
    expect(await waitUntil(() => !isAlive(second.childPid), 10000)).toBe(true)
  }, 30000)
})
