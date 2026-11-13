import { describe, expect, it } from "bun:test"
import { spawn } from "node:child_process"
import { running, startTime } from "./session.ts"

describe("running", () => {
  it("knows a process by its id and start time", async () => {
    const child = spawn("sleep", ["30"])
    try {
      const started = startTime(child.pid!)
      expect(started).toBeDefined()
      expect(running(child.pid!, started)).toBe(true)
      // Another process with this id would have started at another time.
      expect(running(child.pid!, "Thu Jan  1 00:00:00 1970")).toBe(false)
      expect(running(child.pid!, undefined)).toBe(false)
    } finally {
      child.kill()
      await new Promise((resolve) => {
        child.on("exit", resolve)
      })
    }
    expect(running(child.pid!, "anything")).toBe(false)
  })
})
