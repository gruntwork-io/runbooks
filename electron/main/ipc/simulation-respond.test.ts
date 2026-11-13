/** How simulation:respond answers a lookup: from the scenario first, then the module's recording. */
import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { mockElectron } from "../test-utils/mock-electron.ts"

type Handler = (event: unknown, params?: unknown) => unknown
const handlers = new Map<string, Handler>()
mockElectron({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn)
    },
  },
})

const { registerSimulationHandlers, enableSimulation, disableSimulation } =
  await import("./simulation.ts")
const runtimeModule = await import("./runtime.ts")
registerSimulationHandlers()

const respond = (params: unknown) =>
  Promise.resolve(handlers.get("simulation:respond")!({}, params)) as Promise<unknown>

const RUNBOOK_SIMULATION = `
scenarios:
  happy-path:
    responses:
      google.people:
        - status: 200
          body: { users: [] }
`

let root: string
let original: typeof runtimeModule.runbookConfig

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "simulation-respond-")))
  execFileSync("git", ["init", "-q"], { cwd: root })
  fs.writeFileSync(path.join(root, "runbook.mdx"), "# Test\n")
  fs.writeFileSync(path.join(root, "simulation.yml"), RUNBOOK_SIMULATION)
  fs.mkdirSync(path.join(root, "mod"))
  fs.writeFileSync(path.join(root, "mod", "simulation.yml"), "scenarios: [not, a, map\n")
  original = runtimeModule.runbookConfig
  runtimeModule.setRunbookConfig({
    ...original,
    localPath: path.join(root, "runbook.mdx"),
    isWatchMode: false,
  })
  await runtimeModule.runtime.runPromise(
    runtimeModule.sessionManager.createSession(root, path.join(root, "runbook.mdx")),
  )
  enableSimulation()
})

afterAll(() => {
  disableSimulation()
  runtimeModule.sessionManager.deleteSession()
  runtimeModule.setRunbookConfig(original)
  fs.rmSync(root, { recursive: true, force: true })
})

describe("simulation:respond", () => {
  it("answers from the scenario without reading the module's recording", async () => {
    expect(await respond({ id: "google.people", with: {}, module: "./mod" })).toMatchObject({
      status: 200,
    })
  })

  it("names the module's simulation.yml when it falls back on a broken one", async () => {
    let error: unknown
    try {
      await respond({ id: "google.domains", with: {}, module: "./mod" })
    } catch (err) {
      error = err
    }
    expect(String(error)).toContain(path.join(root, "mod", "simulation.yml"))
    expect(String(error)).toContain("isn't valid YAML")
  })
})
