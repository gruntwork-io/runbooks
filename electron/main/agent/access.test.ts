import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { AgentAccess, HEADERS_FILE } from "./access.ts"

let dataDir: string
let access: AgentAccess

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-access-"))
  access = new AgentAccess({
    dataDir,
    version: "test",
    bridge: { request: () => Promise.reject(new Error("unused")) },
    port: 0,
  })
})

afterEach(async () => {
  await access.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe("AgentAccess", () => {
  it("is off by default, and asks before runs", async () => {
    const status = await access.init()
    expect(status.enabled).toBe(false)
    expect(status.confirmRuns).toBe(true)
    expect(status.url).toBeUndefined()
    expect(fs.existsSync(path.join(dataDir, HEADERS_FILE))).toBe(false)
  })

  it("serves on 127.0.0.1 once enabled, with the token in a private headers file", async () => {
    const status = await access.update({ enabled: true })
    expect(status.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    const file = path.join(dataDir, HEADERS_FILE)
    const headers = JSON.parse(fs.readFileSync(file, "utf8"))
    expect(headers.Authorization).toMatch(/^Bearer [\w-]{40,}$/)
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(status.claudeCommand).toContain(
      `--header "${headers.Authorization.replace("Bearer", "Authorization: Bearer")}"`,
    )

    const res = await fetch(status.url!, { method: "POST" })
    expect(res.status).toBe(401)

    const off = await access.update({ enabled: false })
    expect(off.url).toBeUndefined()
    expect(fs.existsSync(file)).toBe(false)
  })

  it("ends turned off when turned off while it was still starting", async () => {
    const on = access.update({ enabled: true })
    const off = access.update({ enabled: false })
    await on
    const status = await off
    expect(status.enabled).toBe(false)
    expect(status.url).toBeUndefined()
    expect(fs.existsSync(path.join(dataDir, HEADERS_FILE))).toBe(false)
  })

  it("keeps asking before runs when the change can't be saved", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return
    await access.init()
    fs.chmodSync(dataDir, 0o500)
    try {
      await expect(access.update({ confirmRuns: false })).rejects.toThrow()
    } finally {
      fs.chmodSync(dataDir, 0o700)
    }
    expect(access.status().confirmRuns).toBe(true)
  })

  it("remembers the setting", async () => {
    await access.update({ enabled: true, confirmRuns: false })
    await access.stop()
    const again = new AgentAccess({
      dataDir,
      version: "test",
      bridge: { request: () => Promise.reject(new Error("unused")) },
      port: 0,
    })
    const status = await again.init()
    expect(status.enabled).toBe(true)
    expect(status.confirmRuns).toBe(false)
    await again.stop()
  })
})
