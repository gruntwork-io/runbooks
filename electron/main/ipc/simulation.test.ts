/** Which calls simulation mode lets reach the computer, by what they'd run. */
import { describe, it, expect, beforeAll, afterEach } from "bun:test"
import { mockElectron } from "../test-utils/mock-electron.ts"

mockElectron({ ipcMain: { handle: () => {} } })

const { simulationCheck, enableSimulation, disableSimulation } = await import("./simulation.ts")
const { runtime, setExecutableRegistry } = await import("./runtime.ts")
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
  "",
].join("\n")

const ids: Record<string, string> = {}

beforeAll(async () => {
  const registry = new ExecutableRegistry()
  await runtime.runPromise(registry.parseAndRegister("/runbook/runbook.mdx", RUNBOOK))
  setExecutableRegistry(registry)
  for (const [id, entry] of Object.entries(registry.getAllExecutables())) {
    ids[entry.componentId] = id
  }
})

afterEach(() => disableSimulation())

const check = (channel: string, ...args: unknown[]) => simulationCheck(channel, args)

describe("simulationCheck", () => {
  it("lets everything run outside simulation mode", async () => {
    expect(await check("exec:run", { executableId: ids.hello })).toBeUndefined()
    expect(await check("git:push", {})).toBeUndefined()
  })

  it("refuses a script and anything else that reaches a real system", async () => {
    enableSimulation()
    expect(await check("exec:run", { executableId: ids.hello })).toContain(
      "Simulation mode doesn't run a block's script",
    )
    expect(await check("exec:run", { executableId: "nope" })).toContain("run a block's script")
    expect(await check("git:push", {})).toContain("push to a repository")
  })

  it("lets a Git host sign-in and a clone through, which only read", async () => {
    enableSimulation()
    expect(await check("github:validate", {})).toBeUndefined()
    expect(await check("git:clone", {})).toBeUndefined()
    expect(await check("git:pull-request", {})).toContain("open a pull request")
  })

  it("lets a <Prerequisites> block check this computer's tools", async () => {
    enableSimulation()
    expect(await check("exec:run", { executableId: ids.tools })).toBeUndefined()
  })
})
