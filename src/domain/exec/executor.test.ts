import { describe, it, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { executeScript, type ExecEvent } from "./executor.ts"
import { encodeOutputs } from "./outputValues.ts"
import { makeTestLayer } from "../../test-utils/TestLayer.ts"
import { makeTestFileSystem } from "../../test-utils/TestFileSystem.ts"
import { makeTestEnvironment } from "../../test-utils/TestEnvironment.ts"
import { ProcessSpawner, type SpawnOptions } from "../../services/ProcessSpawner.ts"

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

// ---------------------------------------------------------------------------
// Log files ($RUNBOOK_LOG, $RUNBOOK_INFO_LOG etc.)
// ---------------------------------------------------------------------------

describe("executeScript — log files", () => {
  it("names RUNBOOK_LOG and a log file per level in the env and asks the spawner to follow each one", async () => {
    let received: SpawnOptions | undefined
    let atSpawn: Record<string, string> = {}
    const files: Record<string, string> = {}
    const spawner = Layer.succeed(ProcessSpawner, {
      spawn: (_command, _args, options) =>
        Effect.sync(() => {
          received = options
          atSpawn = { ...files }
          // What a line written straight to each file turns into.
          const lines = (options?.logChannels ?? []).map((channel) => {
            const raw = `raw ${channel.path}`
            return {
              line: channel.formatLine ? channel.formatLine(raw) : raw,
              source: "file" as const,
            }
          })
          return {
            output: Stream.fromIterable(lines),
            exitCode: Effect.succeed(0),
            kill: Effect.void,
          }
        }),
    })
    const layer = Layer.mergeAll(
      makeTestFileSystem(files),
      spawner,
      makeTestEnvironment({ PATH: "/usr/bin" }),
    )

    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { logStream, completionEffect } = yield* executeScript(
            "log_info hi",
            "",
            // A block can't point a log file somewhere else.
            { envVarsOverride: { RUNBOOK_ERROR_LOG: "/elsewhere" } },
            { env: { PATH: "/usr/bin" }, workDir: "/work" },
            "",
            "/output",
          )
          const logs = Array.from(yield* Stream.runCollect(logStream))
          return [...logs, ...(yield* completionEffect)]
        }),
      ).pipe(Effect.provide(layer)),
    )

    const env = (received?.env ?? {}) as Record<string, string>
    const paths = (received?.logChannels ?? []).map((channel) => channel.path)
    expect(paths).toEqual([
      env.RUNBOOK_LOG,
      env.RUNBOOK_INFO_LOG,
      env.RUNBOOK_WARN_LOG,
      env.RUNBOOK_ERROR_LOG,
      env.RUNBOOK_DEBUG_LOG,
    ])
    expect(paths.map((p) => p?.split("/").pop())).toEqual([
      "runbook.log",
      "info.log",
      "warn.log",
      "error.log",
      "debug.log",
    ])
    // Each file exists, empty, at the spawn, and is gone once the run ends.
    for (const p of paths) {
      expect(atSpawn[p!]).toBe("")
      expect(files[p!]).toBeUndefined()
    }

    // RUNBOOK_LOG's lines name their own level, so they're shown as written.
    // The per-level files' lines get a timestamp and the file's level.
    const stamp = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\] /
    const [first, ...lines] = events.flatMap((e) => (e._tag === "log" ? [e.event.line] : []))
    expect(first).toBe(`raw ${env.RUNBOOK_LOG}`)
    expect(lines.every((line) => stamp.test(line))).toBe(true)
    expect(lines.map((line) => line.replace(stamp, ""))).toEqual([
      `[INFO]  raw ${env.RUNBOOK_INFO_LOG}`,
      `[WARN]  raw ${env.RUNBOOK_WARN_LOG}`,
      `[ERROR] raw ${env.RUNBOOK_ERROR_LOG}`,
      `[DEBUG] raw ${env.RUNBOOK_DEBUG_LOG}`,
    ])
  })
})

// ---------------------------------------------------------------------------
// Files written to $GENERATED_FILES
// ---------------------------------------------------------------------------

describe("executeScript — captured files", () => {
  /**
   * Run a step whose (fake) process writes `written` into $GENERATED_FILES.
   * The spawner shares the in-memory file table with the FileSystem layer, so
   * the capture and the tree walk after exit see exactly what it wrote.
   */
  async function runWritingGeneratedFiles(
    written: Record<string, string>,
    files: Record<string, string> = {},
  ) {
    const spawner = Layer.succeed(ProcessSpawner, {
      spawn: (_command, _args, options) =>
        Effect.sync(() => {
          const generatedDir = options?.env?.GENERATED_FILES
          for (const [relPath, content] of Object.entries(written)) {
            files[`${generatedDir}/${relPath}`] = content
          }
          return { output: Stream.empty, exitCode: Effect.succeed(0), kill: Effect.void }
        }),
    })
    const layer = Layer.mergeAll(
      makeTestFileSystem(files),
      spawner,
      makeTestEnvironment({ PATH: "/usr/bin" }),
    )

    const program = Effect.scoped(
      Effect.gen(function* () {
        const { logStream, completionEffect } = yield* executeScript(
          "write files",
          "",
          {},
          { env: { PATH: "/usr/bin" }, workDir: "/work" },
          "",
          "/output",
        )
        yield* Stream.runDrain(logStream)
        return yield* completionEffect
      }),
    )

    const events = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    const captured = events.find(
      (e): e is Extract<ExecEvent, { _tag: "files_captured" }> => e._tag === "files_captured",
    )
    expect(captured).toBeDefined()
    return captured!.event
  }

  it("sends the generated-files tree the renderer can show", async () => {
    // The renderer drops a files-captured event whose fileTree is not an
    // array, so a null tree meant captured files never reached the panel.
    const event = await runWritingGeneratedFiles({ "main.tf": 'resource "x" "y" {}' })

    expect(event.files).toEqual([{ path: "main.tf", size: 19 }])
    expect(Array.isArray(event.fileTree)).toBe(true)
    expect(event.fileTree!.map((n) => n.id)).toEqual(["main.tf"])
    expect(event.fileTree![0].file?.content).toBe('resource "x" "y" {}')
    expect(event.totalFiles).toBe(1)
    expect(event.truncatedTree).toBe(false)
  })

  it("keeps files already in the output dir in the tree", async () => {
    // The tree replaces the whole Generated panel, so it must cover the
    // output dir, not only this step's captures.
    const event = await runWritingGeneratedFiles(
      { "new.txt": "new" },
      { "/output/earlier.yaml": "a: 1" },
    )

    expect(event.files.map((f) => f.path)).toEqual(["new.txt"])
    expect(event.fileTree!.map((n) => n.id).sort()).toEqual(["earlier.yaml", "new.txt"])
    expect(event.totalFiles).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Outputs written to $RUNBOOK_OUTPUT
// ---------------------------------------------------------------------------

describe("executeScript — outputs", () => {
  /** Run a step whose (fake) process writes `content` to $RUNBOOK_OUTPUT. */
  async function runWritingOutputs(content: string) {
    const files: Record<string, string> = {}
    const spawner = Layer.succeed(ProcessSpawner, {
      spawn: (_command, _args, options) =>
        Effect.sync(() => {
          const outputFile = options?.env?.RUNBOOK_OUTPUT
          if (outputFile) files[outputFile] = content
          return { output: Stream.empty, exitCode: Effect.succeed(0), kill: Effect.void }
        }),
    })
    const layer = Layer.mergeAll(
      makeTestFileSystem(files),
      spawner,
      makeTestEnvironment({ PATH: "/usr/bin" }),
    )

    const program = Effect.scoped(
      Effect.gen(function* () {
        const { logStream, completionEffect } = yield* executeScript(
          "write outputs",
          "",
          {},
          { env: { PATH: "/usr/bin" }, workDir: "/work" },
          "",
          "/output",
        )
        yield* Stream.runDrain(logStream)
        return yield* completionEffect
      }),
    )

    const events = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    return events.find((e): e is Extract<ExecEvent, { _tag: "outputs" }> => e._tag === "outputs")
  }

  it("carries a sensitive output wrapped, under its plain key", async () => {
    const outputs = await runWritingOutputs(
      "region=us-west-2\nsensitive:AWS_SECRET_ACCESS_KEY=abc\n",
    )

    // toEqual can't see inside a Redacted, so compare the encoded form
    expect(encodeOutputs(outputs?.event.outputs ?? {})).toEqual({
      region: { value: "us-west-2", sensitive: false },
      AWS_SECRET_ACCESS_KEY: { value: "abc", sensitive: true },
    })
    expect(JSON.stringify(outputs?.event)).toBe(
      '{"outputs":{"region":"us-west-2","AWS_SECRET_ACCESS_KEY":"<redacted>"}}',
    )
  })

  it("carries plain outputs as strings", async () => {
    const outputs = await runWritingOutputs("region=us-west-2\n")

    expect(outputs?.event).toEqual({ outputs: { region: "us-west-2" } })
  })
})
