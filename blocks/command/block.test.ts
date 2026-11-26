import { describe, expect, it } from "bun:test"
import { Deferred, Effect, Layer, Schema, Stream } from "effect"
import { BlockId, RunbookPath } from "@runbooks/blocks-core/contract"
import type { BlockStatus } from "@runbooks/blocks-core/status"
import { configErrors } from "@runbooks/core/document/document"
import { parseRunbook } from "@runbooks/core/document/parse"
import { serveEngine } from "@runbooks/core/handlers"
import { type EngineClient, makeInProcessClient } from "@runbooks/core/inProcess"
import type { SessionId } from "@runbooks/core/protocol"
import { SpawnError } from "@runbooks/core/errors"
import { FileSystem } from "@runbooks/core/services/FileSystem"
import {
  type OutputLine,
  ProcessSpawner,
  type ProcessSpawnerShape,
} from "@runbooks/core/services/ProcessSpawner"
import {
  recordFileSystem,
  recordProcessSpawner,
  type ServiceCall,
} from "@runbooks/core/test-utils/ServiceCalls"
import {
  type ProviderCall,
  testCredentialProviders,
} from "@runbooks/core/test-utils/TestCredentialProviders"
import { testFileSystem } from "@runbooks/core/test-utils/TestFileSystem"
import { testSessionStore } from "@runbooks/core/test-utils/TestSessionStore"
import { testSettingsStore } from "@runbooks/core/test-utils/TestSettingsFile"
import { TOY_REGISTRY } from "@runbooks/core/test-utils/toyRegistry"
import { command } from "./block.ts"

// Command through the engine, as a client drives it: the real parser,
// engine, exec domain and run files, over an in-memory file system and a
// spawner that stands in for bash. A spawned "script" does what its test
// says: writes lines to the run files Runbooks named in its environment,
// prints, and exits, or runs until it is stopped. Its real-bash run is in
// cli.test.ts.

const RUNBOOK = "/rb/runbook.mdx"
const REGISTRY = { ...TOY_REGISTRY, Command: command }
const blockId = Schema.decodeSync(BlockId)

/** One spawn: what it was asked to run, where, with what, and the script file's text. */
interface Spawn {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string | undefined
  readonly env: Readonly<Record<string, string | undefined>>
  readonly script: string
  readonly killed: () => boolean
}

/** What a spawned script does. */
interface Does {
  readonly outputs?: ReadonlyArray<string>
  readonly exports?: ReadonlyArray<string>
  readonly prints?: ReadonlyArray<OutputLine>
  /** Unset, it exits 0; "never", it runs until it is stopped. */
  readonly exit?: number | "never"
  /** Set, the spawn fails with it, as Node's does. */
  readonly spawnFails?: Error
}

const fakeBash = (files: ReturnType<typeof testFileSystem>, does: (spawn: Spawn) => Does) => {
  const spawns: Spawn[] = []
  const spawner: ProcessSpawnerShape = {
    spawn: (program, args, options) =>
      Effect.gen(function* () {
        const script = yield* Effect.orDie(files.readFile(args.at(-1)!))
        const env = options?.env ?? {}
        let exited = false
        let killed = false
        const spawn: Spawn = {
          command: program,
          args,
          cwd: options?.cwd,
          env,
          script,
          killed: () => killed,
        }
        spawns.push(spawn)
        const plan = does(spawn)
        if (plan.spawnFails !== undefined)
          return yield* new SpawnError({ command: program, cause: plan.spawnFails })
        const write = (name: string, lines: ReadonlyArray<string> | undefined) =>
          lines === undefined
            ? Effect.void
            : Effect.orDie(files.appendFile(env[name]!, lines.map((l) => `${l}\n`).join("")))
        yield* write("RUNBOOK_OUTPUT", plan.outputs)
        yield* write("RUNBOOK_ENV", plan.exports)
        const ended = yield* Deferred.make<number>()
        if (plan.exit !== "never") yield* Deferred.succeed(ended, plan.exit ?? 0)
        return {
          output: Stream.fromIterable(plan.prints ?? []),
          exitCode: Effect.tap(Deferred.await(ended), () => Effect.sync(() => (exited = true))),
          // As the real spawner: a no-op once the script has ended.
          kill: Effect.suspend(() => {
            if (exited) return Effect.void
            killed = true
            return Deferred.succeed(ended, 1)
          }),
        }
      }),
  }
  return { spawner, spawns }
}

interface Session {
  readonly client: EngineClient
  readonly session: SessionId
  readonly files: Record<string, string>
  readonly spawns: ReadonlyArray<Spawn>
  /** Each call the engine and the block made to the file system and the spawner. */
  readonly calls: ReadonlyArray<ServiceCall>
  /** Each call to a credential provider. */
  readonly providerCalls: ReadonlyArray<ProviderCall>
  readonly run: (block: string) => Effect.Effect<BlockStatus | undefined, unknown>
  readonly start: (block: string) => Effect.Effect<unknown, unknown>
  readonly status: (block: string) => Effect.Effect<BlockStatus | undefined, unknown>
}

/** A session of `runbook` and the files beside it, trusted unless `trusted` is false. */
const withSession = <A>(
  runbook: string,
  use: (s: Session) => Effect.Effect<A, unknown>,
  options: {
    readonly files?: Record<string, string>
    readonly does?: (spawn: Spawn) => Does
    readonly trusted?: boolean
  } = {},
): Promise<A> => {
  const files: Record<string, string> = { [RUNBOOK]: runbook, ...options.files }
  const fs = testFileSystem(files, ["/rb"])
  const bash = fakeBash(fs, options.does ?? (() => ({})))
  const calls: ServiceCall[] = []
  const providerCalls: ProviderCall[] = []
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* makeInProcessClient("person")
        const opened = yield* client.OpenSession({ path: RUNBOOK })
        if (opened._tag !== "Opened") throw new Error(opened.errors.map((e) => e.message).join())
        const { session, trust } = opened.session
        if (options.trusted !== false) yield* client.TrustSession({ session, hash: trust.hash })
        const target = (block: string) => ({ session, block: blockId(block) })
        const status = (block: string) =>
          Effect.map(client.GetBlock(target(block)), (view) => view.status)
        // A form is submitted, not started: it is done at once.
        const start = (block: string) =>
          Effect.flatMap(client.RunBlock(target(block)), (result) =>
            result._tag === "Refused" ? Effect.fail(result) : Effect.void,
          )
        const run = (block: string) =>
          Effect.andThen(
            start(block),
            Effect.map(
              client.WaitForBlock({ ...target(block), timeoutMillis: 10_000 }),
              (ended) => ended.block.status,
            ),
          )
        return yield* use({
          client,
          session,
          files,
          spawns: bash.spawns,
          calls,
          providerCalls,
          run,
          start,
          status,
        })
      }).pipe(
        Effect.provide(
          serveEngine({
            registry: REGISTRY,
            appVersion: "0.31.0",
            workingFolders: "/work",
            stateFolders: "/state",
            processEnvironment: { PATH: "/usr/bin:/bin", HOME: "/home/someone" },
          }),
        ),
        Effect.provide(testCredentialProviders({}, providerCalls)),
        Effect.provide(testSettingsStore()),
        Effect.provide(testSessionStore()),
        Effect.provide(
          Layer.merge(
            Layer.succeed(FileSystem, recordFileSystem(fs, calls)),
            Layer.succeed(ProcessSpawner, recordProcessSpawner(bash.spawner, calls)),
          ),
        ),
      ),
    ),
  )
}

const success: BlockStatus = { _tag: "Done", outcome: "success" }

/** The folders the runs made for their scripts that are still there. */
const scriptFolders = (files: Record<string, string>) =>
  Object.keys(files).filter((file) => file.startsWith("runbooks-command-"))

describe("a command", () => {
  it("runs its script with bash and the log helpers, in the run's folder, with the run's environment", async () => {
    const spawn = await withSession('<Command id="c" command="echo hi" />', (s) =>
      Effect.gen(function* () {
        expect(yield* s.run("c")).toEqual(success)
        expect(scriptFolders(s.files)).toEqual([])
        return s.spawns[0]!
      }),
    )
    expect(spawn.command).toBe("bash")
    expect(spawn.args).toHaveLength(1)
    expect(spawn.script).toMatch(/^\. '[^']*helpers\.sh'; echo hi$/)
    expect(spawn.cwd).toStartWith("/work/")
    expect(Object.keys(spawn.env).sort()).toEqual([
      "HOME",
      "PATH",
      "RUNBOOK_DEBUG_LOG",
      "RUNBOOK_ENV",
      "RUNBOOK_ERROR_LOG",
      "RUNBOOK_INFO_LOG",
      "RUNBOOK_LOG",
      "RUNBOOK_OUTPUT",
      "RUNBOOK_WARN_LOG",
    ])
  })

  it("runs the file its path names as it was when the runbook was trusted", async () => {
    const script = await withSession(
      '<Command id="c" path="scripts/a.sh" />',
      (s) =>
        Effect.gen(function* () {
          s.files["/rb/scripts/a.sh"] = "echo changed after trust"
          expect(yield* s.run("c")).toEqual(success)
          return s.spawns[0]!.script
        }),
      { files: { "/rb/scripts/a.sh": "#!/bin/sh\necho trusted" } },
    )
    expect(script).toMatch(/^\. '[^']*'; #!\/bin\/sh\necho trusted$/)
  })

  it("runs a script for another interpreter with it, and without the log helpers", async () => {
    const spawn = await withSession(
      '<Command id="c" command={"#!/usr/bin/env python3\\nprint(1)"} />',
      (s) => Effect.map(s.run("c"), () => s.spawns[0]!),
    )
    expect(spawn.command).toBe("python3")
    expect(spawn.script).toBe("#!/usr/bin/env python3\nprint(1)")
  })

  it("ends by its exit code: 0 a success, 2 a warning, any other a failure", async () => {
    const ends = await withSession(
      ["zero", "two", "three"].map((id) => `<Command id="${id}" command="${id}" />`).join("\n\n"),
      (s) => Effect.all([s.run("zero"), s.run("two"), s.run("three")]),
      {
        does: ({ script }) => ({
          exit: script.endsWith("zero") ? 0 : script.endsWith("two") ? 2 : 3,
        }),
      },
    )
    expect(ends).toEqual([
      success,
      { _tag: "Done", outcome: "warning" },
      expect.objectContaining({
        _tag: "Failed",
        error: expect.objectContaining({
          _tag: "TaskFailed",
          message: "The script exited with code 3.",
          exitCode: 3,
        }),
      }),
    ])
  })

  it("shows what the script printed, on the stream it printed it to", async () => {
    const log = await withSession(
      '<Command id="c" command="echo" />',
      (s) =>
        Effect.gen(function* () {
          yield* s.run("c")
          const view = yield* s.client.GetBlock({ session: s.session, block: blockId("c") })
          return view.log?.lines.map(({ stream, text }) => [stream, text])
        }),
      {
        does: () => ({
          prints: [
            { line: "out", source: "stdout" },
            { line: "err", source: "stderr" },
            { line: "[INFO]  logged", source: "file" },
          ],
        }),
      },
    )
    expect(log).toEqual([
      ["stdout", "out"],
      ["stderr", "err"],
      ["stderr", "[INFO]  logged"],
    ])
  })
})

describe("its outputs", () => {
  it("are the ones its outputs prop declares, of those it writes", async () => {
    const outputs = await withSession(
      '<Command id="c" command="x" outputs={["kept", "secret"]} />',
      (s) => Effect.andThen(s.run("c"), s.client.GetOutputs({ session: s.session })),
      { does: () => ({ outputs: ["kept=yes", "sensitive:secret=hidden", "undeclared=no"] }) },
    )
    expect(outputs).toEqual({
      c: { kept: { _tag: "Shown", value: "yes" }, secret: { _tag: "Hidden" } },
    })
  })

  it("fail the run when a line cannot be read, and none is published", async () => {
    const [status, outputs] = await withSession(
      '<Command id="c" command="x" outputs={["kept"]} />',
      (s) => Effect.all([s.run("c"), s.client.GetOutputs({ session: s.session })]),
      { does: () => ({ outputs: ["kept=yes", "not a name=value line"] }) },
    )
    expect(status?._tag).toBe("Failed")
    expect(outputs).toEqual({})
  })
})

describe("its environment", () => {
  it("is what its envFrom sources gave, then its own env", async () => {
    const env = await withSession(
      [
        '<Command id="source" command="source" />',
        '<Command id="c" command="c" envFrom={["source"]} env={{ MINE: "own", SHARED: "own" }} />',
      ].join("\n\n"),
      (s) =>
        Effect.gen(function* () {
          yield* s.run("source")
          expect(yield* s.run("c")).toEqual(success)
          return s.spawns[1]!.env
        }),
      {
        does: ({ script }) =>
          script.endsWith("source") ? { exports: ["FROM_SOURCE=1", "SHARED=source"] } : {},
      },
    )
    expect(env).toMatchObject({ FROM_SOURCE: "1", MINE: "own", SHARED: "own" })
  })
})

describe("its {{ }} values", () => {
  const FORM = [
    '<Form id="config">',
    "```yaml",
    "- name: region",
    "  type: string",
    '  default: "us-east-1; $(touch pwned)"',
    "```",
    "</Form>",
  ].join("\n")

  it("are variables the script expands, quoted where each stands", async () => {
    const spawn = await withSession(
      [
        FORM,
        '<Command id="source" command="source" outputs={["k"]} />',
        `<Command id="c" inputsId={["config"]} command={"echo {{ .inputs.region }} '{{ .outputs.source.k }}'"} />`,
      ].join("\n\n"),
      (s) =>
        Effect.gen(function* () {
          yield* s.run("config")
          yield* s.run("source")
          expect(yield* s.run("c")).toEqual(success)
          return s.spawns[1]!
        }),
      { does: ({ script }) => (script.endsWith("source") ? { outputs: ["k=it's"] } : {}) },
    )
    expect(spawn.script).toEndWith(`; echo "\${RUNBOOK_VALUE_1}" ''"\${RUNBOOK_VALUE_2}"''`)
    expect(spawn.env["RUNBOOK_VALUE_1"]).toBe("us-east-1; $(touch pwned)")
    expect(spawn.env["RUNBOOK_VALUE_2"]).toBe("it's")
  })

  it("insert an optional field left empty as one empty word, and the block runs", async () => {
    const [status, spawn] = await withSession(
      [
        [
          '<Form id="config">',
          "```yaml",
          "- name: suffix",
          "  type: string",
          "```",
          "</Form>",
        ].join("\n"),
        `<Command id="c" inputsId={["config"]} command={"printf '<%s>' {{ .inputs.suffix }}"} />`,
      ].join("\n\n"),
      (s) =>
        Effect.gen(function* () {
          yield* s.run("config")
          return [yield* s.run("c"), s.spawns[0]!] as const
        }),
    )
    expect(status).toEqual(success)
    expect(spawn.script).toEndWith(`; printf '<%s>' "\${RUNBOOK_VALUE_1}"`)
    expect(spawn.env["RUNBOOK_VALUE_1"]).toBe("")
  })

  it("fail the run at each place Runbooks cannot insert, before anything starts", async () => {
    const [status, spawns] = await withSession(
      '<Command id="c" path="a.sh" />',
      (s) => Effect.all([s.run("c"), Effect.sync(() => s.spawns.length)]),
      { files: { "/rb/a.sh": "echo ok\n{{ if .inputs.region }}x{{ end }}" } },
    )
    expect(status).toMatchObject({ _tag: "Failed", error: { _tag: "TaskFailed" } })
    const message = status?._tag === "Failed" ? (status.error as { message: string }).message : ""
    const [first, second, ...rest] = message.split("\n")
    expect(first).toStartWith("a.sh, line 2, column 1: `{{ if .inputs.region }}` is not a value")
    expect(second).toStartWith("a.sh, line 2, column 25: `{{ end }}` is not a value")
    expect(rest).toEqual([])
    expect(spawns).toBe(0)
  })
})

describe("stopping it", () => {
  it("when cancelled, stops the script and every process it started, and removes its folder", async () => {
    const [status, killed, folders] = await withSession(
      '<Command id="c" command="sleep 600" />',
      (s) =>
        Effect.gen(function* () {
          yield* s.start("c")
          while (s.spawns.length === 0) yield* Effect.sleep(5)
          yield* s.client.CancelBlock({ session: s.session, block: blockId("c") })
          const { block } = yield* s.client.WaitForBlock({
            session: s.session,
            block: blockId("c"),
            timeoutMillis: 10_000,
          })
          return [block.status, s.spawns[0]!.killed(), scriptFolders(s.files)] as const
        }),
      { does: () => ({ exit: "never" }) },
    )
    expect(status).toMatchObject({ _tag: "Failed", error: { _tag: "TaskCancelled" } })
    expect(killed).toBe(true)
    expect(folders).toEqual([])
  })

  it("at timeoutMs, stops it as a cancel does, and says it timed out", async () => {
    const [status, killed] = await withSession(
      '<Command id="c" command="sleep 600" timeoutMs={50} />',
      (s) => Effect.all([s.run("c"), Effect.sync(() => s.spawns[0]!.killed())]),
      { does: () => ({ exit: "never" }) },
    )
    expect(status).toMatchObject({
      _tag: "Failed",
      error: { _tag: "TaskTimedOut", afterMillis: 50 },
    })
    expect(killed).toBe(true)
  })

  it("leaves a script that ended alone", async () => {
    const killed = await withSession('<Command id="c" command="true" />', (s) =>
      Effect.andThen(
        s.run("c"),
        Effect.sync(() => s.spawns[0]!.killed()),
      ),
    )
    expect(killed).toBe(false)
  })
})

describe("a command that cannot run", () => {
  const MISCONFIGURED = [
    '<Command id="both" command="x" path="a.sh" />',
    '<Command id="neither" />',
    '<Command id="named" command="x" outputs={["1st"]} />',
    '<Command id="slow" command="x" timeoutMs={0} />',
  ].join("\n\n")

  it("is a configuration error, saying what to change", () => {
    const parsed = parseRunbook(MISCONFIGURED, REGISTRY, { file: RUNBOOK, appVersion: "0.31.0" })
    const messages = configErrors(parsed)
      .filter((e) => e.code === "badProp")
      .map((e) => e.message)
    expect(messages).toEqual([
      expect.stringContaining("set `command` or `path`, not both"),
      expect.stringContaining("set `command`, the script itself, or `path`"),
      expect.stringContaining("an output's name is letters, digits and `_`"),
      expect.stringContaining("the `timeoutMs` prop of <Command>"),
    ])
  })

  it("is refused, and starts nothing", async () => {
    const [refusals, spawns] = await withSession(
      MISCONFIGURED,
      (s) =>
        Effect.all([
          Effect.forEach(["both", "neither", "named", "slow"], (id) => Effect.flip(s.start(id))),
          Effect.sync(() => s.spawns.length),
        ]),
      { files: { "/rb/a.sh": "echo" } },
    )
    expect(refusals).toEqual(Array(4).fill({ _tag: "Refused", reason: { _tag: "Misconfigured" } }))
    expect(spawns).toBe(0)
  })

  it("fails a run whose script could not start by the error's code, never quoting the environment", async () => {
    const status = await withSession('<Command id="c" command="echo hi" />', (s) => s.run("c"), {
      does: () => ({
        spawnFails: Object.assign(
          new Error(
            "The argument 'options.env['RUNBOOK_VALUE_0']' must be a string without null bytes. Received 'hunter2\\x00'",
          ),
          { code: "ERR_INVALID_ARG_VALUE" },
        ),
      }),
    })
    expect(status).toMatchObject({
      _tag: "Failed",
      error: {
        _tag: "TaskFailed",
        message: "Runbooks could not start bash: ERR_INVALID_ARG_VALUE.",
      },
    })
    expect(JSON.stringify(status)).not.toContain("hunter2")
  })

  it("is refused before the session is trusted, having read nothing but the runbook", async () => {
    const [refusal, calls, providerCalls] = await withSession(
      '<Command id="c" command="echo hi" />',
      (s) =>
        Effect.all([
          Effect.flip(s.start("c")),
          Effect.sync(() => [...s.calls]),
          Effect.sync(() => [...s.providerCalls]),
        ]),
      { trusted: false },
    )
    expect(refusal).toMatchObject({ _tag: "Refused" })
    expect(calls).toEqual([{ service: "FileSystem", method: "readFile", args: [RUNBOOK] }])
    expect(providerCalls).toEqual([])
  })
})

describe("in instruction mode", () => {
  it("shows the script as the runbook was trusted with it", () => {
    const path = Schema.decodeSync(RunbookPath)("a.sh")
    const reads = {
      values: {},
      outputs: new Map(),
      files: new Map([["a.sh", "#!/usr/bin/env python3\nprint(1)"]]),
    }
    expect(command.instruction({ path }, reads)).toEqual([
      { kind: "code", language: "python3", code: "#!/usr/bin/env python3\nprint(1)" },
    ])
    expect(command.instruction({ command: "echo hi" }, reads)).toEqual([
      { kind: "code", language: "bash", code: "echo hi" },
    ])
  })
})
