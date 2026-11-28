import { describe, it, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { executeScript, type ExecEvent } from "./executor.ts"
import type { EnvExport } from "./authEnv.ts"
import { encodeOutputs } from "./outputValues.ts"
import { makeTestLayer } from "../../test-utils/TestLayer.ts"
import { makeTestFileSystem } from "../../test-utils/TestFileSystem.ts"
import { makeTestEnvironment } from "../../test-utils/TestEnvironment.ts"
import { ProcessSpawner, type SpawnOptions } from "../../services/ProcessSpawner.ts"

/** Collect all events from the executeScript stream. */
async function collectEvents(
  scriptContent: string,
  options: {
    scriptPath?: string
    env?: Record<string, string>
    workDir?: string
    workTreePath?: string
    outputPath?: string
    outputLines?: string[]
    exitCode?: number
  } = {},
): Promise<ExecEvent[]> {
  const {
    scriptPath = "",
    env = { PATH: "/usr/bin" },
    workDir = "/work",
    workTreePath = "",
    outputPath = "/output",
    outputLines = ["line 1", "line 2"],
    exitCode = 0,
  } = options

  const layer = makeTestLayer({
    env: { PATH: "/usr/bin" },
    dirs: ["/work"],
    commands: [
      {
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
        { path: scriptPath, interpreter: "" },
        {},
        { env, workDir },
        { workTree: workTreePath, generated: outputPath, logs: "/logs/block", scripts: "/scripts" },
        [],
        {},
      )
      const logEvents = yield* Stream.runCollect(logStream)
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
  it("fails before spawning a script file it can't find a program for", async () => {
    const events = await collectEvents("console.log(1)", { scriptPath: "checks/verify.ts" })

    expect(events).toEqual([
      {
        _tag: "log",
        event: {
          line:
            "Runbooks can't tell which program runs verify.ts. " +
            "Add a shebang line, such as #!/usr/bin/env python3, to the top of the script, " +
            "or set the block's interpreter prop.",
          timestamp: expect.any(String),
        },
      },
      { _tag: "status", event: { status: "fail", exitCode: 1 } },
      { _tag: "done" },
    ])
  })

  it("emits log events for each output line", async () => {
    const events = await collectEvents("echo hello", {
      outputLines: ["hello", "world"],
      exitCode: 0,
    })

    const logEvents = events.filter((e) => e._tag === "log")
    expect(logEvents.length).toBeGreaterThanOrEqual(2)
    expect(logEvents[0]!.event.line).toBe("hello")
    expect(logEvents[1]!.event.line).toBe("world")
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
    const lastEvent = events.at(-1)!
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
// envExports: the sign-ins of the auth blocks a block's envFrom names
// ---------------------------------------------------------------------------

describe("executeScript — envFrom exports", () => {
  /** Run with `envExports` and `blockEnv`, recording the env the script is spawned with. */
  async function runWithExports(
    envExports: readonly EnvExport[],
    blockEnv: Record<string, string> = {},
  ) {
    let spawnedEnv: Record<string, string> | undefined
    const spawner = Layer.succeed(ProcessSpawner, {
      spawn: (_command, _args, options) =>
        Effect.sync(() => {
          spawnedEnv = { ...(options?.env as Record<string, string>) }
          return {
            output: Stream.empty,
            exitCode: Effect.succeed(0),
            kill: Effect.void,
          }
        }),
    })
    const layer = Layer.mergeAll(
      makeTestFileSystem({}, ["/work"]),
      spawner,
      makeTestEnvironment({ PATH: "/usr/bin" }),
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { completionEffect } = yield* executeScript(
            "aws sts get-caller-identity",
            { path: "", interpreter: "" },
            {},
            {
              env: {
                PATH: "/usr/bin",
                AWS_ACCESS_KEY_ID: "AKIA_SHELL",
                AWS_SESSION_TOKEN: "shell-token",
                GITHUB_TOKEN: "ghp_shell",
              },
              workDir: "/work",
            },
            { workTree: "", generated: "/output", logs: "/logs/block", scripts: "/scripts" },
            envExports,
            blockEnv,
          )
          return yield* completionEffect
        }),
      ).pipe(Effect.provide(layer)),
    )
    return spawnedEnv
  }

  it("runs with the session's env when envFrom names nothing", async () => {
    expect(await runWithExports([])).toMatchObject({
      AWS_ACCESS_KEY_ID: "AKIA_SHELL",
      AWS_SESSION_TOKEN: "shell-token",
      GITHUB_TOKEN: "ghp_shell",
    })
  })

  it("replaces a provider's variables with the export's, removing the ones it doesn't set", async () => {
    const env = await runWithExports([
      { env: { AWS_ACCESS_KEY_ID: "AKIA_BLOCK" }, clears: ["AWS_SESSION_TOKEN", "AWS_REGION"] },
    ])

    expect(env).toMatchObject({ AWS_ACCESS_KEY_ID: "AKIA_BLOCK", GITHUB_TOKEN: "ghp_shell" })
    expect(env).not.toHaveProperty("AWS_SESSION_TOKEN")
  })

  it("applies the exports in order, so a later one wins, and the block's env over all of them", async () => {
    const env = await runWithExports(
      [
        { env: { AWS_ACCESS_KEY_ID: "AKIA_FIRST", AWS_REGION: "us-east-1" }, clears: [] },
        { env: { AWS_ACCESS_KEY_ID: "AKIA_SECOND" }, clears: ["AWS_SESSION_TOKEN"] },
      ],
      { AWS_REGION: "eu-west-1" },
    )

    expect(env).toMatchObject({ AWS_ACCESS_KEY_ID: "AKIA_SECOND", AWS_REGION: "eu-west-1" })
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
      dirs: ["/work"],
      env: { PATH: "/usr/bin" },
      commands: [{ command: "bash", outputLines: ["ran"], exitCode: 0 }],
    })

    const program = Effect.scoped(
      Effect.gen(function* () {
        const { logStream, completionEffect } = yield* executeScript(
          "gcloud iam service-accounts describe sa@p.iam.gserviceaccount.com",
          { path: "", interpreter: "" },
          {},
          { env: { PATH: "/usr/bin" }, workDir: "/work" },
          { workTree: "", generated: "/output", logs: "/logs/block", scripts: "/scripts" },
          [{ env: { GOOGLE_APPLICATION_CREDENTIALS: credentialsPath }, clears: [] }],
          {},
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
// Log files ($RUNBOOK_INFO_LOG etc.)
// ---------------------------------------------------------------------------

describe("executeScript — log files", () => {
  it("names a log file per level in the env and asks the spawner to follow each one", async () => {
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
      makeTestFileSystem(files, ["/work"]),
      spawner,
      makeTestEnvironment({ PATH: "/usr/bin" }),
    )

    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { logStream, completionEffect } = yield* executeScript(
            'echo hi >> "$RUNBOOK_INFO_LOG"',
            { path: "", interpreter: "" },
            {},
            { env: { PATH: "/usr/bin" }, workDir: "/work" },
            { workTree: "", generated: "/output", logs: "/logs/block", scripts: "/scripts" },
            [],
            {},
          )
          const logs = Array.from(yield* Stream.runCollect(logStream))
          return [...logs, ...(yield* completionEffect)]
        }),
      ).pipe(Effect.provide(layer)),
    )

    const env = (received?.env ?? {}) as Record<string, string>
    const paths: (string | undefined)[] = (received?.logChannels ?? []).map(
      (channel) => channel.path,
    )
    expect(env.RUNBOOK_LOG).toBeUndefined()
    expect(paths).toEqual([
      env.RUNBOOK_INFO_LOG,
      env.RUNBOOK_WARN_LOG,
      env.RUNBOOK_ERROR_LOG,
      env.RUNBOOK_DEBUG_LOG,
    ])
    expect(paths.map((p) => p?.split("/").pop())).toEqual([
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

    // Each file's lines get a timestamp and the file's level
    const stamp = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\] /
    const lines = events.flatMap((e) => (e._tag === "log" ? [e.event.line] : []))
    expect(lines.every((line) => stamp.test(line))).toBe(true)
    expect(lines.map((line) => line.replace(stamp, ""))).toEqual([
      `[INFO]  raw ${env.RUNBOOK_INFO_LOG}`,
      `[WARN]  raw ${env.RUNBOOK_WARN_LOG}`,
      `[ERROR] raw ${env.RUNBOOK_ERROR_LOG}`,
      `[DEBUG] raw ${env.RUNBOOK_DEBUG_LOG}`,
    ])
  })
})

describe("executeScript — block env", () => {
  it("sets the block's env over the session's and the auth block's, under the runbook's own vars", async () => {
    let received: Record<string, string> = {}
    const spawner = Layer.succeed(ProcessSpawner, {
      spawn: (_command, _args, options) =>
        Effect.sync(() => {
          received = { ...(options?.env as Record<string, string>) }
          return { output: Stream.empty, exitCode: Effect.succeed(0), kill: Effect.void }
        }),
    })
    const layer = Layer.mergeAll(
      makeTestFileSystem({}, ["/work"]),
      spawner,
      makeTestEnvironment({ PATH: "/usr/bin" }),
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { logStream, completionEffect } = yield* executeScript(
            'aws s3 mb "s3://$BUCKET"',
            { path: "", interpreter: "" },
            {},
            { env: { PATH: "/usr/bin", BUCKET: "session-bucket" }, workDir: "/work" },
            { workTree: "", generated: "/output", logs: "/logs/block", scripts: "/scripts" },
            [{ env: { AWS_ACCESS_KEY_ID: "AKIA_AUTH", AWS_REGION: "us-east-1" }, clears: [] }],
            // parseBlockEnv refuses RUNBOOK_OUTPUT; it is here to show the
            // runbook's own value wins even so.
            { BUCKET: "block-bucket", AWS_REGION: "eu-west-1", RUNBOOK_OUTPUT: "/elsewhere" },
          )
          yield* Stream.runDrain(logStream)
          yield* completionEffect
        }),
      ).pipe(Effect.provide(layer)),
    )

    expect(received.BUCKET).toBe("block-bucket")
    expect(received.AWS_REGION).toBe("eu-west-1")
    expect(received.AWS_ACCESS_KEY_ID).toBe("AKIA_AUTH")
    expect(received.RUNBOOK_OUTPUT).toEndWith("/output.txt")
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
      makeTestFileSystem(files, ["/work"]),
      spawner,
      makeTestEnvironment({ PATH: "/usr/bin" }),
    )

    const program = Effect.scoped(
      Effect.gen(function* () {
        const { logStream, completionEffect } = yield* executeScript(
          "write files",
          { path: "", interpreter: "" },
          {},
          { env: { PATH: "/usr/bin" }, workDir: "/work" },
          { workTree: "", generated: "/output", logs: "/logs/block", scripts: "/scripts" },
          [],
          {},
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
    expect(event.fileTree![0]!.file?.content).toBe('resource "x" "y" {}')
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
      makeTestFileSystem(files, ["/work"]),
      spawner,
      makeTestEnvironment({ PATH: "/usr/bin" }),
    )

    const program = Effect.scoped(
      Effect.gen(function* () {
        const { logStream, completionEffect } = yield* executeScript(
          "write outputs",
          { path: "", interpreter: "" },
          {},
          { env: { PATH: "/usr/bin" }, workDir: "/work" },
          { workTree: "", generated: "/output", logs: "/logs/block", scripts: "/scripts" },
          [],
          {},
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

// ---------------------------------------------------------------------------
// Variables written to $RUNBOOK_ENV, and the working directory
// ---------------------------------------------------------------------------

describe("executeScript — session env", () => {
  /**
   * Run a step in `workDir` whose (fake) process writes `content` to
   * $RUNBOOK_ENV and exits with `exitCode`. Returns the events, and the cwd
   * and env it was spawned with.
   */
  async function runWritingEnv(
    content: string,
    { exitCode = 0, workDir = "/work" }: { exitCode?: number; workDir?: string } = {},
  ) {
    const files: Record<string, string> = {}
    let spawned: SpawnOptions | undefined
    const spawner = Layer.succeed(ProcessSpawner, {
      spawn: (_command, _args, options) =>
        Effect.sync(() => {
          spawned = options
          const envFile = options?.env?.RUNBOOK_ENV
          if (envFile) files[envFile] = content
          return { output: Stream.empty, exitCode: Effect.succeed(exitCode), kill: Effect.void }
        }),
    })
    const layer = Layer.mergeAll(
      makeTestFileSystem(files, ["/work", "/work/infra"]),
      spawner,
      makeTestEnvironment({ PATH: "/usr/bin" }),
    )

    const program = Effect.scoped(
      Effect.gen(function* () {
        const { logStream, completionEffect } = yield* executeScript(
          "write env",
          { path: "", interpreter: "" },
          {},
          { env: { PATH: "/usr/bin" }, workDir },
          { workTree: "", generated: "/output", logs: "/logs/block", scripts: "/scripts" },
          [],
          {},
        )
        yield* Stream.runDrain(logStream)
        return yield* completionEffect
      }),
    )

    const events = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    return { events, spawned }
  }

  it("sends the variables the script wrote, for the session", async () => {
    const { events } = await runWritingEnv("REGION=us-west-2\nKEY<<EOF\na\nb\nEOF\n")

    expect(events.find((e) => e._tag === "session_env")).toEqual({
      _tag: "session_env",
      env: { REGION: "us-west-2", KEY: "a\nb" },
    })
  })

  it("sends an empty env when a script that succeeds writes none, so the run still counts", async () => {
    const { events } = await runWritingEnv("")

    expect(events.find((e) => e._tag === "session_env")).toEqual({ _tag: "session_env", env: {} })
  })

  it("logs each line that sets nothing, before the status", async () => {
    const { events } = await runWritingEnv("OK=1\nRUNBOOK_OUTPUT=x\n")

    const tags = events.map((e) => (e._tag === "log" ? `log:${e.event.line}` : e._tag))
    expect(tags).toEqual([
      "log:RUNBOOK_ENV line 2: RUNBOOK_OUTPUT is a variable Runbooks sets for every script. The line was ignored.",
      "status",
      "session_env",
      "done",
    ])
  })

  it("sends nothing for the session when the script fails", async () => {
    const { events } = await runWritingEnv("A=1\n", { exitCode: 1 })

    expect(events.some((e) => e._tag === "session_env")).toBe(false)
  })

  it("runs in the working directory it is given", async () => {
    const { spawned } = await runWritingEnv("", { workDir: "/work/infra" })

    expect(spawned?.cwd).toBe("/work/infra")
  })

  it("fails before spawning when the working directory does not exist", async () => {
    const { events, spawned } = await runWritingEnv("", { workDir: "/work/gone" })

    expect(spawned).toBeUndefined()
    expect(events).toEqual([
      {
        _tag: "log",
        event: {
          line: "Working directory does not exist: /work/gone",
          timestamp: expect.any(String),
        },
      },
      { _tag: "status", event: { status: "fail", exitCode: 1 } },
      { _tag: "done" },
    ])
  })
})
