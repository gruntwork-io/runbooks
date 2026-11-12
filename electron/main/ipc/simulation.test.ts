/** Which calls simulation mode lets reach the computer, by what they'd run. */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test"
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

const { simulationCheck, enableSimulation, disableSimulation, registerSimulationHandlers } =
  await import("./simulation.ts")
const { runtime, setExecutableRegistry, setRunbookConfig } = await import("./runtime.ts")
const { ExecutableRegistry } = await import("../../../src/domain/registry/executable.ts")

const RUNBOOK = [
  '<Prerequisites id="tools" title="Tools">',
  "```yaml",
  "tools:",
  "  - name: tofu",
  "```",
  "</Prerequisites>",
  "",
  '<Command id="hello" command="echo hi" />',
  '<Command id="set-settings" command="echo hi" />',
  "",
].join("\n")

const SIMULATION = `
scenarios:
  happy-path:
    scripts:
      set_settings:
        log: Let anyone post to the group.
      set-setings:
        log: A typo.
  real-run:
    runUnanswered: true
`

const ids: Record<string, string> = {}
let tmpDir = ""

beforeAll(async () => {
  registerSimulationHandlers()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-simulation-check-"))
  const runbook = path.join(tmpDir, "runbook.mdx")
  fs.writeFileSync(path.join(tmpDir, "simulation.yml"), SIMULATION)
  setRunbookConfig({ localPath: runbook, isWatchMode: false })
  const registry = new ExecutableRegistry()
  await runtime.runPromise(registry.parseAndRegister(runbook, RUNBOOK))
  setExecutableRegistry(registry)
  for (const [id, entry] of Object.entries(registry.getAllExecutables())) {
    ids[entry.componentId] = id
  }
})

afterAll(() => {
  setRunbookConfig({ localPath: "", isWatchMode: false })
  setExecutableRegistry(null)
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

afterEach(() => disableSimulation())

const check = (channel: string, ...args: unknown[]) => simulationCheck(channel, args)

describe("simulationCheck", () => {
  it("lets everything run outside simulation mode", async () => {
    expect(await check("exec:run", { executableId: ids.hello })).toBeUndefined()
    expect(await check("git:push", {})).toBeUndefined()
  })

  it("refuses a script the scenario doesn't answer, and anything else that reaches a real system", async () => {
    enableSimulation()
    expect(await check("exec:run", { executableId: ids.hello })).toContain(
      "Simulation mode doesn't run a block's script",
    )
    expect(await check("exec:run", { executableId: "nope" })).toContain("run a block's script")
    expect(await check("git:push", {})).toContain("push to a repository")
  })

  it("lets a script the scenario answers through, matching - and _ alike", async () => {
    enableSimulation()
    expect(await check("exec:run", { executableId: ids["set-settings"] })).toBeUndefined()
  })

  it("lets a <Prerequisites> block check this computer's tools", async () => {
    enableSimulation()
    expect(await check("exec:run", { executableId: ids.tools })).toBeUndefined()
  })
})

describe("simulation:state", () => {
  it("names the scripts the scenario answers that no block on the page has", async () => {
    enableSimulation()
    const state = await handlers.get("simulation:state")!({})
    expect(state).toMatchObject({
      active: "happy-path",
      answers: { runUnanswered: false, scripts: ["set_settings", "set_setings"] },
      unmatchedScripts: ["set_setings"],
    })
  })

  it("says what's wrong, and lists the scenarios to pick from, when the picked one is gone", async () => {
    enableSimulation()
    await handlers.get("simulation:set-scenario")!({}, { name: "renamed" })
    const state = await handlers.get("simulation:state")!({})
    expect(state).toMatchObject({ scenarios: [{ name: "happy-path" }, { name: "real-run" }] })
    expect(state).not.toHaveProperty("active")
    expect((state as { error: string }).error).toContain("no scenario named renamed")
    expect(await check("exec:run", { executableId: ids["set-settings"] })).toContain(
      "run a block's script",
    )
  })
})

describe("a scenario that runs what it doesn't answer for real", () => {
  it("lets anything through, once the author picks it", async () => {
    enableSimulation()
    await handlers.get("simulation:set-scenario")!({}, { name: "real-run" })
    expect(await check("exec:run", { executableId: ids.hello })).toBeUndefined()
    expect(await check("git:push", {})).toBeUndefined()
  })
})
