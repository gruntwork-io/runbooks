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
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Option, Redacted, Schema, Scope, Stream } from "effect"
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
  "a83088d5ac2fac3fcaf2e1de9ec0e8b2b7975108d001577c180f5fc865ac15e3",
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

const stubProtocol = (
  configureTimeoutMillis?: number,
): PluginProtocol<
  "invalidParams" | "stubbed",
  { readonly stateDir: string },
  typeof Configured.Type
> => ({
  kind: "credential",
  errorKinds: ["invalidParams", "stubbed"],
  configure: method(
    "configure",
    Schema.Struct({
      protocolVersion: Schema.String,
      caller: Schema.String,
      stateDir: Schema.String,
    }),
    Configured,
    configureTimeoutMillis,
  ),
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
const count: StreamMethod<{ readonly n: number }, { readonly i: number }, { readonly n: number }> =
  {
    ...method("count", Schema.Struct({ n: Schema.Int }), Schema.Struct({ n: Schema.Int })),
    notification: { method: "count.tick", params: Schema.Struct({ i: Schema.Int }) },
  }

let bin = ""
let started = ""
beforeEach(() => {
  bin = realpathSync(mkdtempSync(path.join(tmpdir(), "runbooks-plugin-")))
  copyFileSync(STUB, path.join(bin, BINARY))
  chmodSync(path.join(bin, BINARY), 0o755)
  started = path.join(bin, "started")
})
afterEach(() => rmSync(bin, { recursive: true, force: true }))

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
        nodePluginProcess({ binDir: bin, platform: PLATFORM, plugins, caller: "runbooks/test" }),
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
    expect(configured.received).toEqual({
      protocolVersion: "1",
      caller: "runbooks/test",
      stateDir: "/state",
    })
    expect(answer).toEqual({ word: "hello" })
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

  it("refuses a binary whose SHA-256 is not the pinned one, and starts nothing", async () => {
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
  })

  it("finds a plugin by its kind and name: a driver of the same name is another binary", async () => {
    const driver: PluginEntry = { ...pinned({ [PLATFORM]: STUB_SHA256 }), kind: "driver" }
    const error = await run(Effect.flip(open()), [driver])
    expect(error).toMatchObject({ _tag: "PluginNotInstalled", plugin: "stub" })
  })

  it("fails with spawnFailed when the pinned binary cannot be run", async () => {
    chmodSync(path.join(bin, BINARY), 0o644)
    const error = await run(Effect.flip(open()))
    expect(error).toMatchObject({ _tag: "PluginSpawnFailed", plugin: "stub" })
    expect(error.message).toContain("EACCES")
  })
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
  const violation = (name: string, word = "") =>
    run(
      Effect.gen(function* () {
        const session = yield* open()
        const first = yield* Effect.flip(session.call(method(name, Empty, Empty), {}))
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
  ])("end the session: %s", async (name, message) => {
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
    const waitsLong = method("hang", Empty, Empty, 10_000)
    const [gaveUp, after] = await run(
      Effect.gen(function* () {
        const session = yield* open()
        const first = yield* Effect.timeoutOption(session.call(waitsLong, {}), 100)
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
