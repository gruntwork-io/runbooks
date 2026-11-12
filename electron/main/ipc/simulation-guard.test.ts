/** What simulation mode refuses before a handler runs, and that the list names real channels. */
import { describe, it, expect } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import type { IpcMain } from "electron"
import {
  installSimulationGuard,
  REAL_CHANNELS,
  simulationRefusal,
  type SimulationCheck,
} from "./simulation-guard.ts"

type Listener = (event: unknown, ...args: unknown[]) => unknown

function install(check: SimulationCheck) {
  const listeners = new Map<string, Listener>()
  const ipc = {
    handle: (channel: string, listener: Listener) => listeners.set(channel, listener),
  } as unknown as Pick<IpcMain, "handle">
  installSimulationGuard(ipc, check)
  const ran: string[] = []
  for (const channel of ["git:pull-request", "aws:send", "workspace:tree"]) {
    ipc.handle(channel, (_event, ...args) => {
      ran.push(channel)
      return args
    })
  }
  const call = (channel: string, ...args: unknown[]) =>
    Promise.resolve(listeners.get(channel)!({}, ...args))
  return { call, ran }
}

describe("installSimulationGuard", () => {
  it("refuses a channel that reaches a real system when the check says why, without running it", async () => {
    const { call, ran } = install((channel) => simulationRefusal(channel))
    await expect(call("git:pull-request", { title: "x" })).rejects.toThrow(
      "Simulation mode doesn't open a pull request",
    )
    expect(ran).toEqual([])
  })

  it("runs it when the check allows it, with the call's arguments", async () => {
    const seen: unknown[] = []
    const { call, ran } = install((channel, args) => {
      seen.push([channel, ...args])
      return undefined
    })
    expect(await call("aws:send", { service: "sts" })).toEqual([{ service: "sts" }])
    expect(ran).toEqual(["aws:send"])
    expect(seen).toEqual([["aws:send", { service: "sts" }]])
  })

  it("never asks about a channel that stays on the computer", async () => {
    const { call, ran } = install(() => "refused")
    expect(await call("workspace:tree", "/clone")).toEqual(["/clone"])
    expect(ran).toEqual(["workspace:tree"])
  })
})

describe("REAL_CHANNELS", () => {
  it("names only channels a handler registers", () => {
    const dir = import.meta.dir
    const sources = fs
      .readdirSync(dir)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .filter((file) => file !== path.basename(import.meta.path).replace(".test.ts", ".ts"))
      .map((file) => fs.readFileSync(path.join(dir, file), "utf8"))
      .join("\n")
    const missing = Object.keys(REAL_CHANNELS).filter(
      (channel) => !sources.includes(`"${channel}"`),
    )
    expect(missing).toEqual([])
  })
})
