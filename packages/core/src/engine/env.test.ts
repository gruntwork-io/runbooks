/**
 * A run's environment (work product 2.4). The engine tests run toy tasks
 * that note the environment they were given; a credential source is tested
 * through its seam with a toy handle, since no credential block can be done
 * before the credential lifecycle (2.6). Four tests are today's security
 * regression tests for the script environment allowlist, by name.
 */
import { describe, expect, it } from "bun:test"
import { Effect, Option, Redacted, Result, Schema } from "effect"
import { BlockId, CredentialError } from "@runbooks/blocks-core/contract"
import type { BlockStatus } from "@runbooks/blocks-core/status"
import type { CredentialEnv, CredentialValue } from "../credential/provider.ts"
import { type EnvSession, revealed, withEnvSession } from "../test-utils/envSessions.ts"
import { makeTestFileSystem } from "../test-utils/TestFileSystem.ts"
import { makeRecordingSpawner, type RecordedSpawn } from "../test-utils/TestSpawner.ts"
import { TOY_REGISTRY } from "../test-utils/toyRegistry.ts"
import type { Engine } from "./engine.ts"
import {
  baseEnvironment,
  buildRunEnv,
  type CredentialHandle,
  credentialSource,
  type EnvSource,
  taskSource,
} from "./env.ts"
import type { Caller } from "./protocol.ts"

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
  use: (rb: EnvSession) => Effect.Effect<A, unknown, Engine | Caller>,
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

  // A credential block is ready, not done, so until the credential lifecycle
  // (2.6) wires its handle in as a source, a block that names one waits.
  it("waits for a credential block it names", async () => {
    const runbook = '<GitLogin id="git" />\n\n<Run id="c" command="c" envFrom={["git"]} />'
    await withSession(runbook, AMBIENT, (rb) =>
      Effect.gen(function* () {
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
      '<Run id="c" command="c" envFrom={["a"]} />',
    ].join("\n\n")
    await withSession(runbook, AMBIENT, (rb) =>
      Effect.gen(function* () {
        yield* rb.run("a")
        yield* rb.run("c")
        expect(rb.envOf("c")).toEqual({ PATH: "/usr/bin:/bin", HOME: "/home/someone", OK: "1" })
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
            { PATH: "/usr/bin:/bin", HOME: "/home/someone", OWN: "own" },
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

describe("a credential source", () => {
  // The next three are today's guards, by name: two from
  // src/domain/exec/executor.test.ts and one from
  // electron/main/ipc/session-env.test.ts. The block's provider takes the
  // place of the auth block's override, and the base environment the
  // session's. Until a credential block can be done in a session (2.6) they
  // run on the layers: the session builds them before it resolves a path or
  // starts the block, so a refused source runs nothing.
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
      own: { BUCKET: "block-bucket", GITHUB_TOKEN: "ghp_own" },
    })
    expect(Result.isSuccess(result) && result.success).toEqual({
      env: { PATH: "/usr/bin", BUCKET: "block-bucket", GITHUB_TOKEN: "ghp_own" },
      conflicts: [],
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
      own: { X: "own" },
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
