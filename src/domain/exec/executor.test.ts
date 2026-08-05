import { describe, it, expect } from "bun:test"
import { Effect, Stream } from "effect"
import { executeScript, type ExecEvent } from "./executor.ts"
import { makeTestLayer } from "../../test-utils/TestLayer.ts"

/** Collect all events from the executeScript stream. */
async function collectEvents(
  scriptContent: string,
  options: {
    language?: string
    env?: Record<string, string>
    workDir?: string
    workTreePath?: string
    outputPath?: string
    envVarsOverride?: Record<string, string>
    outputLines?: string[]
    exitCode?: number
  } = {},
): Promise<ExecEvent[]> {
  const {
    language = "",
    env = { PATH: "/usr/bin" },
    workDir = "/work",
    workTreePath = "",
    outputPath = "/output",
    envVarsOverride,
    outputLines = ["line 1", "line 2"],
    exitCode = 0,
  } = options

  const layer = makeTestLayer({
    env: { PATH: "/usr/bin" },
    commands: [
      {
        // The script wrapper writes to a temp file and runs via interpreter
        command: "bash",
        outputLines,
        exitCode,
      },
    ],
  })

  const program = Effect.scoped(
    Effect.gen(function* () {
      const { logStream, completionEffect } = yield* executeScript(
        scriptContent,
        language,
        { envVarsOverride },
        { env, workDir },
        workTreePath,
        outputPath,
      )
      const logChunk = yield* Stream.runCollect(logStream)
      const logEvents = Array.from(logChunk)
      // Run completion to get remaining events
      const completionEvents = yield* completionEffect
      return [...logEvents, ...completionEvents]
    }),
  )

  return Effect.runPromise(program.pipe(Effect.provide(layer)))
}

// ---------------------------------------------------------------------------
// determineExitStatus (tested indirectly through executeScript)
// ---------------------------------------------------------------------------

describe("executeScript", () => {
  it("emits log events for each output line", async () => {
    const events = await collectEvents("echo hello", {
      outputLines: ["hello", "world"],
      exitCode: 0,
    })

    const logEvents = events.filter((e) => e._tag === "log")
    expect(logEvents.length).toBeGreaterThanOrEqual(2)
    expect(logEvents[0].event.line).toBe("hello")
    expect(logEvents[1].event.line).toBe("world")
  })

  it("emits success status for exit code 0", async () => {
    const events = await collectEvents("echo ok", { exitCode: 0 })
    const status = events.find((e) => e._tag === "status")
    expect(status).toBeDefined()
    expect(status!.event.status).toBe("success")
    expect(status!.event.exitCode).toBe(0)
  })

  it("emits warn status for exit code 2", async () => {
    const events = await collectEvents("exit 2", { exitCode: 2 })
    const status = events.find((e) => e._tag === "status")
    expect(status!.event.status).toBe("warn")
    expect(status!.event.exitCode).toBe(2)
  })

  it("emits fail status for non-zero exit code", async () => {
    const events = await collectEvents("exit 1", { exitCode: 1 })
    const status = events.find((e) => e._tag === "status")
    expect(status!.event.status).toBe("fail")
    expect(status!.event.exitCode).toBe(1)
  })

  it("emits done event at the end", async () => {
    const events = await collectEvents("echo hi", { exitCode: 0 })
    const lastEvent = events[events.length - 1]
    expect(lastEvent._tag).toBe("done")
  })

  it("includes log timestamps", async () => {
    const events = await collectEvents("echo hi", {
      outputLines: ["test"],
      exitCode: 0,
    })
    const logEvent = events.find((e) => e._tag === "log")
    expect(logEvent!.event.timestamp).toBeDefined()
    // Should be ISO format
    expect(() => new Date(logEvent!.event.timestamp)).not.toThrow()
  })

  it("does not emit outputs on failure", async () => {
    const events = await collectEvents("exit 1", {
      exitCode: 1,
      outputLines: [],
    })
    const outputs = events.find((e) => e._tag === "outputs")
    expect(outputs).toBeUndefined()
  })

  it("event order is logs -> status -> done", async () => {
    const events = await collectEvents("echo hi", {
      outputLines: ["hi"],
      exitCode: 0,
    })
    const tags = events.map((e) => e._tag)
    const statusIdx = tags.indexOf("status")
    const doneIdx = tags.indexOf("done")
    const lastLogIdx = tags.lastIndexOf("log")

    // All logs come before status
    expect(lastLogIdx).toBeLessThan(statusIdx)
    // Status comes before done
    expect(statusIdx).toBeLessThan(doneIdx)
    // Done is last
    expect(doneIdx).toBe(tags.length - 1)
  })
})

// ---------------------------------------------------------------------------
// GOOGLE_APPLICATION_CREDENTIALS pre-flight
// ---------------------------------------------------------------------------

describe("executeScript — missing Google credential file", () => {
  /** Run with an explicit file table so the credential path can be present or not. */
  async function runWithCredentials(
    credentialsPath: string,
    files: Record<string, string>,
  ): Promise<ExecEvent[]> {
    const layer = makeTestLayer({
      files,
      env: { PATH: "/usr/bin" },
      commands: [{ command: "bash", outputLines: ["ran"], exitCode: 0 }],
    })

    const program = Effect.scoped(
      Effect.gen(function* () {
        const { logStream, completionEffect } = yield* executeScript(
          "gcloud iam service-accounts describe sa@p.iam.gserviceaccount.com",
          "",
          { envVarsOverride: { GOOGLE_APPLICATION_CREDENTIALS: credentialsPath } },
          { env: { PATH: "/usr/bin" }, workDir: "/work" },
          "",
          "/output",
        )
        const logEvents = Array.from(yield* Stream.runCollect(logStream))
        return [...logEvents, ...(yield* completionEffect)]
      }),
    )

    return Effect.runPromise(program.pipe(Effect.provide(layer)))
  }

  it("fails before spawning, naming the path and what to do about it", async () => {
    // The failure this replaces: gcloud reported "Failed to load credential
    // file" against a temp directory the user never created, which reads as a
    // cloud-side problem rather than a stale auth-block output.
    const events = await runWithCredentials("/tmp/runbooks-gcp-A7oaHl/adc.json", {})

    const status = events.find((e) => e._tag === "status")
    expect(status).toEqual({ _tag: "status", event: { status: "fail", exitCode: 1 } })

    const log = events.find((e) => e._tag === "log")
    expect(log?._tag).toBe("log")
    expect(log!.event.line).toContain("/tmp/runbooks-gcp-A7oaHl/adc.json")
    expect(log!.event.line).toContain("Re-authenticate")

    // Never reached the interpreter — no "ran" line from the fake spawner.
    expect(events.some((e) => e._tag === "log" && e.event.line === "ran")).toBe(false)
    expect(events[events.length - 1]?._tag).toBe("done")
  })

  it("runs normally when the credential file is still there", async () => {
    const events = await runWithCredentials("/tmp/runbooks-gcp-4gUk0g/adc.json", {
      "/tmp/runbooks-gcp-4gUk0g/adc.json": '{"type":"authorized_user"}',
    })

    const status = events.find((e) => e._tag === "status")
    expect(status).toEqual({ _tag: "status", event: { status: "success", exitCode: 0 } })
    expect(events.some((e) => e._tag === "log" && e.event.line === "ran")).toBe(true)
  })

  it("ignores a step that references no Google credential at all", async () => {
    const events = await collectEvents("echo hi", { outputLines: ["hi"], exitCode: 0 })
    const status = events.find((e) => e._tag === "status")
    expect(status).toEqual({ _tag: "status", event: { status: "success", exitCode: 0 } })
  })
})
