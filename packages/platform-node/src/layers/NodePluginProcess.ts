/**
 * The plugin transport owner: the only code that starts a plugin binary.
 * It implements `PluginProcess` (`@runbooks/core/plugin/transport`) over
 * `node:child_process`, one JSON-RPC 2.0 message per line
 * (`plugin/base.schema.json`).
 *
 * - A plugin is found by kind and name among the pinned plugins, as the
 *   binary `runbooks-<kind>-<name>` in `binDir`. Its SHA-256 is checked
 *   before it starts, with no shell and only the environment it is given.
 * - `configure` goes first, with `PROTOCOL_VERSION` and the caller, and its
 *   answer must name the same version.
 * - Responses are matched to requests by id, and notifications to their
 *   request's stream. Every message is parsed against its schema.
 * - Every call has a timeout. `LIMITS` caps a line either way, the standard
 *   error kept, and a stream's items.
 * - Ending a session closes standard input, waits `LIMITS.exitGraceMillis`
 *   for the plugin to exit, then kills its process group: the plugin and
 *   whatever it started. On Windows only the plugin itself is killed.
 */
import { type ChildProcessByStdio, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import * as path from "node:path"
import type { Readable, Writable } from "node:stream"
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
  Queue,
  Redacted,
  Schema,
  Scope,
  Stream,
} from "effect"
import {
  ConfigureResult,
  ErrorResponse,
  Notification,
  ResultResponse,
} from "@runbooks/core/plugin/generated/base"
import {
  type ConfigureFields,
  LIMITS,
  type Method,
  type Platform,
  type PluginEntry,
  PluginExited,
  PluginHashMismatch,
  type PluginKind,
  PluginNotInstalled,
  PluginProcess,
  type PluginProtocol,
  PluginProtocolViolation,
  type PluginRemoteError,
  type PluginSession,
  PluginSpawnFailed,
  PluginTimedOut,
  PluginTooLarge,
  type PluginTransportError,
  PluginUnsupportedProtocolVersion,
  PROTOCOL_VERSION,
  type StreamItem,
  type StreamMethod,
} from "@runbooks/core/plugin/transport"

/**
 * Notifications a stream holds before its reader takes them. When it is
 * full, reading the plugin's output waits, so the plugin's writes block.
 */
const STREAM_BUFFER = 16

export interface PluginProcessConfig {
  /** The folder the binaries are in: `resources/bin`. */
  readonly binDir: string
  readonly platform: Platform
  /** The pinned plugins, from `resources/plugins.lock`. */
  readonly plugins: ReadonlyArray<PluginEntry>
  /** The calling app and its version, sent in `configure`: runbooks/0.31.0. */
  readonly caller: string
}

export const nodePluginProcess = (config: PluginProcessConfig): Layer.Layer<PluginProcess> =>
  Layer.succeed(
    PluginProcess,
    PluginProcess.of({
      open: (protocol, plugin, env, configure) =>
        Effect.gen(function* () {
          const binary = yield* verify(config, protocol.kind, plugin)
          const scope = yield* Scope.fork(yield* Effect.scope)
          return yield* start(config, protocol, plugin, binary, env, configure, scope).pipe(
            Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
          )
        }),
    }),
  )

const isWindows = (platform: Platform) => platform.startsWith("windows-")

/**
 * The file a plugin is released as: `runbooks-credential-aws`, with `.exe`
 * on Windows. Only this file may write such a name; a lint holds the rest of
 * the packages to that, so nothing else can start a plugin.
 */
export const binaryName = (kind: PluginKind, name: string, platform: Platform) =>
  `runbooks-${kind}-${name}${isWindows(platform) ? ".exe" : ""}`

/** The binary's path, once its SHA-256 is the pinned one. */
const verify = (
  config: PluginProcessConfig,
  kind: PluginKind,
  plugin: string,
): Effect.Effect<string, PluginNotInstalled | PluginHashMismatch | PluginSpawnFailed> =>
  Effect.gen(function* () {
    const entry = config.plugins.find((pinned) => pinned.kind === kind && pinned.name === plugin)
    const expected = entry?.sha256[config.platform]
    const notInstalled = new PluginNotInstalled({ plugin, platform: config.platform })
    if (expected === undefined) return yield* notInstalled
    const binary = path.join(config.binDir, binaryName(kind, plugin, config.platform))
    const actual = yield* sha256(binary).pipe(
      Effect.mapError((error) =>
        Predicate.hasProperty(error, "code") && error.code === "ENOENT"
          ? notInstalled
          : new PluginSpawnFailed({ plugin, message: error.message }),
      ),
    )
    if (actual !== expected) return yield* new PluginHashMismatch({ plugin, expected, actual })
    return binary
  })

const sha256 = (file: string): Effect.Effect<string, Error> =>
  Effect.callback((resume) => {
    const hash = createHash("sha256")
    const input = createReadStream(file)
    input.on("data", (chunk) => hash.update(chunk))
    input.on("error", (error) => resume(Effect.fail(error)))
    input.on("end", () => resume(Effect.succeed(hash.digest("hex"))))
    return Effect.sync(() => input.destroy())
  })

type Child = ChildProcessByStdio<Writable, Readable, Readable>

interface ChildExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

/** Starts the binary with no shell, as its own process group leader on POSIX. */
const spawnChild = (
  plugin: string,
  binary: string,
  env: { readonly [name: string]: Redacted.Redacted<string> },
  windows: boolean,
  exited: Deferred.Deferred<ChildExit>,
): Effect.Effect<Child, PluginSpawnFailed> =>
  Effect.callback((resume) => {
    const failed = (error: unknown) =>
      resume(Effect.fail(new PluginSpawnFailed({ plugin, message: String(error) })))
    try {
      const child = spawn(binary, [], {
        env: Object.fromEntries(
          Object.entries(env).map(([name, value]) => [name, Redacted.value(value)]),
        ),
        stdio: ["pipe", "pipe", "pipe"],
        detached: !windows,
        windowsHide: true,
      })
      child.once("exit", (code, signal) =>
        Deferred.doneUnsafe(exited, Exit.succeed({ code, signal })),
      )
      child.once("spawn", () => resume(Effect.succeed(child)))
      // A spawn that fails reports here, once. Later errors (a kill that
      // fails) have nothing to change: the exit or the kill's fallback does.
      child.on("error", failed)
      // A write after the plugin exited fails here; its exit ends the session.
      child.stdin.on("error", () => {})
    } catch (error) {
      failed(error)
    }
  })

const start = <K extends string, P, C>(
  config: PluginProcessConfig,
  protocol: PluginProtocol<K, P, C>,
  plugin: string,
  binary: string,
  env: { readonly [name: string]: Redacted.Redacted<string> },
  configure: (fields: ConfigureFields) => P,
  scope: Scope.Scope,
): Effect.Effect<PluginSession<K, C>, PluginTransportError | PluginRemoteError<K>> =>
  Effect.gen(function* () {
    type SessionError = PluginTransportError | PluginRemoteError<K>
    const windows = isWindows(config.platform)
    const exited = yield* Deferred.make<ChildExit>()
    const child = yield* spawnChild(plugin, binary, env, windows, exited)

    /** A request waiting for its answer. */
    interface Pending {
      readonly method: string
      readonly timer: Fiber.Fiber<void>
      /** Delivers the result. A failure has failed the request's caller, and ends the session. */
      readonly result: (raw: unknown) => Effect.Effect<void, PluginTransportError>
      /** The notification method of a stream, and how its params reach the stream. */
      readonly notification: Option.Option<{
        readonly method: string
        readonly deliver: (
          params: unknown,
        ) => Effect.Effect<void, PluginProtocolViolation | PluginTooLarge>
      }>
      readonly fail: (error: SessionError) => Effect.Effect<void>
    }
    const pending = new Map<number, Pending>()
    let nextId = 1
    /** Set once standard input closes: nothing more is written. */
    let closing = false
    /** Fails with what ended the session. */
    const over = yield* Deferred.make<never, PluginTransportError>()
    let stderr = Buffer.alloc(0)

    const violation = (message: string) => new PluginProtocolViolation({ plugin, message })

    /** The standard error kept, from the first whole character. */
    const stderrText = () => {
      let from = 0
      while (from < stderr.length && ((stderr[from] ?? 0) & 0xc0) === 0x80) from++
      return stderr.subarray(from).toString("utf8")
    }

    const exitedError = (exit: ChildExit) =>
      new PluginExited({
        plugin,
        ...(exit.code === null ? {} : { code: exit.code }),
        ...(exit.signal === null ? {} : { signal: exit.signal }),
        stderr: stderrText(),
      })

    let killed = false
    /** Kills once: a group that has gone may come back as another with the same id. */
    const killTree = Effect.sync(() => {
      const pid = child.pid
      if (pid === undefined || killed) return
      killed = true
      try {
        if (windows) child.kill("SIGKILL")
        else process.kill(-pid, "SIGKILL")
      } catch {
        // ESRCH: the group has already gone.
      }
    })

    /**
     * Closes standard input. Nothing more is written, and nothing more read
     * is answered: the plugin stops, and its exit ends the session.
     */
    const closeInput = Effect.sync(() => {
      closing = true
      child.stdin.end()
    })

    /** Closes standard input, waits for the plugin to exit, then kills its group. */
    const stop = Effect.gen(function* () {
      yield* closeInput
      yield* Deferred.await(exited).pipe(Effect.timeoutOption(LIMITS.exitGraceMillis))
      yield* killTree
      return yield* Deferred.await(exited).pipe(Effect.timeoutOption(LIMITS.exitGraceMillis))
    })

    /** Ends the session with `error`: every open call fails with it, and the plugin stops. */
    const end = (error: PluginTransportError): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (Deferred.isDoneUnsafe(over)) return
        yield* Deferred.fail(over, error)
        const stopped = closing
        yield* closeInput
        const open = [...pending.values()]
        pending.clear()
        for (const entry of open) yield* entry.fail(error)
        if (!stopped) yield* Effect.forkIn(stop, scope)
      })

    /** Takes a request off the open ones, when its answer has come. */
    const settle = (id: number): Effect.Effect<Option.Option<Pending>> =>
      Effect.gen(function* () {
        const entry = pending.get(id)
        if (entry === undefined) return Option.none()
        pending.delete(id)
        yield* Fiber.interrupt(entry.timer)
        return Option.some(entry)
      })

    /**
     * A caller stopped waiting before the answer. The protocol cancels a
     * call only by closing standard input, so the session ends when the
     * plugin exits.
     */
    const cancel = (id: number) =>
      Effect.gen(function* () {
        if (Option.isNone(yield* settle(id)) || closing) return
        yield* closeInput
        yield* Effect.forkIn(stop, scope)
      })

    const remoteError = (method: string, error: ErrorResponse["error"]): PluginRemoteError<K> => {
      const { kind: rawKind, ...data } = error.data
      const known = (kind: string): kind is K =>
        (protocol.errorKinds as ReadonlyArray<string>).includes(kind)
      return {
        _tag: "PluginRemoteError",
        plugin,
        method,
        kind: known(rawKind) ? rawKind : "unknown",
        rawKind,
        message: error.message,
        data,
      }
    }

    const decodeOr = <T>(schema: Schema.Codec<T, unknown>, raw: unknown, what: string) =>
      Effect.mapError(Schema.decodeUnknownEffect(schema)(raw), () =>
        violation(`${what} does not match its schema`),
      )

    /** One line of the plugin's standard output. A failure ends the session. */
    const handle = (line: string): Effect.Effect<void, PluginTransportError> =>
      Effect.gen(function* () {
        if (closing) return
        let message: unknown
        try {
          message = JSON.parse(line)
        } catch {
          return yield* violation("a line on standard output is not JSON")
        }
        if (!Predicate.isObject(message)) {
          return yield* violation("a line on standard output is not a JSON object")
        }
        if ("method" in message) {
          if ("id" in message) {
            return yield* violation("the plugin sent a request: a message with an id and a method")
          }
          const notification = yield* decodeOr(Notification, message, "a notification")
          const { request } = notification.params
          const entry = typeof request === "number" ? pending.get(request) : undefined
          if (entry === undefined) {
            return yield* violation(
              `${notification.method} names request ${request}, which is not open`,
            )
          }
          if (Option.isNone(entry.notification)) {
            return yield* violation(
              `${notification.method} names request ${request}, a call that streams nothing`,
            )
          }
          if (entry.notification.value.method !== notification.method) {
            return yield* violation(
              `${notification.method} is not a notification of ${entry.method}`,
            )
          }
          return yield* entry.notification.value.deliver(notification.params)
        }
        if ("result" in message && "error" in message) {
          return yield* violation("a response holds both a result and an error")
        }
        if ("error" in message) {
          const response = yield* decodeOr(ErrorResponse, message, "an error response")
          if (response.id === null) {
            return yield* violation(
              `the plugin could not read a request: ${response.error.message}`,
            )
          }
          const entry = yield* settleOrViolation(response.id)
          return yield* entry.fail(remoteError(entry.method, response.error))
        }
        if ("result" in message) {
          const response = yield* decodeOr(ResultResponse, message, "a response")
          const entry = yield* settleOrViolation(response.id)
          return yield* entry.result(response.result)
        }
        return yield* violation(
          "a message on standard output is neither a response nor a notification",
        )
      })

    const settleOrViolation = (id: string | number) =>
      Effect.gen(function* () {
        const entry = typeof id === "number" ? yield* settle(id) : Option.none<Pending>()
        if (Option.isNone(entry))
          return yield* violation(`a response names request ${id}, which is not open`)
        return entry.value
      })

    /** Registers a request and writes it. The request's own timer ends the session if it outlives it. */
    const send = (
      method: string,
      params: unknown,
      timeoutMillis: number,
      entry: Omit<Pending, "method" | "timer">,
    ): Effect.Effect<number, PluginTransportError> =>
      Effect.gen(function* () {
        if (closing) return yield* Deferred.await(over)
        const id = nextId++
        const line = JSON.stringify({ jsonrpc: "2.0", id, method, params })
        if (Buffer.byteLength(line) > LIMITS.maxLineBytes) {
          return yield* new PluginTooLarge({ plugin, limit: "line", max: LIMITS.maxLineBytes })
        }
        const timer = yield* Effect.sleep(timeoutMillis).pipe(
          Effect.andThen(end(new PluginTimedOut({ plugin, method, afterMillis: timeoutMillis }))),
          Effect.forkIn(scope),
        )
        pending.set(id, { ...entry, method, timer })
        child.stdin.write(`${line}\n`)
        return id
      })

    const encode = <A>(method: Method<A, unknown>, params: A) =>
      Schema.encodeUnknownEffect(method.params)(params).pipe(
        // The params are typed: one that fails its own schema is a bug here,
        // and the schema's message could quote a secret field.
        Effect.catch(() =>
          Effect.die(new Error(`the params of ${method.name} do not match their schema`)),
        ),
      )

    /** A call whose result is decoded by `decode`. */
    const request = <R>(
      method: string,
      params: unknown,
      timeoutMillis: number,
      decode: (raw: unknown) => Effect.Effect<R, PluginTransportError>,
    ): Effect.Effect<R, SessionError> =>
      Effect.gen(function* () {
        const answer = yield* Deferred.make<R, SessionError>()
        const id = yield* send(method, params, timeoutMillis, {
          notification: Option.none(),
          result: (raw) =>
            decode(raw).pipe(
              Effect.tapError((error) => Deferred.fail(answer, error)),
              Effect.flatMap((result) => Deferred.succeed(answer, result)),
            ),
          fail: (error) => Effect.asVoid(Deferred.fail(answer, error)),
        })
        return yield* Deferred.await(answer).pipe(Effect.onInterrupt(() => cancel(id)))
      })

    const call = <A, R>(method: Method<A, R>, params: A): Effect.Effect<R, SessionError> =>
      Effect.gen(function* () {
        const encoded = yield* encode(method, params)
        return yield* request(
          method.name,
          encoded,
          method.timeoutMillis ?? LIMITS.callTimeoutMillis,
          (raw) => decodeOr(method.result, raw, `the result of ${method.name}`),
        )
      })

    const stream = <A, N, R>(
      method: StreamMethod<A, N, R>,
      params: A,
    ): Stream.Stream<StreamItem<N, R>, SessionError> =>
      Stream.unwrap(
        Effect.gen(function* () {
          const encoded = yield* encode(method, params)
          const items = yield* Queue.bounded<StreamItem<N, R>, SessionError | Cause.Done>(
            STREAM_BUFFER,
          )
          let count = 0
          const id = yield* send(
            method.name,
            encoded,
            method.timeoutMillis ?? LIMITS.callTimeoutMillis,
            {
              notification: Option.some({
                method: method.notification.method,
                deliver: (raw) =>
                  Effect.gen(function* () {
                    count++
                    if (count > LIMITS.maxStreamItems) {
                      return yield* new PluginTooLarge({
                        plugin,
                        limit: "streamItems",
                        max: LIMITS.maxStreamItems,
                      })
                    }
                    const notification = yield* decodeOr(
                      method.notification.params,
                      raw,
                      `a ${method.notification.method} notification`,
                    )
                    yield* Queue.offer(items, { _tag: "Notification", params: notification })
                  }),
              }),
              result: (raw) =>
                decodeOr(method.result, raw, `the result of ${method.name}`).pipe(
                  Effect.tapError((error) => Queue.fail(items, error)),
                  Effect.flatMap((result) => Queue.offer(items, { _tag: "Result", result })),
                  Effect.andThen(Queue.end(items)),
                ),
              fail: (error) => Effect.asVoid(Queue.fail(items, error)),
            },
          )
          // Shut down first: reading the plugin's output may be waiting to offer to it.
          return Stream.fromQueue(items).pipe(
            Stream.ensuring(Effect.andThen(Queue.shutdown(items), cancel(id))),
          )
        }),
      )

    /** Lines of standard output, each at most `LIMITS.maxLineBytes` bytes without its newline. */
    let line: Buffer[] = []
    let lineBytes = 0
    const lines = (chunk: Buffer): Effect.Effect<void, PluginTransportError> =>
      Effect.gen(function* () {
        let from = 0
        while (from <= chunk.length) {
          const newline = chunk.indexOf(10, from)
          const piece = chunk.subarray(from, newline === -1 ? chunk.length : newline)
          lineBytes += piece.length
          if (lineBytes > LIMITS.maxLineBytes) {
            return yield* new PluginTooLarge({ plugin, limit: "line", max: LIMITS.maxLineBytes })
          }
          line.push(piece)
          if (newline === -1) return
          const text = Buffer.concat(line).toString("utf8")
          line = []
          lineBytes = 0
          yield* handle(text)
          from = newline + 1
        }
      })

    // Standard error: its last `LIMITS.maxStderrBytes` bytes, for `PluginExited`.
    const stderrDrained = yield* Stream.fromAsyncIterable(child.stderr, () => undefined).pipe(
      Stream.runForEach((chunk: Buffer) =>
        Effect.sync(() => {
          const kept = Buffer.concat([stderr, chunk])
          stderr = kept.subarray(Math.max(0, kept.length - LIMITS.maxStderrBytes))
        }),
      ),
      Effect.ignore,
      Effect.forkIn(scope),
    )

    // Standard output until it ends, then the plugin's exit ends the session.
    yield* Stream.fromAsyncIterable(child.stdout, () => undefined).pipe(
      Stream.runForEach(lines),
      Effect.catch((error) => (error === undefined ? Effect.void : end(error))),
      Effect.andThen(
        Effect.gen(function* () {
          const exit = yield* Deferred.await(exited)
          yield* Fiber.await(stderrDrained).pipe(Effect.timeoutOption(LIMITS.exitGraceMillis))
          yield* end(exitedError(exit))
        }),
      ),
      Effect.forkIn(scope),
    )

    // Added after the readers, so it runs before the scope interrupts them.
    yield* Scope.addFinalizer(
      scope,
      Effect.gen(function* () {
        const exit = yield* stop
        // A plugin still there after SIGKILL is stuck in the kernel: say it exited, with no code.
        yield* end(exitedError(Option.getOrElse(exit, () => ({ code: null, signal: null }))))
      }),
    )

    const fields: ConfigureFields = { protocolVersion: PROTOCOL_VERSION, caller: config.caller }
    const configured = yield* request(
      protocol.configure.name,
      yield* encode(protocol.configure, configure(fields)),
      protocol.configure.timeoutMillis ?? LIMITS.callTimeoutMillis,
      (raw) =>
        Effect.gen(function* () {
          const base = yield* decodeOr(ConfigureResult, raw, "the result of configure")
          if (base.protocolVersion !== PROTOCOL_VERSION) {
            return yield* new PluginUnsupportedProtocolVersion({
              plugin,
              offered: base.protocolVersion,
              supported: PROTOCOL_VERSION,
            })
          }
          return yield* decodeOr(protocol.configure.result, raw, "the result of configure")
        }),
    ).pipe(
      Effect.mapError((error) =>
        error._tag === "PluginRemoteError" && error.rawKind === "unsupportedProtocolVersion"
          ? new PluginUnsupportedProtocolVersion({ plugin, supported: PROTOCOL_VERSION })
          : error,
      ),
    )

    return { configured, call, stream }
  })
