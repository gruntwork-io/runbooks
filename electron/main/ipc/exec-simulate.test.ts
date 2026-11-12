/**
 * In simulation mode, exec:run answers a block its scenario names from
 * simulation.yml instead of running the block's script, and runs every other
 * block for real. Drives the real exec:run handler on the real runtime; only
 * electron's `ipcMain` is faked.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test"
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

const { registerExecHandlers } = await import("./exec.ts")
const { enableSimulation, disableSimulation, registerSimulationHandlers } =
  await import("./simulation.ts")
const { runtime, sessionManager, setExecutableRegistry, setRunbookConfig } =
  await import("./runtime.ts")
const { ExecutableRegistry } = await import("../../../src/domain/registry/executable.ts")

const SIMULATION = `
scenarios:
  happy-path:
    scripts:
      ready:
        log: The account can be created.
        outputs:
          path: aws/accounts/greenfield-dev
  not-ready:
    extends: happy-path
    scripts:
      ready:
        status: fail
        log: The email doesn't match.
`

describe("exec:run in simulation mode", () => {
  let tmpDir = ""
  const ids: Record<string, string> = {}

  beforeAll(async () => {
    registerExecHandlers()
    registerSimulationHandlers()
    enableSimulation()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-exec-simulate-"))
    await runtime.runPromise(sessionManager.createSession(tmpDir))
    const runbook = path.join(tmpDir, "runbook.mdx")
    fs.writeFileSync(path.join(tmpDir, "simulation.yml"), SIMULATION)
    setRunbookConfig({ localPath: runbook, isWatchMode: false })
    const registry = new ExecutableRegistry()
    await runtime.runPromise(
      registry.parseAndRegister(
        runbook,
        [
          `<Check id="ready" command='echo "real run"; exit 1' />`,
          `<Command id="real" command='echo "who=real" >> "$RUNBOOK_OUTPUT"' />`,
          "",
        ].join("\n"),
      ),
    )
    setExecutableRegistry(registry)
    for (const [id, executable] of Object.entries(registry.getAllExecutables())) {
      ids[executable.componentId] = id
    }
  })

  afterAll(() => {
    disableSimulation()
    setRunbookConfig({ localPath: "", isWatchMode: false })
    setExecutableRegistry(null)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const run = (block: string) => {
    const lines: string[] = []
    const sender = {
      send: (channel: string, payload: { line?: string }) => {
        if (channel === "exec:log" && payload.line) lines.push(payload.line)
      },
    }
    return handlers.get("exec:run")!({ sender }, { executableId: ids[block] }).then((result) => ({
      result,
      lines,
    }))
  }

  it("answers a block the scenario names with its log and outputs", async () => {
    const { result, lines } = await run("ready")
    expect(result).toEqual({
      status: { status: "success", exitCode: 0 },
      outputs: {
        path: { value: "aws/accounts/greenfield-dev", sensitive: false },
      },
    })
    expect(lines).toEqual([
      'Simulated by scenario "happy-path" in simulation.yml.',
      "The account can be created.",
    ])
  }, 20000)

  it("runs a block the scenario doesn't name for real", async () => {
    const { result } = await run("real")
    expect(result).toEqual({
      status: { status: "success", exitCode: 0 },
      outputs: { who: { value: "real", sensitive: false } },
    })
  }, 20000)

  it("ends the way the active scenario says", async () => {
    await handlers.get("simulation:set-scenario")!({}, { name: "not-ready" })
    const { result } = await run("ready")
    // Like a real run that fails, it publishes no outputs.
    expect(result).toEqual({ status: { status: "fail", exitCode: 1 }, outputs: {} })
  }, 20000)
})
