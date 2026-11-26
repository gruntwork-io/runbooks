/**
 * `PluginProcess` in memory: a plugin is a `PluginHandler`, an object that
 * answers requests as the binary's process would, and a session runs it in
 * a fiber of its own instead of a child process. Engine tests and a dev
 * mode with no binaries reach a plugin-backed credential provider through
 * it, by the same client code the app runs.
 *
 * What it keeps of the transport owner (`NodePluginProcess`): `configure`
 * goes first with the owner's fields and must answer this protocol
 * version; every params and result goes through its schema and through
 * JSON; each call has its method's limit, and one past it ends the
 * session; a stream's notifications are bounded; a remote error ends only
 * its call; giving up a call, or closing the scope, ends the session, and
 * every later call fails with `PluginExited`. What it leaves out: the
 * binary, its hash, its pipes and their line limit.
 */
import { Deferred, Effect, Exit, Layer, Queue, Redacted, Schema, Scope, Stream } from "effect"
import { ConfigureParams, ConfigureResult } from "./generated/base.ts"
import {
  callTimeoutsOf,
  LIMITS,
  type Method,
  type ConfigureFields,
  PluginExited,
  PluginProcess,
  type PluginProtocol,
  PluginProtocolViolation,
  type PluginRemoteError,
  type PluginSession,
  PluginTimedOut,
  PluginTooLarge,
  type PluginTransportError,
  PluginUnsupportedProtocolVersion,
  PROTOCOL_VERSION,
  type StreamItem,
  type StreamMethod,
} from "./transport.ts"

/** The error a plugin answers with: its `data.kind`, its message, and the rest of its `data`. */
export interface PluginRefusal {
  readonly kind: string
  readonly message: string
  readonly data?: { readonly [field: string]: unknown }
}

/** One running plugin, in memory: its process's state lives in the handler. */
export interface PluginHandler<R = never> {
  /**
   * Answers one request with its result, or refuses it. `notify` sends a
   * notification for this request (signIn's prompts), its `request` field
   * added. A request given up is interrupted, as stdin closing aborts it.
   */
  readonly answer: (
    method: string,
    params: unknown,
    notify: (method: string, params: { readonly [field: string]: unknown }) => Effect.Effect<void>,
  ) => Effect.Effect<unknown, PluginRefusal, R>
}

/** Starts a plugin in memory with the environment its process would get. */
export type PluginFactory<R = never> = (env: {
  readonly [name: string]: string
}) => Effect.Effect<PluginHandler<R>, never, R>

/** Notifications a stream holds before the handler's `notify` waits, as the owner's `STREAM_BUFFER`. */
const STREAM_BUFFER = 16

const isConfigureParams = Schema.is(ConfigureParams)

/**
 * A `PluginProcess` whose plugins are `plugins`, keyed by kind and name
 * (`credential/fake`). An unknown one fails with `PluginExited`, as a
 * binary that is not there would never start.
 */
export const memoryPluginProcess = <R>(
  caller: string,
  plugins: { readonly [kindAndName: string]: PluginFactory<R> },
): Layer.Layer<PluginProcess, never, R> =>
  Layer.effect(
    PluginProcess,
    Effect.map(Effect.context<R>(), (context) =>
      PluginProcess.of({
        open: (protocol, plugin, env, configure) =>
          Effect.gen(function* () {
            const key = `${protocol.kind}/${plugin}`
            const factory = Object.hasOwn(plugins, key) ? plugins[key] : undefined
            if (factory === undefined)
              return yield* new PluginExited({
                plugin,
                stderr: `There is no ${protocol.kind} plugin named ${plugin} in memory.`,
              })
            const scope = yield* Scope.fork(yield* Effect.scope)
            return yield* start(
              protocol,
              plugin,
              caller,
              (vars) => Effect.provideContext(factory(vars), context),
              (effect) => Effect.provideContext(effect, context),
              env,
              configure,
              scope,
            ).pipe(Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))))
          }),
      }),
    ),
  )

const start = <K extends string, P, C, R>(
  protocol: PluginProtocol<K, P, C>,
  plugin: string,
  caller: string,
  factory: (env: { readonly [name: string]: string }) => Effect.Effect<PluginHandler<R>>,
  provide: <A, E>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E>,
  env: { readonly [name: string]: Redacted.Redacted<string> },
  configure: (fields: ConfigureFields) => P,
  scope: Scope.Scope,
): Effect.Effect<PluginSession<K, C>, PluginTransportError | PluginRemoteError<K>> =>
  Effect.gen(function* () {
    type SessionError = PluginTransportError | PluginRemoteError<K>
    const handler = yield* factory(
      // A process reads its environment as plain strings.
      Object.fromEntries(Object.entries(env).map(([name, value]) => [name, Redacted.value(value)])),
    )
    const limits = callTimeoutsOf(protocol)
    const over = yield* Deferred.make<never, PluginTransportError>()
    let nextId = 1

    /** Ends the session with `error`: running calls fail with it, and so does every later one. */
    const end = (error: PluginTransportError) => Effect.asVoid(Deferred.fail(over, error))
    yield* Scope.addFinalizer(scope, end(new PluginExited({ plugin, code: 0, stderr: "" })))

    const violation = (message: string) => new PluginProtocolViolation({ plugin, message })
    const ended = (error: PluginTransportError) => Effect.andThen(end(error), Effect.fail(error))
    const toWire = (value: unknown): Effect.Effect<unknown, PluginTransportError> => {
      try {
        return Effect.succeed(JSON.parse(JSON.stringify(value)))
      } catch {
        return ended(violation("an answer is not JSON"))
      }
    }
    const remoteError = (method: string, refusal: PluginRefusal): PluginRemoteError<K> => ({
      _tag: "PluginRemoteError",
      plugin,
      method,
      kind: (protocol.errorKinds as ReadonlyArray<string>).includes(refusal.kind)
        ? (refusal.kind as K)
        : "unknown",
      rawKind: refusal.kind,
      message: refusal.message,
      data: refusal.data ?? {},
    })
    const limitOf = (method: string): Effect.Effect<number> => {
      const limit = Object.hasOwn(limits, method) ? limits[method] : undefined
      return limit === undefined
        ? Effect.die(new Error(`${method} is not a method of the ${protocol.kind} protocol`))
        : Effect.succeed(limit)
    }
    const encode = <A>(method: Method<A, unknown>, params: A) =>
      Schema.encodeUnknownEffect(method.params)(params).pipe(
        Effect.catch(() =>
          Effect.die(new Error(`the params of ${method.name} do not match their schema`)),
        ),
      )
    const decode = <T>(schema: Schema.Codec<T, unknown>, raw: unknown, what: string) =>
      Effect.catch(Schema.decodeUnknownEffect(schema)(raw), () =>
        ended(violation(`${what} does not match its schema`)),
      )

    /**
     * Runs one request: the handler's answer, within the method's limit and
     * the session. Past the limit, or given up, the session ends.
     */
    const request = <A>(
      method: string,
      params: unknown,
      notify: (
        id: number,
      ) => (name: string, params: { readonly [field: string]: unknown }) => Effect.Effect<void>,
      decodeResult: (raw: unknown) => Effect.Effect<A, PluginTransportError>,
    ): Effect.Effect<A, SessionError> =>
      Effect.gen(function* () {
        const limit = yield* limitOf(method)
        if (yield* Deferred.isDone(over)) return yield* Deferred.await(over)
        const id = nextId++
        const wire = yield* toWire(params)
        const answered = provide(handler.answer(method, wire, notify(id))).pipe(
          Effect.mapError((refusal) => remoteError(method, refusal)),
          Effect.flatMap(toWire),
          Effect.flatMap(decodeResult),
          Effect.timeoutOrElse({
            duration: limit,
            orElse: () => ended(new PluginTimedOut({ plugin, method, afterMillis: limit })),
          }),
        )
        return yield* Effect.raceFirst(answered, Deferred.await(over)).pipe(
          Effect.onInterrupt(() => end(new PluginExited({ plugin, code: 0, stderr: "" }))),
        )
      })

    const call = <A, R2>(method: Method<A, R2>, params: A): Effect.Effect<R2, SessionError> =>
      Effect.flatMap(encode(method, params), (encoded) =>
        request(
          method.name,
          encoded,
          () => () => Effect.die(new Error(`${method.name} sends no notifications`)),
          (raw) => decode(method.result, raw, `the result of ${method.name}`),
        ),
      )

    const stream = <A, N, R2>(
      method: StreamMethod<A, N, R2>,
      params: A,
    ): Stream.Stream<StreamItem<N, R2>, SessionError> =>
      Stream.callback<StreamItem<N, R2>, SessionError>(
        (items) =>
          Effect.gen(function* () {
            const encoded = yield* encode(method, params)
            let count = 0
            const notify =
              (id: number) => (name: string, raw: { readonly [field: string]: unknown }) =>
                Effect.gen(function* () {
                  if (name !== method.notification.method)
                    return yield* ended(violation(`a ${name} notification for ${method.name}`))
                  count++
                  if (count > LIMITS.maxStreamItems)
                    return yield* ended(
                      new PluginTooLarge({
                        plugin,
                        limit: "streamItems",
                        max: LIMITS.maxStreamItems,
                      }),
                    )
                  const wire = yield* toWire({ ...raw, request: id })
                  const notification = yield* decode(
                    method.notification.params,
                    wire,
                    `a ${method.notification.method} notification`,
                  )
                  yield* Queue.offer(items, { _tag: "Notification", params: notification })
                }).pipe(
                  // A notification that breaks the protocol has ended the session; the request fails with it.
                  Effect.catch(() => Effect.void),
                )
            const result = yield* request(method.name, encoded, notify, (raw) =>
              decode(method.result, raw, `the result of ${method.name}`),
            )
            yield* Queue.offer(items, { _tag: "Result", result })
            yield* Queue.end(items)
          }).pipe(Effect.catch((error) => Queue.fail(items, error))),
        { bufferSize: STREAM_BUFFER, strategy: "suspend" },
      )

    const fields: ConfigureFields = {
      protocolVersion: PROTOCOL_VERSION,
      caller,
      callTimeoutsMillis: limits,
    }
    const params = yield* encode(protocol.configure, configure(fields))
    if (!isConfigureParams(params))
      return yield* Effect.die(
        new Error(`the ${protocol.kind} protocol's configure params drop the owner's fields`),
      )
    const configured = yield* request(
      protocol.configure.name,
      params,
      () => () => Effect.die(new Error("configure sends no notifications")),
      (raw) =>
        Effect.gen(function* () {
          const base = yield* decode(ConfigureResult, raw, "the result of configure")
          if (base.protocolVersion !== PROTOCOL_VERSION)
            return yield* ended(
              new PluginUnsupportedProtocolVersion({
                plugin,
                offered: base.protocolVersion,
                supported: PROTOCOL_VERSION,
              }),
            )
          return yield* decode(protocol.configure.result, raw, "the result of configure")
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
