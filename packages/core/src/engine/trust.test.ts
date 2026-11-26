/**
 * What an untrusted session may touch. A runbook someone sends you opens
 * before you trust it, so opening it, and every command a client may send
 * before trust, must read the runbook and the files it names and do nothing
 * else: it detects no login and opens no credential provider. The services
 * are doubles that note every call, so each test asserts on all the I/O the
 * engine did.
 */
import { describe, expect, it } from "bun:test"
import { Effect, Fiber, Layer, Option, Schema, Stream } from "effect"
import YAML from "yaml"
import {
  BlockId,
  defineForm,
  defineTask,
  PropError,
  RunbookPath,
  TaskFailed,
} from "@runbooks/blocks-core/contract"
import type { ProviderInfo } from "../credential/provider.ts"
import { FileSystem } from "../services/FileSystem.ts"
import { ProcessSpawner } from "../services/ProcessSpawner.ts"
import {
  recordFileSystem,
  recordProcessSpawner,
  type ServiceCall,
} from "../test-utils/ServiceCalls.ts"
import { stateDirOf } from "../credential/stateDir.ts"
import {
  type ProviderCall,
  testCredentialProviders,
} from "../test-utils/TestCredentialProviders.ts"
import { testFileSystem } from "../test-utils/TestFileSystem.ts"
import { testSettingsStore } from "../test-utils/TestSettingsFile.ts"
import { testSessionStore } from "../test-utils/TestSessionStore.ts"
import { TOY_REGISTRY, ToyField, toyFormSpec } from "../test-utils/toyRegistry.ts"
import { Engine } from "./engine.ts"
import { RUN_FILE_LIMITS } from "./runFiles.ts"
import { Caller, type RunResult } from "./protocol.ts"

const RUNBOOK = "/rb/runbook.mdx"
const blockId = Schema.decodeSync(BlockId)
const toPath = Schema.decodeSync(RunbookPath)
const decodeFields = Schema.decodeUnknownEffect(Schema.Array(ToyField))

/** A form whose fields are the YAML file its `path` names, as a template's `boilerplate.yml`. */
const fileForm = defineForm({
  name: "FileForm",
  since: "0.1.0",
  class: "form",
  props: Schema.Struct({ path: Schema.String }),
  children: { kind: "none" },
  references: {},
  runbookFiles: (p) => [toPath(p.path)],
  provides: ["values"],
  effects: [],
  outputs: () => ({}),
  fields: (p, files) => {
    const text = files.get(p.path)
    if (text === undefined)
      return Effect.fail(new PropError({ prop: "path", message: `${p.path} was not read.` }))
    return decodeFields(YAML.parse(text)).pipe(
      Effect.map(toyFormSpec),
      Effect.mapError((issue) => new PropError({ prop: "path", message: String(issue) })),
    )
  },
  plugins: [],
})

const failed = (what: string) => (cause: { readonly message: string }) =>
  new TaskFailed({ message: `${what}: ${cause.message}` })

/** A task that runs the script its `path` names, writing a log in the working folder first. */
const script = defineTask({
  name: "Script",
  since: "0.1.0",
  class: "task",
  props: Schema.Struct({ path: Schema.String }),
  children: { kind: "none" },
  references: {},
  runbookFiles: (p) => [toPath(p.path)],
  provides: ["run"],
  effects: ["process", "files"],
  outputs: () => ({}),
  paths: (p) => ({
    script: { root: "runbook", path: p.path },
    log: { root: "working", path: "run.log" },
  }),
  run: (_p, input) =>
    Stream.fromEffectDrain(
      Effect.gen(function* () {
        const fs = yield* FileSystem
        const spawner = yield* ProcessSpawner
        yield* fs
          .writeFile(input.paths.log, JSON.stringify(input.values))
          .pipe(Effect.mapError(failed("The log could not be written")))
        const process = yield* spawner
          .spawn("bash", [input.paths.script], { cwd: input.cwd })
          .pipe(Effect.mapError(failed("The script could not start")))
        const exitCode = yield* process.exitCode
        if (exitCode !== 0)
          return yield* new TaskFailed({ message: "The script failed.", exitCode })
      }),
    ),
  instruction: (p) => [{ kind: "code", language: "bash", code: `bash ${p.path}` }],
  plugins: [],
})

/** A block of each class: Note, Form and FileForm, Script, GitLogin and CloudLogin. */
const registry = { ...TOY_REGISTRY, FileForm: fileForm, Script: script }

const FILES = {
  [RUNBOOK]: [
    '<Note title="Before you start">Read the script.</Note>',
    '<Form id="config">\n```yaml\n- name: stage\n  type: string\n  default: dev\n```\n</Form>',
    '<FileForm id="vars" path="vars.yml" />',
    '<GitLogin id="git" />',
    '<CloudLogin id="cloud" />',
    '<Script id="deploy" path="deploy.sh" inputsId={["config", "vars"]} />',
  ].join("\n\n"),
  "/rb/vars.yml": "- name: region\n  type: string\n  default: us-east-1\n",
  "/rb/deploy.sh": "echo deploying\n",
}

const FileSystemCall = (method: string, ...args: ReadonlyArray<unknown>): ServiceCall => ({
  service: "FileSystem",
  method,
  args,
})

/** Reading the runbook, then each file it names: is it there, is it inside the folder, its bytes to hash. */
const READING_THE_RUNBOOK: ServiceCall[] = [
  FileSystemCall("readFile", RUNBOOK),
  ...["/rb/vars.yml", "/rb/deploy.sh"].flatMap((file) => [
    FileSystemCall("stat", file),
    FileSystemCall("realpath", file),
    FileSystemCall("realpath", "/rb"),
    FileSystemCall("readFileBuffer", file),
  ]),
]

/** Trusted, each credential block's state folder is made owner-only before its provider opens. */
const STATE_FOLDERS = (session: string): ServiceCall[] =>
  ["git", "cloud"].flatMap((block) => {
    const folder = stateDirOf(`/state/${session}`, blockId(block))
    return [
      FileSystemCall("mkdir", folder, { recursive: true, mode: 0o700 }),
      FileSystemCall("stat", folder),
    ]
  })

/** A provider with one sign-in method that finds no login. */
const INFO: ProviderInfo = {
  methods: [{ name: "token", label: "Token", fields: [] }],
  levels: [],
  sources: [],
  requirements: [],
  names: [],
}

/**
 * Runs `program` against an engine whose services note each call in
 * `calls`, and whose credential providers note theirs in `providerCalls`.
 */
const withEngine = <A, E>(
  calls: ServiceCall[],
  providerCalls: ProviderCall[],
  program: Effect.Effect<A, E, Engine | Caller>,
) =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(
        Engine.layer({
          registry,
          appVersion: "0.31.0",
          workingFolders: "/work",
          stateFolders: "/state",
          processEnvironment: {},
        }),
      ),
      Effect.provide(
        testCredentialProviders(
          { git: () => ({ info: INFO }), cloud: () => ({ info: INFO }) },
          providerCalls,
        ),
      ),
      Effect.provide(testSettingsStore()),
      Effect.provide(testSessionStore()),
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(FileSystem, recordFileSystem(testFileSystem({ ...FILES }, ["/rb"]), calls)),
          Layer.succeed(
            ProcessSpawner,
            recordProcessSpawner(
              {
                spawn: () =>
                  Effect.succeed({
                    output: Stream.empty,
                    exitCode: Effect.succeed(0),
                    kill: Effect.void,
                  }),
              },
              calls,
            ),
          ),
        ),
      ),
      Effect.provideService(Caller, { origin: "person" }),
    ),
  )

const BLOCKS = ["config", "vars", "git", "cloud", "deploy"]

describe("an untrusted session", () => {
  it("reads only the runbook and the files it names, whatever a client sends, until it is trusted", async () => {
    const calls: ServiceCall[] = []
    const providerCalls: ProviderCall[] = []
    await withEngine(
      calls,
      providerCalls,
      Effect.gen(function* () {
        const engine = yield* Engine
        const opened = yield* engine.openSession({ path: RUNBOOK })
        if (opened._tag !== "Opened") throw new Error(opened.errors.map((e) => e.message).join())
        const { session, trust } = opened.session
        const target = (block: string) => ({ session, block: blockId(block) })
        const events = yield* Effect.forkChild(Stream.runCollect(engine.events({ session })))

        // Every command a client may send before trust.
        yield* engine.listSessions
        yield* engine.getSession({ session })
        for (const block of BLOCKS) yield* engine.getBlock(target(block))
        yield* engine.setValues({ ...target("config"), values: { stage: "prod" } })
        yield* engine.setValues({ ...target("vars"), values: { region: "eu-west-1" } })
        yield* engine.confirmValues(target("vars"))
        const refused: RunResult[] = []
        for (const block of ["config", "vars", "deploy"])
          refused.push(yield* engine.runBlock(target(block)))
        yield* engine.cancelBlock(target("deploy"))
        yield* engine.resetBlock(target("deploy"))
        yield* engine.waitForBlock({ ...target("deploy"), timeoutMillis: 10 })
        yield* engine.getOutputs({ session })
        const acted = []
        for (const action of [{ _tag: "CheckAgain" }, { _tag: "SignOut" }] as const)
          acted.push(yield* engine.actOnCredential({ ...target("cloud"), action }))

        expect(calls).toEqual(READING_THE_RUNBOOK)
        expect(providerCalls).toEqual([])
        expect(acted).toEqual([
          { _tag: "NotAllowed", state: "Blocked" },
          { _tag: "NotAllowed", state: "Blocked" },
        ])
        const untrusted: RunResult = {
          _tag: "Refused",
          reason: { _tag: "Blocked", by: [{ _tag: "Untrusted" }] },
        }
        expect(refused).toEqual([untrusted, untrusted, untrusted])

        yield* engine.trustSession({ session, hash: trust.hash })
        // Trusted, each credential block opens its provider, and one that detects looks.
        for (const block of ["git", "cloud"])
          yield* engine.waitForBlock({ ...target(block), timeoutMillis: 5000 })
        expect(calls).toEqual([...READING_THE_RUNBOOK, ...STATE_FOLDERS(session)])
        const byBlock = (block: string) =>
          providerCalls.filter((call) => call.block === block).map((call) => call.method)
        expect(byBlock("git")).toEqual(["open", "describe"])
        expect(byBlock("cloud")).toEqual(["open", "describe", "detect"])
        expect(providerCalls.find((call) => call.method === "detect")?.args[0]).toEqual([
          { kind: "env", prefix: Option.none() },
        ])

        for (const form of ["config", "vars"])
          expect((yield* engine.runBlock(target(form)))._tag).toBe("Submitted")
        expect((yield* engine.runBlock(target("deploy")))._tag).toBe("Started")
        const ran = yield* engine.waitForBlock({ ...target("deploy"), timeoutMillis: 5000 })
        expect(ran.block.status).toEqual({ _tag: "Done", outcome: "success" })

        const working = `/work/${session}`
        // The folder the engine makes for the files and the folder the script writes to.
        const runFolder = expect.stringMatching(/^runbooks-run-\w+$/)
        const runFile = (name: string) =>
          expect.stringMatching(new RegExp(`^runbooks-run-\\w+/${name}$`))
        expect(calls).toEqual([
          ...READING_THE_RUNBOOK,
          ...STATE_FOLDERS(session),
          FileSystemCall("mkdir", working, { recursive: true }),
          FileSystemCall("isContainedInReal", "/rb/deploy.sh", "/rb"),
          FileSystemCall("isContainedInReal", `${working}/run.log`, working),
          FileSystemCall("mkdtemp", "runbooks-run-"),
          FileSystemCall("writeFile", runFile("output"), ""),
          FileSystemCall("writeFile", runFile("env"), ""),
          FileSystemCall("mkdir", runFile("files")),
          FileSystemCall(
            "writeFile",
            `${working}/run.log`,
            '{"stage":"prod","region":"eu-west-1"}',
          ),
          {
            service: "ProcessSpawner",
            method: "spawn",
            args: ["bash", ["/rb/deploy.sh"], { cwd: working }],
          },
          FileSystemCall("readFileUpTo", runFile("output"), RUN_FILE_LIMITS.bytes),
          FileSystemCall("readFileUpTo", runFile("env"), RUN_FILE_LIMITS.bytes),
          FileSystemCall("walk", runFile("files")),
          FileSystemCall("rm", runFolder, { recursive: true, force: true }),
        ])
        yield* engine.closeSession({ session })
        yield* Fiber.join(events)
      }),
    )
  })

  // useGoogleAuth.test.ts
  it("waits for the session before probing anything", async () => {
    const calls: ServiceCall[] = []
    const providerCalls: ProviderCall[] = []
    await withEngine(
      calls,
      providerCalls,
      Effect.gen(function* () {
        const engine = yield* Engine
        const opened = yield* engine.openSession({ path: RUNBOOK })
        if (opened._tag !== "Opened") throw new Error(opened.errors.map((e) => e.message).join())
        const { session, trust } = opened.session
        const cloud = { session, block: blockId("cloud") }

        const before = yield* engine.getBlock(cloud)
        expect(before.status).toEqual({ _tag: "Blocked", by: [{ _tag: "Untrusted" }] })
        expect(before.credential).toBeUndefined()
        expect(before.actions).toEqual([])
        expect(providerCalls).toEqual([])

        yield* engine.trustSession({ session, hash: trust.hash })
        const after = yield* engine.waitForBlock({ ...cloud, timeoutMillis: 5000 })
        expect(after.block.credential?._tag).toBe("SignedOut")
        expect(after.block.actions).toEqual(["credential"])
        expect(calls).toEqual([...READING_THE_RUNBOOK, ...STATE_FOLDERS(session)])
        yield* engine.closeSession({ session })
      }),
    )
    expect(
      providerCalls.filter((call) => call.block === "cloud").map((call) => call.method),
    ).toEqual(["open", "describe", "detect"])
  })
})
