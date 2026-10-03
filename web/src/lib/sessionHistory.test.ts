import { describe, it, expect } from "vitest"
import type { ExecState, LogEntry } from "@/hooks/useApiExec"
import {
  encodeOutputs,
  isSensitiveOutput,
  revealOutputs,
  sensitiveOutput,
} from "@/lib/outputValues"
import { parseSavedForm, restoreRun, runEnded, runStarted, savedFormValue } from "./sessionHistory"

const line = (n: number, text = `line ${n}`): LogEntry => ({
  line: text,
  timestamp: `2026-01-01T00:00:${String(n % 60).padStart(2, "0")}.000Z`,
})

function execState(overrides: Partial<ExecState> = {}): ExecState {
  return {
    logs: [line(1), line(2)],
    status: "success",
    exitCode: 0,
    error: null,
    outputs: null,
    logFilePath: "/tmp/runbooks/exec.log",
    ...overrides,
  }
}

/** A payload as the main process hands it back: through JSON. */
const stored = (payload: unknown): unknown => JSON.parse(JSON.stringify(payload))

describe("a saved form", () => {
  it("parses the values and whether the form was submitted", () => {
    const form = { values: { region: "us-east-1", count: 3, tags: ["a"] }, submitted: true }

    expect(parseSavedForm(stored(form))).toEqual(form)
  })

  it("is undefined for a payload of another shape", () => {
    for (const payload of [undefined, null, "form", { values: [] }, { values: {} }]) {
      expect(parseSavedForm(payload)).toBeUndefined()
    }
  })

  it("has a value only for a variable the form saved", () => {
    const saved = parseSavedForm({ values: { region: "", enabled: false }, submitted: false })

    expect(savedFormValue(saved, "region")).toBe("")
    expect(savedFormValue(saved, "enabled")).toBe(false)
    expect(savedFormValue(saved, "missing")).toBeUndefined()
    // A variable named after something every object inherits.
    expect(savedFormValue(saved, "toString")).toBeUndefined()
    expect(savedFormValue(undefined, "region")).toBeUndefined()
  })
})

describe("a saved run", () => {
  it("gives a block back the state its run ended in, without the log file", () => {
    const state = execState({
      status: "fail",
      exitCode: 2,
      error: { message: "boom", details: "it broke" },
    })

    expect(restoreRun(stored(runEnded(state)))).toEqual({ ...state, logFilePath: null })
  })

  it("keeps a sensitive output's value, and gives it back wrapped", () => {
    const state = execState({ outputs: { user: "me", token: sensitiveOutput("s3cret") } })

    const restored = restoreRun(stored(runEnded(state)))

    const outputs = restored?.outputs ?? {}
    expect(outputs.user).toBe("me")
    expect(isSensitiveOutput(outputs.token!)).toBe(true)
    expect(revealOutputs(outputs)).toEqual({ user: "me", token: "s3cret" })
  })

  it("saves a stopped run as not run, with the logs it left", () => {
    const stopped = execState({
      status: "pending",
      exitCode: null,
      logs: [line(1), line(2, "Execution cancelled by user")],
    })

    expect(restoreRun(stored(runEnded(stopped)))).toMatchObject({
      status: "pending",
      logs: stopped.logs,
    })
  })

  it("saves a run whose state still says running as not run", () => {
    expect(runEnded(execState({ status: "running", exitCode: null })).status).toBe("pending")
  })

  it("saves and gives back a run that logged nothing", () => {
    const saved = runEnded(execState({ logs: [] }))

    expect(saved).toMatchObject({ logs: [], omittedLogLines: 0 })
    expect(restoreRun(stored(saved))?.logs).toEqual([])
  })

  it("says one earlier line was left out of a 501-line log", () => {
    const logs = Array.from({ length: 501 }, (_, i) => line(i))

    const restored = restoreRun(stored(runEnded(execState({ logs }))))

    expect(restored?.logs[0]?.line).toBe("[1 earlier line was not saved with the session]")
  })

  it("keeps the newest 500 lines of a longer log, and says how many it left out", () => {
    const logs = Array.from({ length: 502 }, (_, i) => line(i))

    const restored = restoreRun(stored(runEnded(execState({ logs }))))

    expect(restored?.logs).toHaveLength(501)
    expect(restored?.logs[0]).toEqual({
      line: "[2 earlier lines were not saved with the session]",
      timestamp: logs[2]!.timestamp,
    })
    expect(restored?.logs.slice(1)).toEqual(logs.slice(2))
  })

  it("keeps at most 64 KiB of log text, newest lines first", () => {
    const long = "x".repeat(40 * 1024)
    const logs = [line(1, long), line(2, long), line(3, "the end")]

    const restored = restoreRun(stored(runEnded(execState({ logs }))))

    expect(restored?.logs.map((entry) => entry.line)).toEqual([
      "[1 earlier line was not saved with the session]",
      long,
      "the end",
    ])
  })

  it("keeps the end of a last line that is longer than 64 KiB on its own", () => {
    const logs = [line(1), line(2, `${"x".repeat(70 * 1024)}the end`)]

    const restored = restoreRun(stored(runEnded(execState({ logs }))))

    expect(restored?.logs).toHaveLength(2)
    expect(restored?.logs[0]?.line).toBe("[1 earlier line was not saved with the session]")
    expect(restored?.logs[1]?.line).toHaveLength(64 * 1024)
    expect(restored?.logs[1]?.line.endsWith("xthe end")).toBe(true)
  })

  it("leaves out outputs too large for an event, and says so on the block", () => {
    const state = execState({ outputs: { plan: "p".repeat(600 * 1024), id: "42" } })

    const event = runEnded(state)
    // Within what the main process accepts, so the run is saved as ended.
    expect(JSON.stringify(event).length).toBeLessThan(1024 * 1024)
    const restored = restoreRun(stored(event))

    expect(restored).toMatchObject({ status: "success", exitCode: 0, outputs: null })
    expect(restored?.error?.message).toBe("The outputs of this run were not saved with the session")
    expect(restored?.error?.details).toContain("Run the block again")
  })

  it("keeps outputs of exactly 512 KiB of JSON", () => {
    const empty = JSON.stringify(encodeOutputs({ plan: "" })).length
    const outputs = { plan: "p".repeat(512 * 1024 - empty) }

    const restored = restoreRun(stored(runEnded(execState({ outputs }))))

    expect(restored?.outputs).toEqual(outputs)
    expect(restored?.error).toBeNull()
  })

  it("keeps lines that come to exactly 64 KiB of log text", () => {
    const half = "x".repeat(32 * 1024)
    const logs = [line(1, "dropped"), line(2, half), line(3, half)]

    const restored = restoreRun(stored(runEnded(execState({ logs }))))

    expect(restored?.logs.map((entry) => entry.line)).toEqual([
      "[1 earlier line was not saved with the session]",
      half,
      half,
    ])
  })

  it("keeps empty lines before a last line of exactly 64 KiB", () => {
    const full = "x".repeat(64 * 1024)
    const logs = [line(1, ""), line(2, full)]

    expect(restoreRun(stored(runEnded(execState({ logs }))))?.logs).toEqual(logs)
  })

  it("gives back a saved run that left out lines it no longer has", () => {
    const payload = { ...(stored(runEnded(execState({ logs: [] }))) as object), omittedLogLines: 3 }

    expect(restoreRun(payload)?.logs).toEqual([])
  })

  it("leaves a block whose run never ended not run, with an error that says so", () => {
    const restored = restoreRun(stored(runStarted()))

    expect(restored).toMatchObject({ status: "pending", exitCode: null, outputs: null, logs: [] })
    expect(restored?.error?.message).toBe("The last run of this block did not finish")
    expect(restored?.error?.details).toContain("How far it got is not known.")
  })

  it("is undefined for a payload of another shape", () => {
    for (const payload of [undefined, {}, { status: "done" }, { status: "success" }]) {
      expect(restoreRun(payload)).toBeUndefined()
    }
  })
})
