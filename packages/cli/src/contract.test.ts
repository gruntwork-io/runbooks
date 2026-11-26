import { describe, expect, it } from "bun:test"
import {
  Cause,
  ConfigProvider,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Stdio,
  Terminal,
} from "effect"
import { CliError, Command } from "effect/cli"
import { ChildProcessSpawner } from "effect/process"
import { makeCli, TestReport, ValidateReport } from "./contract.ts"

type Call = { readonly command: string; readonly args: unknown }

/** Runs `runbooks <argv>` with handlers that record what they were given. */
async function run(argv: ReadonlyArray<string>, env: Record<string, string> = {}) {
  const calls: Array<Call> = []
  const record = (command: string) => (args: unknown) =>
    Effect.sync(() => {
      calls.push({ command, args })
    })
  const cli = makeCli({
    open: record("open"),
    test: record("test"),
    validate: record("validate"),
    mcp: record("mcp"),
  })
  const layer = Layer.mergeAll(
    FileSystem.layerNoop({}),
    Path.layer,
    Stdio.layerTest({}),
    Layer.succeed(
      Terminal.Terminal,
      Terminal.make({
        columns: Effect.succeed(80),
        rows: Effect.succeed(24),
        size: Effect.die("unused"),
        readInput: Effect.die("unused"),
        readLine: Effect.die("unused"),
        display: () => Effect.void,
      }),
    ),
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.die("unused")),
    ),
    ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)),
  )
  const exit = await Effect.runPromiseExit(
    Command.runWith(cli, { version: "0.0.0-test", renderErrors: false })(argv).pipe(
      Effect.provide(layer),
    ),
  )
  return { exit, calls, errors: parseErrors(exit) }
}

/** The parse errors a refused command line produced, as `Tag:option`. */
function parseErrors(exit: Exit.Exit<unknown, unknown>): string[] {
  if (Exit.isSuccess(exit)) return []
  return exit.cause.reasons
    .filter(Cause.isFailReason)
    .flatMap(({ error }) =>
      error instanceof CliError.ShowHelp
        ? error.errors.map((e) => `${e._tag}:${"option" in e ? e.option : ""}`)
        : [String(error)],
    )
}

describe("runbooks test", () => {
  it("takes the documented CI invocation", async () => {
    const { exit, calls } = await run([
      "test",
      "./runbooks/...",
      "--output",
      "junit",
      "--output-file",
      "results.xml",
    ])
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(calls).toEqual([
      {
        command: "test",
        args: {
          paths: ["./runbooks/..."],
          verbose: false,
          test: Option.none(),
          output: "junit",
          outputFile: Option.some("results.xml"),
          maxParallel: 1,
        },
      },
    ])
  })

  it("takes -v and --test", async () => {
    const { calls } = await run(["test", "./my-runbook", "-v", "--test", "happy-path"])
    expect(calls[0]?.args).toMatchObject({ verbose: true, test: Option.some("happy-path") })
  })

  it("refuses an --output it does not know instead of printing text", async () => {
    const { errors, calls } = await run(["test", "./x", "--output", "xml"])
    expect(errors).toEqual(["InvalidValue:output"])
    expect(calls).toEqual([])
  })

  it("refuses --max-parallel below 1 and a test with no paths", async () => {
    expect((await run(["test", "./x", "--max-parallel", "0"])).errors).toEqual([
      "InvalidValue:max-parallel",
    ])
    expect((await run(["test"])).errors).toEqual(["MissingArgument:"])
  })

  it("reads RUNBOOKS_ variables, and a flag wins over its variable", async () => {
    const env = { RUNBOOKS_OUTPUT: "json", RUNBOOKS_MAX_PARALLEL: "4" }
    expect((await run(["test", "./x"], env)).calls[0]?.args).toMatchObject({
      output: "json",
      maxParallel: 4,
    })
    expect((await run(["test", "./x", "--output", "text"], env)).calls[0]?.args).toMatchObject({
      output: "text",
    })
  })
})

describe("runbooks open", () => {
  it("opens a bare source, as the app's launcher does today", async () => {
    const { calls } = await run(["./my-runbook"])
    expect(calls).toEqual([
      {
        command: "open",
        args: expect.objectContaining({ source: Option.some("./my-runbook"), watch: false }),
      },
    ])
  })

  it("takes open with --watch and --disable-live-file-reload", async () => {
    const { calls } = await run([
      "open",
      "--watch",
      "--disable-live-file-reload",
      "path/to/runbook.mdx",
    ])
    expect(calls[0]).toEqual({
      command: "open",
      args: expect.objectContaining({
        source: Option.some("path/to/runbook.mdx"),
        watch: true,
        disableLiveFileReload: true,
      }),
    })
  })

  it("still accepts the old Go CLI's flags", async () => {
    const { exit, calls } = await run(["open", "--no-telemetry", "--working-dir", "/tmp", "./rb"])
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(calls[0]?.args).toMatchObject({
      noTelemetry: true,
      workingDir: Option.some("/tmp"),
      source: Option.some("./rb"),
    })
  })
})

describe("runbooks validate and mcp", () => {
  it("takes paths and a machine format", async () => {
    const { calls } = await run(["validate", "./a", "./b/...", "--output", "json"])
    expect(calls[0]).toEqual({
      command: "validate",
      args: { paths: ["./a", "./b/..."], output: "json" },
    })
    expect((await run(["validate", "./a", "--output", "junit"])).errors).toEqual([
      "InvalidValue:output",
    ])
  })

  it("serves MCP headless by default", async () => {
    expect((await run(["mcp"])).calls[0]).toEqual({ command: "mcp", args: { app: false } })
  })
})

describe("--output json", () => {
  it("still has a report when the command failed", () => {
    const report = Schema.decodeUnknownSync(TestReport)({
      version: 1,
      outcome: "failed",
      runbooks: [],
      summary: { runbooks: 0, passed: 0, failed: 0, skipped: 0, warnings: 0 },
      failure: { _tag: "TestCaseNotFound", name: "happy-path", runbooks: 3 },
    })
    expect(report.failure?._tag).toBe("TestCaseNotFound")
    const stopped = Schema.decodeUnknownSync(TestReport)({
      version: 1,
      outcome: "failed",
      runbooks: [],
      summary: { runbooks: 0, passed: 0, failed: 0, skipped: 0, warnings: 0 },
      failure: { _tag: "Cancelled" },
    })
    expect(stopped.failure).toEqual({ _tag: "Cancelled" })
    const validate = Schema.decodeUnknownSync(ValidateReport)({
      version: 1,
      outcome: "invalid",
      runbooks: [],
      failure: { _tag: "TooManyFiles", path: "./runbooks/...", limit: 10_000 },
    })
    expect(validate.failure).toEqual({
      _tag: "TooManyFiles",
      path: "./runbooks/...",
      limit: 10_000,
    })
    expect(() =>
      Schema.decodeUnknownSync(ValidateReport)({ version: 2, outcome: "valid", runbooks: [] }),
    ).toThrow()
  })
})
