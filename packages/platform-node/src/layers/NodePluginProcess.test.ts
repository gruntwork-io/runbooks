/**
 * The transport owner against a real plugin process: `../fixtures/pluginStub.ts`,
 * copied into a temporary bin folder as `runbooks-credential-stub` and
 * pinned by its SHA-256, so every test goes through the hash check, the
 * spawn and the pipes. Each method of the stub scripts one behaviour.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Cause, Effect, Exit, Option, Redacted, Schema, Scope, Stream } from "effect"
import {
  LIMITS,
  type Method,
  Platform,
  type PluginEntry,
  PluginProcess,
  type PluginProtocol,
  Sha256,
  type StreamMethod,
} from "@runbooks/core/plugin/transport"
import { binaryName, nodePluginProcess } from "./NodePluginProcess.ts"

const STUB = path.join(import.meta.dirname, "..", "fixtures", "pluginStub.ts")
/**
 * The stub's SHA-256, pinned as `plugins.lock` pins a released binary. After
 * changing the stub, pin it again with the output of
 * `shasum -a 256 packages/platform-node/src/fixtures/pluginStub.ts`.
 */
const STUB_SHA256 = Schema.decodeUnknownSync(Sha256)(
  "84494822794544cb326213f524db49bbbfabe8045be196f93686465cb69ff2af",
)

const PLATFORM = Schema.decodeUnknownSync(Platform)(
  `${process.platform}-${process.arch === "x64" ? "amd64" : process.arch}`,
)
const BINARY = binaryName("credential", "stub", PLATFORM)
/** Bun for the stub's `#!`, and `/bin` for its `sleep`: the only environment a test gives it. */
const PATH = `${path.dirname(process.execPath)}:/usr/bin:/bin`

/** Bun's per-test timeout for a test that waits out `LIMITS.exitGraceMillis`. */
const WAITS_OUT_GRACE = LIMITS.exitGraceMillis + 5_000

const pinned = (sha256: Partial<Record<Platform, Sha256>>): PluginEntry => ({
  name: "stub",
  kind: "credential",
  version: "0.0.0",
  sha256,
})

/** The plugins `run` takes, with a binary of exactly `text` pinned as the stub. */
const pinnedText = (text: string) => [
  pinned({
    [PLATFORM]: Schema.decodeUnknownSync(Sha256)(
      new Bun.CryptoHasher("sha256").update(text).digest("hex"),
    ),
  }),
]

/** A shell plugin's answer to configure, the first request. A shell plugin starts faster than the stub. */
const SHELL_CONFIGURED = `printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"1","driverVersion":"0.0.0","received":{},"pid":0}}'`

const Empty = Schema.Struct({})
const method = <P, R>(
  name: string,
  params: Schema.Codec<P, unknown>,
  result: Schema.Codec<R, unknown>,
  timeoutMillis?: number,
): Method<P, R> => ({
  name,
  params,
  result,
  ...(timeoutMillis === undefined ? {} : { timeoutMillis }),
})

const Configured = Schema.Struct({
  protocolVersion: Schema.String,
  driverVersion: Schema.String,
  received: Schema.Record(Schema.String, Schema.Unknown),
  pid: Schema.Int,
})

const echo = method(
  "echo",
  Schema.Struct({ word: Schema.String }),
  Schema.Struct({ word: Schema.String }),
)
const later = method(
  "later",
  Schema.Struct({ word: Schema.String, millis: Schema.Int }),
  Schema.Struct({ word: Schema.String }),
)
const env = method("env", Empty, Schema.Record(Schema.String, Schema.String))
const line = method(
  "line",
  Schema.Struct({ bytes: Schema.Int }),
  Schema.Struct({ pad: Schema.String }),
)
const hang = method("hang", Empty, Empty, 300)
const exit = method("exit", Schema.Struct({ code: Schema.Int, stderr: Schema.String }), Empty)
const flood = method("flood", Schema.Struct({ bytes: Schema.Int, tail: Schema.String }), Empty)
const child = method("child", Empty, Schema.Struct({ pid: Schema.Int }))
const remoteError = method(
  "remoteError",
  Schema.Struct({ kind: Schema.String, detail: Schema.String }),
  Empty,
)
/** Answers `timedOut` a second before the limit `configure` gave it. */
const budget = method("budget", Empty, Empty, 1_500)
const count: StreamMethod<{ readonly n: number }, { readonly i: number }, { readonly n: number }> =
  {
    ...method("count", Schema.Struct({ n: Schema.Int }), Schema.Struct({ n: Schema.Int })),
    notification: { method: "count.tick", params: Schema.Struct({ i: Schema.Int }) },
  }

/** Methods whose answer breaks the protocol, by name (`protocol violations`). */
const VIOLATIONS = [
  "unknownId",
  "notJson",
  "idAndMethod",
  "nullId",
  "notifyUnknown",
  "notifyCall",
] as const
const violating = (name: (typeof VIOLATIONS)[number]) => method(name, Empty, Empty)

const stubProtocol = (
  configureTimeoutMillis?: number,
): PluginProtocol<
  "invalidParams" | "stubbed" | "timedOut",
  { readonly stateDir: string },
  typeof Configured.Type
> => ({
  kind: "credential",
  errorKinds: ["invalidParams", "stubbed", "timedOut"],
  configure: method(
    "configure",
    Schema.Struct({
      protocolVersion: Schema.String,
      caller: Schema.String,
      callTimeoutsMillis: Schema.Record(Schema.String, Schema.Int),
      stateDir: Schema.String,
    }),
    Configured,
    configureTimeoutMillis,
  ),
  methods: [
    echo,
    later,
    env,
    line,
    hang,
    exit,
    flood,
    child,
    remoteError,
    budget,
    count,
    ...VIOLATIONS.map(violating),
  ],
})

let bin = ""
let runDir = ""
let started = ""
beforeEach(() => {
  bin = realpathSync(mkdtempSync(path.join(tmpdir(), "runbooks-plugin-")))
  runDir = realpathSync(mkdtempSync(path.join(tmpdir(), "runbooks-run-")))
  copyFileSync(STUB, path.join(bin, BINARY))
  chmodSync(path.join(bin, BINARY), 0o755)
  started = path.join(bin, "started")
})
afterEach(() => {
  rmSync(bin, { recursive: true, force: true })
  rmSync(runDir, { recursive: true, force: true })
})

/** The stub's environment: `extra`, and a HOME of its own so Bun never reads or writes the real one. */
const environment = (extra: Record<string, string> = {}) => ({
  PATH,
  HOME: bin,
  STUB_STARTED: started,
  ...extra,
})

const given = (extra?: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(environment(extra)).map(([name, value]) => [name, Redacted.make(value)]),
  )

/** Runs `effect` in a scope over the owner, pinned to the stub. */
const run = <A, E>(
  effect: Effect.Effect<A, E, PluginProcess | Scope.Scope>,
  plugins: ReadonlyArray<PluginEntry> = [pinned({ [PLATFORM]: STUB_SHA256 })],
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.scoped,
      Effect.provide(
        nodePluginProcess({
          binDir: bin,
          runDir,
          platform: PLATFORM,
          plugins,
          caller: "runbooks/test",
        }),
      ),
    ),
  )

const open = (extra?: Record<string, string>, protocol = stubProtocol()) =>
  Effect.gen(function* () {
    const plugins = yield* PluginProcess
    return yield* plugins.open(protocol, "stub", given(extra), (fields) => ({
      ...fields,
      stateDir: "/state",
    }))
  })

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Waits up to `millis` for `pid` to be gone: an orphan is reaped by init, not by this process. */
const gone = async (pid: number, millis = 2_000) => {
  const until = Date.now() + millis
  while (alive(pid) && Date.now() < until) await Bun.sleep(20)
  return !alive(pid)
}

/** The stub's process id, from the file it writes when it starts. */
const stubPid = () => Number(readFileSync(started, "utf8"))

describe("starting a plugin", () => {
  it("sends configure first, with the protocol version and the caller, then answers calls", async () => {
    const [configured, answer] = await run(
      Effect.gen(function* () {
        const session = yield* open()
        return [session.configured, yield* session.call(echo, { word: "hello" })] as const
      }),
    )
    expect(configured.received).toMatchObject({
      protocolVersion: "1",
      caller: "runbooks/test",
      stateDir: "/state",
    })
    expect(answer).toEqual({ word: "hello" })
  })

  it("tells the plugin in configure how long it waits for each method, configure's own included", async () => {
    const protocol = stubProtocol(2_000)
    const configured = await run(Effect.map(open({}, protocol), (session) => session.configured))
    const limits = configured.received.callTimeoutsMillis
    expect(Object.keys(limits ?? {}).sort()).toEqual(
      [protocol.configure, ...protocol.methods].map(({ name }) => name).sort(),
    )
    expect(limits).toMatchObject({
      configure: 2_000,
      hang: 300,
      budget: 1_500,
      echo: LIMITS.callTimeoutMillis,
      count: LIMITS.callTimeoutMillis,
    })
  })

  it("refuses a call to a method its protocol does not list", async () => {
    const ended = await run(
      Effect.flatMap(open(), (session) =>
        Effect.exit(session.call(method("unlisted", Empty, Empty), {})),
      ),
    )
    expect(Exit.isFailure(ended) && Cause.hasDies(ended.cause)).toBe(true)
  })

  it("matches each answer to its request by id, in whatever order they come", async () => {
    const answers = await run(
      Effect.flatMap(open(), (session) =>
        Effect.all(
          [
            session.call(later, { word: "first", millis: 200 }),
            session.call(later, { word: "second", millis: 0 }),
          ],
          { concurrency: "unbounded" },
        ),
      ),
    )
    expect(answers).toEqual([{ word: "first" }, { word: "second" }])
  })

  it("gives the plugin only the environment it is given, not this process's", async () => {
    process.env.RUNBOOKS_PLUGIN_TEST_APP_ONLY = "app"
    try {
      const seen = await run(
        Effect.flatMap(open({ GIVEN: "given" }), (session) => session.call(env, {})),
      )
      expect(seen).toEqual(environment({ GIVEN: "given" }))
    } finally {
      delete process.env.RUNBOOKS_PLUGIN_TEST_APP_ONLY
    }
  })

  it("refuses a binary whose SHA-256 is not the pinned one, starts nothing and keeps no copy", async () => {
    appendFileSync(path.join(bin, BINARY), "\n// changed after it was pinned\n")
    const actual = new Bun.CryptoHasher("sha256")
      .update(readFileSync(path.join(bin, BINARY)))
      .digest("hex")
    const error = await run(Effect.flip(open()))
    expect(error).toMatchObject({
      _tag: "PluginHashMismatch",
      plugin: "stub",
      expected: STUB_SHA256,
      actual,
    })
    expect(existsSync(started)).toBe(false)
    expect(readdirSync(runDir)).toEqual([])
  })

  it("refuses a plugin that is not pinned, not pinned for this platform, or has no binary", async () => {
    const notInstalled = { _tag: "PluginNotInstalled", plugin: "stub", platform: PLATFORM }
    expect(await run(Effect.flip(open()), [])).toMatchObject(notInstalled)
    const other = PLATFORM === "linux-amd64" ? "darwin-arm64" : "linux-amd64"
    expect(await run(Effect.flip(open()), [pinned({ [other]: STUB_SHA256 })])).toMatchObject(
      notInstalled,
    )
    rmSync(path.join(bin, BINARY))
    expect(await run(Effect.flip(open()))).toMatchObject(notInstalled)
    expect(readdirSync(runDir)).toEqual([])
  })

  it("finds a plugin by its kind and name: a driver of the same name is another binary", async () => {
    const driver: PluginEntry = { ...pinned({ [PLATFORM]: STUB_SHA256 }), kind: "driver" }
    const error = await run(Effect.flip(open()), [driver])
    expect(error).toMatchObject({ _tag: "PluginNotInstalled", plugin: "stub" })
  })

  it("fails with spawnFailed when the pinned binary cannot be run, and keeps no copy", async () => {
    const unrunnable = "#!/nonexistent/interpreter\n"
    writeFileSync(path.join(bin, BINARY), unrunnable)
    const error = await run(Effect.flip(open()), pinnedText(unrunnable))
    expect(error).toMatchObject({ _tag: "PluginSpawnFailed", plugin: "stub" })
    expect(error.message).toContain("ENOENT")
    expect(readdirSync(runDir)).toEqual([])
  })
})

describe("the binary that runs", () => {
  /** Writes the path it runs from to `RAN_FROM`, answers configure, then waits for standard input to close. */
  const SAYS_WHERE = [
    "#!/bin/sh",
    `printf '%s' "$0" > "$RAN_FROM"`,
    "read -r request",
    SHELL_CONFIGURED,
    "while read -r request; do :; done",
    "",
  ].join("\n")

  it("is a copy in a folder of its own in runDir, which only this user can open, removed when the session ends", async () => {
    writeFileSync(path.join(bin, BINARY), SAYS_WHERE)
    const ranFrom = path.join(bin, "ran-from")
    const seen = await run(
      Effect.flatMap(open({ RAN_FROM: ranFrom }), () =>
        Effect.sync(() => {
          const copy = readFileSync(ranFrom, "utf8")
          return {
            copy,
            text: readFileSync(copy, "utf8"),
            folderMode: statSync(path.dirname(copy)).mode & 0o777,
            copyMode: statSync(copy).mode & 0o777,
          }
        }),
      ),
      pinnedText(SAYS_WHERE),
    )
    expect(path.dirname(path.dirname(seen.copy))).toBe(runDir)
    expect(path.basename(seen.copy)).toBe(BINARY)
    expect(seen.text).toBe(SAYS_WHERE)
    expect(seen.folderMode).toBe(0o700)
    expect(seen.copyMode).toBe(0o700)
    expect(readdirSync(runDir)).toEqual([])
  })

  /** Answers configure, then waits for standard input to close. */
  const PINNED_SCRIPT = [
    "#!/bin/sh",
    "read -r request",
    SHELL_CONFIGURED,
    "while read -r request; do :; done",
    "",
  ].join("\n")
  /** The program swapped in: a line in `RACE_MARKER` each time it runs. */
  const OTHER_SCRIPT = '#!/bin/sh\necho ran >> "$RACE_MARKER"\n'
  /**
   * Renames each script in turn over the binary, each an atomic replace,
   * until it is killed. It writes a line once it has swapped in the other
   * script, written at once: the loop never lets an asynchronous write out.
   */
  const SWAPPER = `
    const { linkSync, renameSync, writeSync } = require("node:fs")
    const { PINNED, OTHER, SPARE, TARGET } = process.env
    const swap = (from) => { linkSync(from, SPARE); renameSync(SPARE, TARGET) }
    swap(OTHER)
    writeSync(1, "swapping\\n")
    for (;;) for (const from of [PINNED, OTHER]) swap(from)
  `
  const OPENS = 20
  /**
   * Bun's timeout for the race. On macOS an open takes about 100 ms, not
   * 5: Gatekeeper checks each new program file before it first runs.
   */
  const RACE_TIMEOUT = 15_000

  it(
    "is the one whose hash was checked, while another process swaps binDir's file",
    async () => {
      const script = (name: string, text: string) => {
        const file = path.join(bin, name)
        writeFileSync(file, text, { mode: 0o755 })
        return file
      }
      const target = path.join(bin, BINARY)
      const pinnedScript = script("pinned.sh", PINNED_SCRIPT)
      const otherScript = script("other.sh", OTHER_SCRIPT)
      copyFileSync(pinnedScript, target)
      const marker = path.join(bin, "ran-other")
      const plugins = pinnedText(PINNED_SCRIPT)
      const swapper = Bun.spawn([process.execPath, "--no-env-file", "-e", SWAPPER], {
        cwd: bin,
        env: {
          HOME: bin,
          PINNED: pinnedScript,
          OTHER: otherScript,
          SPARE: path.join(bin, "spare"),
          TARGET: target,
        },
        stdio: ["ignore", "pipe", "inherit"],
      })
      const outcomes: Record<string, number> = {}
      try {
        // The opens start once the swaps have: on Linux 20 opens can take less time than Bun takes to start.
        await swapper.stdout.getReader().read()
        for (let i = 0; i < OPENS; i++) {
          const outcome = await run(
            Effect.match(open({ RACE_MARKER: marker }), {
              onSuccess: () => "opened",
              onFailure: (error) => error._tag,
            }),
            plugins,
          )
          outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
        }
      } finally {
        swapper.kill("SIGKILL")
        await swapper.exited
      }
      const ranOther = existsSync(marker)
        ? readFileSync(marker, "utf8").split("\n").filter(Boolean).length
        : 0
      expect({ ranOther, outcomes }).toEqual({ ranOther: 0, outcomes: expect.any(Object) })
      expect(outcomes.opened ?? 0).toBeGreaterThan(0)
      // The swaps reached the opens: some hash checks read the other script.
      expect(outcomes.PluginHashMismatch ?? 0).toBeGreaterThan(0)
    },
    RACE_TIMEOUT,
  )
})

describe("the protocol version", () => {
  /** Opens with `extra`, expecting a failure, and whether the stub stopped before the scope closed. */
  const refused = (extra: Record<string, string>) =>
    run(
      Effect.gen(function* () {
        const error = yield* Effect.flip(open(extra))
        return { error, stopped: yield* Effect.promise(() => gone(stubPid(), 1_000)) }
      }),
    )

  it("refuses a plugin whose configure answer names another version, and stops it", async () => {
    const { error, stopped } = await refused({ STUB_ANSWERS: "2" })
    expect(error).toEqual(
      expect.objectContaining({
        _tag: "PluginUnsupportedProtocolVersion",
        offered: "2",
        supported: "1",
      }),
    )
    expect(stopped).toBe(true)
  })

  it("refuses a plugin that refuses this app's version, naming none of its own", async () => {
    const { error, stopped } = await refused({ STUB_SPEAKS: "2" })
    expect(error).toMatchObject({ _tag: "PluginUnsupportedProtocolVersion", supported: "1" })
    expect("offered" in error).toBe(false)
    expect(stopped).toBe(true)
  })
})

describe("timeouts", () => {
  it("fail a call that outlives its timeout, and end the session", async () => {
    const begun = Date.now()
    const [timedOut, after, took, stopped] = await run(
      Effect.gen(function* () {
        const session = yield* open()
        const first = yield* Effect.flip(session.call(hang, {}))
        const failedAfter = Date.now() - begun
        const stubStopped = yield* Effect.promise(() => gone(stubPid(), 1_000))
        const next = yield* Effect.flip(session.call(echo, { word: "late" }))
        return [first, next, failedAfter, stubStopped] as const
      }),
    )
    expect(timedOut).toMatchObject({ _tag: "PluginTimedOut", method: "hang", afterMillis: 300 })
    expect(after).toBe(timedOut)
    expect(took).toBeGreaterThanOrEqual(300)
    expect(took).toBeLessThan(LIMITS.exitGraceMillis)
    expect(stopped).toBe(true)
  })

  it(
    "stop a plugin that keeps running after standard input closes, without waiting for the scope",
    async () => {
      const stopped = await run(
        Effect.gen(function* () {
          const session = yield* open({ STUB_IGNORES_STDIN: "1" })
          yield* Effect.flip(session.call(hang, {}))
          return yield* Effect.promise(() => gone(stubPid(), LIMITS.exitGraceMillis + 1_000))
        }),
      )
      expect(stopped).toBe(true)
    },
    WAITS_OUT_GRACE,
  )

  it("apply to configure", async () => {
    const error = await run(Effect.flip(open({ STUB_CONFIGURE: "hang" }, stubProtocol(300))))
    expect(error).toMatchObject({ _tag: "PluginTimedOut", method: "configure", afterMillis: 300 })
  })
})

describe("lines", () => {
  it("take a line of exactly maxLineBytes", async () => {
    const answer = await run(
      Effect.flatMap(open(), (session) => session.call(line, { bytes: LIMITS.maxLineBytes })),
    )
    expect(answer.pad.length).toBeGreaterThan(LIMITS.maxLineBytes - 100)
  })

  it("refuse one a byte longer, and end the session", async () => {
    const [tooLarge, after] = await run(
      Effect.gen(function* () {
        const session = yield* open()
        const first = yield* Effect.flip(session.call(line, { bytes: LIMITS.maxLineBytes + 1 }))
        return [first, yield* Effect.flip(session.call(echo, { word: "after" }))] as const
      }),
    )
    expect(tooLarge).toMatchObject({
      _tag: "PluginTooLarge",
      limit: "line",
      max: LIMITS.maxLineBytes,
    })
    expect(after).toBe(tooLarge)
  })

  it("refuse to write a request past maxLineBytes, and the session goes on", async () => {
    const [tooLarge, after] = await run(
      Effect.gen(function* () {
        const session = yield* open()
        const word = "w".repeat(LIMITS.maxLineBytes)
        const first = yield* Effect.flip(session.call(echo, { word }))
        return [first, yield* session.call(echo, { word: "small" })] as const
      }),
    )
    expect(tooLarge).toMatchObject({
      _tag: "PluginTooLarge",
      limit: "line",
      max: LIMITS.maxLineBytes,
    })
    expect(after).toEqual({ word: "small" })
  })
})

describe("an exit", () => {
  it("fails the open call, and every later one, with the code and standard error", async () => {
    const [exited, after] = await run(
      Effect.gen(function* () {
        const session = yield* open()
        const first = yield* Effect.flip(session.call(exit, { code: 3, stderr: "dying\n" }))
        return [first, yield* Effect.flip(session.call(echo, { word: "after" }))] as const
      }),
    )
    expect(exited).toEqual(
      expect.objectContaining({ _tag: "PluginExited", plugin: "stub", code: 3, stderr: "dying\n" }),
    )
    expect(after).toBe(exited)
  })

  it("keeps only the last maxStderrBytes of standard error", async () => {
    const exited = await run(
      Effect.flatMap(open(), (session) =>
        Effect.flip(session.call(flood, { bytes: 4 * LIMITS.maxStderrBytes, tail: "THE END" })),
      ),
    )
    expect(exited).toMatchObject({ _tag: "PluginExited", code: 1 })
    const stderr = "stderr" in exited ? exited.stderr : ""
    expect(Buffer.byteLength(stderr)).toBe(LIMITS.maxStderrBytes)
    expect(stderr.endsWith("eeeTHE END")).toBe(true)
  })
})

describe("protocol violations", () => {
  const violation = (name: (typeof VIOLATIONS)[number], word = "") =>
    run(
      Effect.gen(function* () {
        const session = yield* open()
        const first = yield* Effect.flip(session.call(violating(name), {}))
        const after = yield* Effect.flip(session.call(echo, { word }))
        return { first, after }
      }),
    )

  it.each([
    ["unknownId", "a response names request 1002, which is not open"],
    ["notJson", "a line on standard output is not JSON"],
    ["idAndMethod", "the plugin sent a request: a message with an id and a method"],
    ["nullId", "the plugin could not read a request: the line is not JSON"],
    ["notifyUnknown", "count.tick names request 1002, which is not open"],
    ["notifyCall", "count.tick names request 2, a call that streams nothing"],
  ] as const)("end the session: %s", async (name, message) => {
    const { first, after } = await violation(name)
    expect(first).toMatchObject({ _tag: "PluginProtocolViolation", plugin: "stub", message })
    expect(after).toBe(first)
  })

  it("include a result that does not match its schema, which the message does not quote", async () => {
    const wrong = method(
      "echo",
      Schema.Struct({ word: Schema.String }),
      Schema.Struct({ word: Schema.Int }),
    )
    const error = await run(
      Effect.flatMap(open(), (session) => Effect.flip(session.call(wrong, { word: "s3cr3t" }))),
    )
    expect(error).toMatchObject({
      _tag: "PluginProtocolViolation",
      message: "the result of echo does not match its schema",
    })
    expect(JSON.stringify(error)).not.toContain("s3cr3t")
  })
})

describe("a remote error", () => {
  it("is parsed into the kind's error kinds, unknown for one it does not know, and the session goes on", async () => {
    const [known, unknown, after] = await run(
      Effect.gen(function* () {
        const session = yield* open()
        return [
          yield* Effect.flip(session.call(remoteError, { kind: "stubbed", detail: "d" })),
          yield* Effect.flip(session.call(remoteError, { kind: "newKind", detail: "e" })),
          yield* session.call(echo, { word: "still here" }),
        ] as const
      }),
    )
    expect(known).toEqual({
      _tag: "PluginRemoteError",
      plugin: "stub",
      method: "remoteError",
      kind: "stubbed",
      rawKind: "stubbed",
      message: "the stub refused",
      data: { detail: "d" },
    })
    expect(unknown).toMatchObject({ kind: "unknown", rawKind: "newKind", data: { detail: "e" } })
    expect(after).toEqual({ word: "still here" })
  })

  it("of kind timedOut, answered before the method's limit, ends only that call", async () => {
    const begun = Date.now()
    const [timedOut, took, after] = await run(
      Effect.gen(function* () {
        const session = yield* open()
        const refused = yield* Effect.flip(session.call(budget, {}))
        const at = Date.now() - begun
        return [refused, at, yield* session.call(echo, { word: "still here" })] as const
      }),
    )
    expect(timedOut).toMatchObject({
      _tag: "PluginRemoteError",
      method: "budget",
      kind: "timedOut",
    })
    expect(took).toBeLessThan(1_500)
    expect(after).toEqual({ word: "still here" })
  })
})

describe("a stream", () => {
  it("gets its request's notifications in order, then its result", async () => {
    const items = await run(
      Effect.flatMap(open(), (session) => Stream.runCollect(session.stream(count, { n: 3 }))),
    )
    expect(items).toEqual([
      { _tag: "Notification", params: { i: 1 } },
      { _tag: "Notification", params: { i: 2 } },
      { _tag: "Notification", params: { i: 3 } },
      { _tag: "Result", result: { n: 3 } },
    ])
  })

  it("takes maxStreamItems notifications, and refuses one more", async () => {
    const [items, tooLarge] = await run(
      Effect.gen(function* () {
        const session = yield* open()
        const all = yield* Stream.runCount(session.stream(count, { n: LIMITS.maxStreamItems }))
        const over = yield* Effect.flip(
          Stream.runDrain(session.stream(count, { n: LIMITS.maxStreamItems + 1 })),
        )
        return [all, over] as const
      }),
    )
    expect(items).toBe(LIMITS.maxStreamItems + 1)
    expect(tooLarge).toMatchObject({
      _tag: "PluginTooLarge",
      limit: "streamItems",
      max: LIMITS.maxStreamItems,
    })
  })

  it("closed before its result cancels the call: standard input closes and the plugin exits", async () => {
    const [first, after] = await run(
      Effect.gen(function* () {
        const session = yield* open()
        const taken = yield* Stream.runCollect(Stream.take(session.stream(count, { n: 1_000 }), 1))
        return [taken, yield* Effect.flip(session.call(echo, { word: "after" }))] as const
      }),
    )
    expect(first).toEqual([{ _tag: "Notification", params: { i: 1 } }])
    expect(after).toMatchObject({ _tag: "PluginExited", code: 0 })
  })
})

describe("giving up a call", () => {
  it("cancels it: standard input closes, and the calls left fail once the plugin exits", async () => {
    const [gaveUp, after] = await run(
      Effect.gen(function* () {
        const session = yield* open()
        const first = yield* Effect.timeoutOption(
          session.call(later, { word: "never", millis: 10_000 }),
          100,
        )
        return [first, yield* Effect.flip(session.call(echo, { word: "after" }))] as const
      }),
    )
    expect(gaveUp).toEqual(Option.none())
    expect(after).toMatchObject({ _tag: "PluginExited", code: 0 })
  })
})

describe("closing the session", () => {
  it("closes standard input, and the plugin and what it started stop", async () => {
    let grandchild = 0
    const begun = Date.now()
    try {
      await run(
        Effect.flatMap(open(), (session) =>
          Effect.map(session.call(child, {}), ({ pid }) => {
            grandchild = pid
          }),
        ),
      )
      expect(Date.now() - begun).toBeLessThan(LIMITS.exitGraceMillis)
      expect(alive(stubPid())).toBe(false)
      expect(await gone(grandchild)).toBe(true)
    } finally {
      if (grandchild > 0 && alive(grandchild)) process.kill(grandchild, "SIGKILL")
    }
  })

  it(
    "kills a plugin that keeps running after standard input closes, after the grace period",
    async () => {
      let grandchild = 0
      let closed = 0
      try {
        await run(
          Effect.gen(function* () {
            const session = yield* open({ STUB_IGNORES_STDIN: "1" })
            grandchild = (yield* session.call(child, {})).pid
            closed = Date.now()
          }),
        )
        const took = Date.now() - closed
        expect(took).toBeGreaterThanOrEqual(LIMITS.exitGraceMillis - 50)
        expect(took).toBeLessThan(LIMITS.exitGraceMillis + 1_000)
        expect(alive(stubPid())).toBe(false)
        expect(await gone(grandchild)).toBe(true)
      } finally {
        for (const pid of [grandchild, existsSync(started) ? stubPid() : 0]) {
          if (pid > 0 && alive(pid)) process.kill(pid, "SIGKILL")
        }
      }
    },
    WAITS_OUT_GRACE,
  )
})
