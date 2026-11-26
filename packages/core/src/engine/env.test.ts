/**
 * A run's environment (work product 2.4). The engine tests run toy tasks
 * that note the environment they were given; a credential source is tested
 * through its seam with a toy handle, and `credentials.test.ts` runs one in
 * a session. Four tests are today's security regression tests for the
 * script environment allowlist, by name.
 */
import { describe, expect, it } from "bun:test"
import { Effect, Layer, Option, Redacted, Result, Schema } from "effect"
import { BlockId, CredentialError } from "@runbooks/blocks-core/contract"
import type { BlockStatus } from "@runbooks/blocks-core/status"
import type { CredentialEnv, CredentialValue } from "../credential/provider.ts"
import { revealed, type UseEnvSession, withEnvSession } from "../test-utils/envSessions.ts"
import { FileWriteError } from "../errors/index.ts"
import { FileSystem } from "../services/FileSystem.ts"
import { makeTestFileSystem, testFileSystem } from "../test-utils/TestFileSystem.ts"
import { makeRecordingSpawner, type RecordedSpawn } from "../test-utils/TestSpawner.ts"
import { TOY_REGISTRY } from "../test-utils/toyRegistry.ts"
import {
  type BaseEnvironment,
  baseEnvironment,
  buildRunEnv,
  type CredentialHandle,
  credentialSource,
  type EnvSource,
  providerEnvironment,
  taskSource,
  withReserved,
} from "./env.ts"
import { type FileChange, LIMITS } from "./protocol.ts"

const RUNBOOK = "/rb/runbook.mdx"
const blockId = Schema.decodeSync(BlockId)

// ---------------------------------------------------------------------------
// Through the engine
// ---------------------------------------------------------------------------

/** Each spawn a `Shell` block made, with the env it handed the spawner. */
let spawns: RecordedSpawn[] = []

/** A trusted session of `runbook`, its engine given `processEnvironment`. */
const withSession = <A>(
  runbook: string,
  processEnvironment: Readonly<Record<string, string>>,
  use: UseEnvSession<A>,
): Promise<A> => {
  const spawner = makeRecordingSpawner(() => ({ lines: [], exitCode: 0 }))
  spawns = spawner.calls
  return withEnvSession(
    {
      file: RUNBOOK,
      workingFolders: "/work",
      processEnvironment,
      fileSystem: makeTestFileSystem({ [RUNBOOK]: runbook }),
      spawner: spawner.layer,
    },
    use,
  )
}

const done: BlockStatus = { _tag: "Done", outcome: "success" }

/** An app environment with the toy GitLogin's credentials and a reserved name in it. */
const AMBIENT = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/someone",
  GITHUB_TOKEN: "ghp_ambient",
  GITLAB_TOKEN: "glpat_ambient",
  RUNBOOK_OUTPUT: "/outer/run/output",
  GENERATED_FILES: "/outer/run/files",
}

describe("the base environment", () => {
  // Today's electron/main/ipc/session-env.test.ts guard "strips inherited AWS
  // credentials for a runbook with <AwsAuth>, and only for it". Ambient
  // credentials are now stripped for every runbook (ruled 2026-11-23), so
  // "and only for it" no longer holds and the name says what does.
  it("strips inherited credentials for every runbook, with a credential block or without one", async () => {
    const withLogin = '<GitLogin id="git" />\n\n<Run id="a" command="a" />'
    const without = '<Run id="a" command="a" />'
    for (const runbook of [withLogin, without]) {
      const env = await withSession(runbook, AMBIENT, (rb) =>
        Effect.gen(function* () {
          expect(yield* rb.run("a")).toEqual(done)
          return rb.envOf("a")
        }),
      )
      expect(env).toEqual({ PATH: "/usr/bin:/bin", HOME: "/home/someone" })
    }
  })

  it("strips the names of a credential block an alias locks, and keeps every other name", () => {
    const registry = {
      Still: TOY_REGISTRY.Run,
      GitHubLogin: TOY_REGISTRY.GitHubLogin,
      GitLogin: TOY_REGISTRY.GitLogin,
    }
    const base = baseEnvironment({ ...AMBIENT, GITHUB_TOKENS: "kept" }, registry)
    expect(Array.from(base.keys()).sort()).toEqual(["GITHUB_TOKENS", "HOME", "PATH"])
    expect(baseEnvironment(AMBIENT, { Still: TOY_REGISTRY.Run }).has("GITHUB_TOKEN")).toBe(true)
  })
})

describe("a provider's environment", () => {
  const base = baseEnvironment({ ...AMBIENT, CLOUD_TOKEN: "tok-ambient" }, TOY_REGISTRY)
  const shown = (env: BaseEnvironment) =>
    Object.fromEntries(Array.from(env, ([name, value]) => [name, Redacted.value(value)]))

  it("is the base environment and the block's own names, taken back from the process's", () => {
    const env = providerEnvironment(base, { ...AMBIENT, CLOUD_TOKEN: "tok-ambient" }, [
      "CLOUD_TOKEN",
      "CLOUD_ACCOUNT",
    ])
    expect(shown(env)).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/home/someone",
      CLOUD_TOKEN: "tok-ambient",
    })
  })

  it("holds no other credential block's names, and no reserved name, even one the block declares", () => {
    const env = providerEnvironment(base, AMBIENT, ["GITLAB_TOKEN", "RUNBOOK_OUTPUT"])
    expect(shown(env)).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/home/someone",
      GITLAB_TOKEN: "glpat_ambient",
    })
    expect(providerEnvironment(base, AMBIENT, []).has("GITHUB_TOKEN")).toBe(false)
  })
})

describe("a run's environment", () => {
  it("is the base, then each envFrom source in the order written, then its own env", async () => {
    const runbook = (order: string) =>
      [
        '<Run id="first" command="first" args={["X=first", "ONLY_FIRST=1"]} />',
        '<Run id="second" command="second" args={["X=second", "ONLY_SECOND=2"]} />',
        `<Run id="c" command="c" envFrom={${order}} env={{ MINE: "own", ONLY_FIRST: "own" }} />`,
      ].join("\n\n")
    const run = (order: string) =>
      withSession(runbook(order), { PATH: "/usr/bin", X: "base" }, (rb) =>
        Effect.gen(function* () {
          yield* rb.run("first")
          yield* rb.run("second")
          expect(yield* rb.run("c")).toEqual(done)
          return rb.envOf("c")
        }),
      )
    expect(await run('["first", "second"]')).toEqual({
      PATH: "/usr/bin",
      X: "second",
      ONLY_FIRST: "own",
      ONLY_SECOND: "2",
      MINE: "own",
    })
    expect((await run('["second", "first"]'))["X"]).toBe("first")
  })

  it("gives a block only what its sources exported, not what they got from theirs", async () => {
    const runbook = [
      '<Run id="a" command="a" args={["FROM_A=a"]} />',
      '<Run id="b" command="b" envFrom={["a"]} args={["FROM_B=b"]} />',
      '<Run id="c" command="c" envFrom={["b"]} />',
    ].join("\n\n")
    await withSession(runbook, {}, (rb) =>
      Effect.gen(function* () {
        yield* rb.run("a")
        yield* rb.run("b")
        yield* rb.run("c")
        expect(rb.envOf("b")).toEqual({ FROM_A: "a" })
        expect(rb.envOf("c")).toEqual({ FROM_B: "b" })
      }),
    )
  })

  it("waits for each source to be done, and again once one is reset", async () => {
    const runbook = [
      '<Run id="a" command="a" args={["X=1"]} />',
      '<Run id="c" command="c" envFrom={["a"]} />',
    ].join("\n\n")
    await withSession(runbook, {}, (rb) =>
      Effect.gen(function* () {
        const waiting: BlockStatus = {
          _tag: "Blocked",
          by: [{ _tag: "WaitingFor", block: blockId("a"), capability: "env" }],
        }
        expect(yield* rb.status("c")).toEqual(waiting)
        yield* rb.run("a")
        expect(yield* rb.status("c")).toEqual({ _tag: "Idle" })
        yield* rb.reset("a")
        expect(yield* rb.status("c")).toEqual(waiting)
      }),
    )
  })

  // A credential block gives a run its variables only while it is Ready.
  // This one's provider does not exist, so it is Unavailable.
  it("waits for a credential block it names", async () => {
    const runbook = '<GitLogin id="git" />\n\n<Run id="c" command="c" envFrom={["git"]} />'
    await withSession(runbook, AMBIENT, (rb) =>
      Effect.gen(function* () {
        yield* rb.until("git", "Unavailable")
        expect(yield* rb.status("c")).toEqual({
          _tag: "Blocked",
          by: [{ _tag: "WaitingFor", block: blockId("git"), capability: "env" }],
        })
      }),
    )
  })

  it("takes what a source's latest run exported", async () => {
    const runbook = [
      '<Run id="a" command="a" args={["X=run #"]} />',
      '<Run id="c" command="c" envFrom={["a"]} />',
    ].join("\n\n")
    await withSession(runbook, {}, (rb) =>
      Effect.gen(function* () {
        yield* rb.run("a")
        yield* rb.run("c")
        expect(rb.envOf("c")).toEqual({ X: "run 1" })
        yield* rb.run("a")
        yield* rb.run("c")
        expect(rb.envOf("c")).toEqual({ X: "run 2" })
      }),
    )
  })

  // Today's electron/main/ipc/session-env.test.ts guard, by name. There is no
  // session environment now: what a block gets for its run reaches no other.
  it("does not write a run's block-scoped env overrides into the session", async () => {
    const runbook = [
      '<Run id="src" command="src" args={["TOKEN=from-src"]} />',
      '<Run id="a" command="a" envFrom={["src"]} env={{ STAGE: "dev" }} args={["OWN=a"]} />',
      '<Run id="later" command="later" dependsOn={["a"]} />',
    ].join("\n\n")
    await withSession(runbook, { PATH: "/usr/bin" }, (rb) =>
      Effect.gen(function* () {
        yield* rb.run("src")
        yield* rb.run("a")
        yield* rb.run("later")
        expect(rb.envOf("a")).toEqual({ PATH: "/usr/bin", TOKEN: "from-src", STAGE: "dev" })
        expect(rb.envOf("later")).toEqual({ PATH: "/usr/bin" })
      }),
    )
  })

  it("never lets a source set a name Runbooks sets for every run", async () => {
    const runbook = [
      '<Run id="a" command="a" args={["RUNBOOK_OUTPUT=/elsewhere", "REPO_FILES=/x", "OK=1"]} />',
      '<Run id="c" command="c" />',
    ].join("\n\n")
    await withSession(runbook, AMBIENT, (rb) =>
      Effect.gen(function* () {
        expect(yield* rb.run("a")).toMatchObject({
          _tag: "Failed",
          error: {
            _tag: "TaskFailed",
            message: [
              "The script wrote what Runbooks cannot read, so the run failed.",
              "$RUNBOOK_ENV line 1: RUNBOOK_OUTPUT is a variable Runbooks sets for every script.",
              "$RUNBOOK_ENV line 2: REPO_FILES is a variable Runbooks sets for every script.",
            ].join("\n"),
          },
        })
        // The app's RUNBOOK_OUTPUT is not the run's: the engine's file is.
        expect(yield* rb.run("c")).toEqual(done)
        expect(rb.runFilesOf("c")).toEqual({
          RUNBOOK_OUTPUT: expect.stringMatching(/^runbooks-run-\w+\/output$/),
          RUNBOOK_ENV: expect.stringMatching(/^runbooks-run-\w+\/env$/),
          GENERATED_FILES: expect.stringMatching(/^runbooks-run-\w+\/files$/),
        })
      }),
    )
  })

  it("gives a task that starts no process no environment", async () => {
    await withSession('<Still id="s" command="s" />', AMBIENT, (rb) =>
      Effect.gen(function* () {
        expect(yield* rb.run("s")).toEqual(done)
        expect(rb.envOf("s")).toEqual({})
      }),
    )
  })

  it("warns once per run for each variable two sources set, naming both and no value", async () => {
    const runbook = [
      '<Run id="first" command="first" args={["X=secret-one", "Y=1"]} />',
      '<Run id="second" command="second" args={["X=secret-two"]} />',
      '<Run id="c" command="c" envFrom={["first", "second"]} />',
    ].join("\n\n")
    const events = await withSession(runbook, { BASE: "secret-base" }, (rb) =>
      Effect.gen(function* () {
        yield* rb.run("first")
        yield* rb.run("second")
        yield* rb.run("c")
        return yield* rb.close
      }),
    )
    const warnings = events.flatMap(({ event }) => (event._tag === "Warning" ? [event] : []))
    expect(warnings.map(({ warning }) => [warning.code, warning.location.prop])).toEqual([
      ["envConflict", "envFrom"],
    ])
    expect(warnings[0]?.warning.location.block).toEqual({ tag: "Run", id: "c" })
    expect(warnings[0]?.warning.message).toContain("X")
    expect(warnings[0]?.warning.message).toContain("first")
    expect(warnings[0]?.warning.message).toContain("second")
    const log = JSON.stringify(events)
    for (const secret of ["secret-one", "secret-two", "secret-base"])
      expect(log).not.toContain(secret)
  })

  it("is the whole environment a block hands its process", async () => {
    await withSession(
      '<Shell id="s" label="s" script="true" env={{ OWN: "own" }} />',
      AMBIENT,
      (rb) =>
        Effect.gen(function* () {
          expect(yield* rb.run("s")).toEqual(done)
          expect(spawns.map(({ env }) => env)).toEqual([
            {
              PATH: "/usr/bin:/bin",
              HOME: "/home/someone",
              OWN: "own",
              RUNBOOK_OUTPUT: expect.stringMatching(/\/output$/),
              RUNBOOK_ENV: expect.stringMatching(/\/env$/),
              GENERATED_FILES: expect.stringMatching(/\/files$/),
            },
          ])
        }),
    )
  })

  it("holds every value redacted until the block reads it", async () => {
    await withSession(
      '<Run id="c" command="c" env={{ OWN: "secret-own" }} />',
      { BASE: "secret-base" },
      (rb) =>
        Effect.gen(function* () {
          yield* rb.run("c")
          const env = rb.inputOf("c")?.env ?? {}
          expect(Object.values(env).every(Redacted.isRedacted)).toBe(true)
          expect(JSON.stringify(env)).not.toContain("secret")
        }),
    )
  })
})

// ---------------------------------------------------------------------------
// Its own env's values
// ---------------------------------------------------------------------------

/** A form whose region would run a command if a shell read it as code. */
const CONFIG = [
  '<Form id="config">',
  "```yaml",
  "- name: region",
  "  type: string",
  '  default: "us-east-1; $(touch pwned)"',
  "- name: count",
  "  type: int",
  "  default: 3",
  "- name: tags",
  "  type: map",
  "  default: { env: prod }",
  "```",
  "</Form>",
].join("\n")

describe("a run's env values", () => {
  it("fill in each {{ }} from the forms the block reads and the outputs it names", async () => {
    const runbook = [
      CONFIG,
      `<Script id="s" label="s" writesOutput={["k=it's"]} declares={["k"]} />`,
      [
        '<Run id="c" command="c" inputsId={["config"]} env={{',
        '  REGION: "{{ .inputs.region }}",',
        '  COUNT: "{{ .inputs.count }}",',
        '  ENV: "{{ .inputs.tags.env }}",',
        '  URL: "s3://{{ .outputs.s.k }}/logs",',
        "  FORMAT: '{{ \"{{\" }}.Names}}',",
        '  TRIMMED: "a  {{- .inputs.count -}}  b",',
        "}} />",
      ].join("\n"),
    ].join("\n\n")
    await withSession(runbook, {}, (rb) =>
      Effect.gen(function* () {
        yield* rb.run("s")
        expect(yield* rb.run("c")).toEqual(done)
        expect(rb.envOf("c")).toEqual({
          REGION: "us-east-1; $(touch pwned)",
          COUNT: "3",
          ENV: "prod",
          URL: "s3://it's/logs",
          FORMAT: "{{.Names}}",
          TRIMMED: "a3b",
        })
      }),
    )
  })

  it("take a number or boolean as its text", async () => {
    await withSession('<Run id="c" command="c" env={{ PORT: 8080, DEBUG: true }} />', {}, (rb) =>
      Effect.gen(function* () {
        expect(yield* rb.run("c")).toEqual(done)
        expect(rb.envOf("c")).toEqual({ PORT: "8080", DEBUG: "true" })
      }),
    )
  })

  it("make the block wait for each output they read, as a reference in its script did", async () => {
    const runbook = [
      '<Script id="s" label="s" writesOutput={["k=v"]} declares={["k"]} />',
      '<Run id="c" command="c" env={{ K: "{{ .outputs.s.k }}" }} />',
    ].join("\n\n")
    await withSession(runbook, {}, (rb) =>
      Effect.gen(function* () {
        expect(yield* rb.status("c")).toEqual({
          _tag: "Blocked",
          by: [{ _tag: "WaitingFor", block: blockId("s"), capability: "run" }],
        })
        yield* rb.run("s")
        expect(yield* rb.run("c")).toEqual(done)
        expect(rb.envOf("c")).toEqual({ K: "v" })
      }),
    )
  })

  it("fail the run before it starts when a field or output is not there, naming each variable and no value", async () => {
    const runbook = [
      CONFIG,
      '<Script id="s" label="s" writesOutput={["secret_k=hunter2"]} declares={["secret_k", "never"]} />',
      [
        '<Run id="c" command="c" inputsId={["config"]} env={{',
        '  TOKEN: "{{ .outputs.s.secret_k }}",',
        '  NOPE: "{{ .inputs.nope }}",',
        '  REGION: "{{ .inputs.region }}",',
        '  LATER: "{{ .outputs.s.never }}",',
        "}} />",
      ].join("\n"),
    ].join("\n\n")
    await withSession(runbook, {}, (rb) =>
      Effect.gen(function* () {
        yield* rb.run("s")
        const status = yield* rb.run("c")
        expect(status).toMatchObject({ _tag: "Failed", error: { _tag: "TaskFailed" } })
        const message =
          status?._tag === "Failed" ? (status.error as { message: string }).message : ""
        expect(message).toContain(
          "NOPE in env: `{{ .inputs.nope }}` names no field of the forms this block reads",
        )
        expect(message).toContain(
          "LATER in env: `{{ .outputs.s.never }}` names an output block s has not given.",
        )
        expect(rb.inputOf("c")).toBeUndefined()
        const events = yield* rb.close
        expect(JSON.stringify([status, events])).not.toContain("hunter2")
        expect(message).not.toContain("touch pwned")
      }),
    )
  })

  it("give the process a sensitive output it reads, and keep it out of every view and event", async () => {
    const runbook = [
      '<Script id="s" label="s" writesOutput={["secret_token=hunter2"]} declares={["secret_token"]} />',
      '<Shell id="c" label="c" script="true" env={{ AUTH: "Bearer {{ .outputs.s.secret_token }}" }} />',
    ].join("\n\n")
    await withSession(runbook, {}, (rb) =>
      Effect.gen(function* () {
        yield* rb.run("s")
        expect(yield* rb.run("c")).toEqual(done)
        expect(spawns.map(({ env }) => env?.["AUTH"])).toEqual(["Bearer hunter2"])
        const given = rb.inputOf("c")?.env["AUTH"]
        expect(given !== undefined && Redacted.isRedacted(given)).toBe(true)
        const views = [yield* rb.view("s"), yield* rb.view("c")]
        const events = yield* rb.close
        expect(JSON.stringify([views, events])).not.toContain("hunter2")
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// The layers, and a credential source through its seam
// ---------------------------------------------------------------------------

const GIT = blockId("git")
const value = (
  name: string,
  given: string,
  to: CredentialValue["to"] = ["env"],
): CredentialValue => ({
  name,
  value: Redacted.make(given),
  sensitive: true,
  to,
  file: false,
})

/** A toy credential block's handle: it gives `values`, or fails with `error`. */
const toyHandle = (
  values: ReadonlyArray<CredentialValue>,
  error?: CredentialError,
): CredentialHandle => ({
  env:
    error === undefined
      ? Effect.succeed<CredentialEnv>({ values, expiresAt: Option.none() })
      : Effect.fail(error),
})

/** The toy GitLogin through its seam, declaring what the toy registry's GitLogin does. */
const gitLogin = (values: ReadonlyArray<CredentialValue>, block = GIT): EnvSource =>
  credentialSource(block, TOY_REGISTRY.GitLogin.envNames, toyHandle(values))

const build = (layers: Parameters<typeof buildRunEnv>[0]) =>
  Effect.runPromise(
    Effect.result(
      Effect.map(buildRunEnv(layers), ({ env, conflicts }) => ({ env: revealed(env), conflicts })),
    ),
  )

describe("a run's generated files", () => {
  /**
   * A session of `runbook` on a filesystem whose files the test can read
   * after, where copying a file named `full` fails, as on a full disk.
   */
  const withFiles = <A>(runbook: string, use: UseEnvSession<A>, full?: string) => {
    const files: Record<string, string> = { [RUNBOOK]: runbook }
    const base = testFileSystem(files)
    const spawner = makeRecordingSpawner(() => ({ lines: [], exitCode: 0 }))
    return withEnvSession(
      {
        file: RUNBOOK,
        workingFolders: "/work",
        processEnvironment: {},
        fileSystem: Layer.succeed(FileSystem, {
          ...base,
          copyFile: (src: string, dest: string) =>
            full !== undefined && dest.endsWith(`/${full}`)
              ? Effect.fail(new FileWriteError({ path: dest, cause: "no space left" }))
              : base.copyFile(src, dest),
        }),
        spawner: spawner.layer,
      },
      use,
    ).then((result) => ({ result, files }))
  }

  it("are copied into the generated folder once the run ends well, and the block lists each", async () => {
    const { result, files } = await withFiles(
      '<Script id="s" label="s" writesGenerated={["main.tf=resource", "vpc/vpc.tf=module"]} />',
      (rb) =>
        Effect.gen(function* () {
          expect(yield* rb.run("s")).toEqual(done)
          const generated = rb.inputOf("s")?.roots.generated ?? ""
          const first = (yield* rb.view("s")).files
          expect(yield* rb.run("s")).toEqual(done)
          const again = (yield* rb.view("s")).files
          const events = yield* rb.close
          return { generated, first, again, events }
        }),
    )
    const { generated, first, again, events } = result
    expect(first).toEqual([
      { path: `${generated}/main.tf`, change: "created" },
      { path: `${generated}/vpc/vpc.tf`, change: "created" },
    ])
    // A rerun lists its own files: the same paths, now replaced.
    expect(again).toEqual([
      { path: `${generated}/main.tf`, change: "modified" },
      { path: `${generated}/vpc/vpc.tf`, change: "modified" },
    ])
    expect(files[`${generated}/main.tf`]).toBe("resource")
    expect(files[`${generated}/vpc/vpc.tf`]).toBe("module")
    const told = events.flatMap(({ event }) => (event._tag === "FilesChanged" ? [event.files] : []))
    expect(told).toEqual([first ?? [], again ?? []])
  })

  it("are not copied from a run that failed, and the block lists none", async () => {
    const { result, files } = await withFiles(
      '<Script id="s" label="s" writesGenerated={["main.tf=resource"]} ends={[1]} />',
      (rb) =>
        Effect.gen(function* () {
          expect((yield* rb.run("s"))?._tag).toBe("Failed")
          return { generated: rb.inputOf("s")?.roots.generated ?? "", view: yield* rb.view("s") }
        }),
    )
    expect(result.view.files).toBeUndefined()
    expect(Object.keys(files).filter((file) => file.startsWith(result.generated))).toEqual([])
  })

  it("are copied from a run that warned (exit 2), as its outputs are kept", async () => {
    const { result } = await withFiles(
      '<Script id="s" label="s" writesGenerated={["main.tf=resource"]} ends={[2]} />',
      (rb) => Effect.andThen(rb.run("s"), rb.view("s")),
    )
    expect(result.status).toEqual({ _tag: "Done", outcome: "warning" })
    expect(result.files?.map(({ change }) => change)).toEqual(["created"])
  })

  it("lists what a copy that stopped part way had copied, and fails the run", async () => {
    const { result } = await withFiles(
      '<Script id="s" label="s" writesGenerated={["a.txt=a", "b.txt=b"]} />',
      (rb) =>
        Effect.gen(function* () {
          const status = yield* rb.run("s")
          const generated = rb.inputOf("s")?.roots.generated ?? ""
          const view = yield* rb.view("s")
          return { status, generated, view, events: yield* rb.close }
        }),
      "b.txt",
    )
    const { status, generated, view, events } = result
    expect(status?._tag === "Failed" ? status.error.message : status).toBe(
      "Runbooks could not copy b.txt from $GENERATED_FILES into the generated folder.",
    )
    const listed: ReadonlyArray<FileChange> = [{ path: `${generated}/a.txt`, change: "created" }]
    expect(view.files).toEqual(listed)
    expect(
      events.flatMap(({ event }) => (event._tag === "FilesChanged" ? [event.files] : [])),
    ).toEqual([listed])
  })

  it("keeps the first paths at the limit, says so, and still takes a later change to one", async () => {
    const { result: view } = await withFiles(
      `<Script id="s" label="s" reports={${LIMITS.maxRunFiles + 1}} />`,
      (rb) => Effect.andThen(rb.run("s"), rb.view("s")),
    )
    expect(view.files).toHaveLength(LIMITS.maxRunFiles)
    expect(view.files?.[0]).toEqual({ path: "/reported/0", change: "modified" })
    expect(view.files?.at(-1)).toEqual({
      path: `/reported/${LIMITS.maxRunFiles - 1}`,
      change: "created",
    })
    expect(view.filesTruncated).toBe(true)
  })

  it("says so when it copied more files than it lists", async () => {
    const { result: view } = await withFiles(
      `<Script id="s" label="s" leavesMany={${LIMITS.maxRunFiles + 1}} />`,
      (rb) => Effect.andThen(rb.run("s"), rb.view("s")),
    )
    expect(view.files).toHaveLength(LIMITS.maxRunFiles)
    expect(view.filesTruncated).toBe(true)
  })

  it("does not say a list at the limit was cut when it was not", async () => {
    const { result: view } = await withFiles(
      `<Script id="s" label="s" reports={${LIMITS.maxRunFiles}} />`,
      (rb) => Effect.andThen(rb.run("s"), rb.view("s")),
    )
    expect(view.files).toHaveLength(LIMITS.maxRunFiles)
    expect(view.filesTruncated).toBeUndefined()
  })

  it("$REPO_FILES is the repository a task names, and is unset for a task that names none", async () => {
    const { result } = await withFiles(
      [
        '<Clone id="clone" url="https://example.com/infra.git" />',
        '<Script id="in" label="in" repository="clone" />',
        '<Script id="out" label="out" />',
      ].join("\n\n"),
      (rb) =>
        Effect.gen(function* () {
          for (const block of ["clone", "in", "out"]) expect(yield* rb.run(block)).toEqual(done)
          return { in: rb.runFilesOf("in"), out: rb.runFilesOf("out"), cwd: rb.inputOf("in")?.cwd }
        }),
    )
    expect(result.in["REPO_FILES"]).toBe(result.cwd)
    expect(result.in["REPO_FILES"]).toMatch(/^\/work\//)
    expect(result.out["REPO_FILES"]).toBeUndefined()
  })
})

describe("a credential source", () => {
  // The next three are today's guards, by name: two from
  // src/domain/exec/executor.test.ts and one from
  // electron/main/ipc/session-env.test.ts. The block's provider takes the
  // place of the auth block's override, and the base environment the
  // session's. They run on the layers: the session builds them before it
  // resolves a path or starts the block, so a refused source runs nothing.
  // `credentials.test.ts` runs the first in a session too.
  it("refuses names no auth block passes, before creating or spawning anything", async () => {
    const result = await build({
      base: baseEnvironment({ PATH: "/usr/bin" }, TOY_REGISTRY),
      sources: [
        gitLogin([
          value("GITHUB_TOKEN", "ghp_block"),
          value("PATH", "/tmp/evil-bin"),
          value("BASH_ENV", "/tmp/evil.sh"),
          value("ENV", "/tmp/evil.sh"),
          value("LD_PRELOAD", "/tmp/evil.so"),
          value("DYLD_INSERT_LIBRARIES", "/tmp/evil.dylib"),
          value("NODE_OPTIONS", "--require /tmp/evil.js"),
          value("RUNBOOK_ERROR_LOG", "/elsewhere"),
        ]),
      ],
      own: {},
    })
    expect(Result.isFailure(result) && result.failure).toMatchObject({ _tag: "TaskFailed" })
    const message = Result.isFailure(result) ? result.failure.message : ""
    expect(message).toContain(
      "BASH_ENV, DYLD_INSERT_LIBRARIES, ENV, LD_PRELOAD, NODE_OPTIONS, PATH, RUNBOOK_ERROR_LOG",
    )
    for (const given of ["evil", "ghp_block"]) expect(message).not.toContain(given)
  })

  it("refuses an override that isn't an auth block's, and runs nothing", async () => {
    // AWS_ACCESS_KEY_ID is a credential variable, but not one GitLogin declares.
    const result = await build({
      base: new Map(),
      sources: [gitLogin([value("GITHUB_TOKEN", "t"), value("AWS_ACCESS_KEY_ID", "AKIAEXAMPLE")])],
      own: {},
    })
    expect(Result.isFailure(result) && result.failure).toMatchObject({
      _tag: "TaskFailed",
      message: "git gave AWS_ACCESS_KEY_ID, which it does not declare, so the run did not start.",
    })
  })

  it("passes every auth block's vars over the session's", async () => {
    const result = await build({
      base: baseEnvironment(AMBIENT, TOY_REGISTRY),
      sources: [gitLogin([value("GITHUB_TOKEN", "ghp_block"), value("GITLAB_TOKEN", "")])],
      own: {},
    })
    expect(Result.isSuccess(result) && result.success.env).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/home/someone",
      GITHUB_TOKEN: "ghp_block",
      GITLAB_TOKEN: "",
    })
  })

  it("unsets each name it declares and did not return, so an earlier source's cannot pair with it", async () => {
    const result = await build({
      base: new Map(),
      sources: [
        gitLogin([value("GITHUB_TOKEN", "a"), value("GITLAB_TOKEN", "a")], blockId("one")),
        gitLogin([value("GITHUB_TOKEN", "b")], blockId("two")),
      ],
      own: {},
    })
    expect(Result.isSuccess(result) && result.success.env).toEqual({ GITHUB_TOKEN: "b" })
  })

  it("gives the run only the values its provider sends to the environment", async () => {
    const result = await build({
      base: new Map(),
      sources: [gitLogin([value("GITHUB_TOKEN", "t"), value("GITLAB_TOKEN", "o", ["output"])])],
      own: {},
    })
    expect(Result.isSuccess(result) && result.success.env).toEqual({ GITHUB_TOKEN: "t" })
  })

  it("fails the run, naming the block, when its provider cannot give credentials", async () => {
    const expired = new CredentialError({ kind: "expired", message: "The sign-in expired." })
    const result = await build({
      base: new Map(),
      sources: [credentialSource(GIT, ["GITHUB_TOKEN"], toyHandle([], expired))],
      own: {},
    })
    expect(Result.isFailure(result) && result.failure).toMatchObject({
      _tag: "TaskFailed",
      message: "git could not give the run its credentials: The sign-in expired.",
    })
  })
})

describe("the layers", () => {
  // Today's src/domain/exec/executor.test.ts test, by name: the session's
  // environment is the base now, the auth block's a credential source. The
  // runbook's own vars are the reserved names: no layer sets one.
  it("sets the block's env over the session's and the auth block's, under the runbook's own vars", async () => {
    const result = await build({
      base: baseEnvironment(
        { PATH: "/usr/bin", BUCKET: "session-bucket", RUNBOOK_OUTPUT: "/elsewhere" },
        TOY_REGISTRY,
      ),
      sources: [
        gitLogin([value("GITHUB_TOKEN", "ghp_auth")]),
        taskSource(blockId("task"), new Map([["BUCKET", Redacted.make("task-bucket")]])),
      ],
      own: { BUCKET: Redacted.make("block-bucket"), GITHUB_TOKEN: Redacted.make("ghp_own") },
    })
    expect(Result.isSuccess(result) && result.success).toEqual({
      env: { PATH: "/usr/bin", BUCKET: "block-bucket", GITHUB_TOKEN: "ghp_own" },
      conflicts: [],
    })
  })

  it("sets the names Runbooks sets for every run over every layer, and no layer sets one", async () => {
    const { env } = await Effect.runPromise(
      buildRunEnv({
        base: baseEnvironment({ RUNBOOK_ENV: "/app/env", GENERATED_FILES: "/app" }, TOY_REGISTRY),
        sources: [
          taskSource(
            blockId("a"),
            new Map([
              ["RUNBOOK_ENV", Redacted.make("/source/env")],
              ["REPO_FILES", Redacted.make("/source/files")],
              ["OK", Redacted.make("1")],
            ]),
          ),
          credentialSource(
            GIT,
            ["RUNBOOK_LOG", "TOKEN"],
            toyHandle([value("RUNBOOK_LOG", "/credential/log"), value("TOKEN", "t")]),
          ),
        ],
        own: {},
      }),
    )
    expect(revealed(env)).toEqual({ OK: "1", TOKEN: "t" })
    expect(revealed(withReserved(env, { RUNBOOK_ENV: "/run/env" }))).toEqual({
      OK: "1",
      TOKEN: "t",
      RUNBOOK_ENV: "/run/env",
    })
  })

  it("names each variable two sources set, and the later source, whose value the run gets", async () => {
    const result = await build({
      base: new Map(),
      sources: [
        taskSource(blockId("a"), new Map([["X", Redacted.make("1")]])),
        gitLogin([value("GITHUB_TOKEN", "t")]),
        taskSource(
          blockId("b"),
          new Map([
            ["X", Redacted.make("2")],
            ["GITHUB_TOKEN", Redacted.make("u")],
          ]),
        ),
      ],
      own: { X: Redacted.make("own") },
    })
    expect(Result.isSuccess(result) && result.success).toEqual({
      env: { X: "own", GITHUB_TOKEN: "u" },
      conflicts: [
        { name: "X", earlier: blockId("a"), later: blockId("b") },
        { name: "GITHUB_TOKEN", earlier: GIT, later: blockId("b") },
      ],
    })
  })
})
