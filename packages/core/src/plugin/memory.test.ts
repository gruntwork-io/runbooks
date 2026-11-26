import { describe, expect, it } from "bun:test"
import { Effect, Exit, Option, Schema, Stream } from "effect"
import { memoryPluginProcess, type PluginFactory, type PluginHandler } from "./memory.ts"
import {
  type Method,
  PluginProcess,
  type PluginProtocol,
  PROTOCOL_VERSION,
  type StreamMethod,
} from "./transport.ts"

const Configure = Schema.Struct({
  protocolVersion: Schema.String,
  caller: Schema.String,
  callTimeoutsMillis: Schema.Record(Schema.String, Schema.Int),
})
const Configured = Schema.Struct({ protocolVersion: Schema.String, driverVersion: Schema.String })
const Word = Schema.Struct({ word: Schema.String })

const echo: Method<{ readonly word: string }, { readonly word: string }> = {
  name: "echo",
  params: Word,
  result: Word,
}
const count: StreamMethod<
  { readonly n: number },
  { readonly i: number; readonly request: number },
  { readonly n: number }
> = {
  name: "count",
  params: Schema.Struct({ n: Schema.Int }),
  result: Schema.Struct({ n: Schema.Int }),
  notification: {
    method: "count.tick",
    params: Schema.Struct({ i: Schema.Int, request: Schema.Int }),
  },
}

const PROTOCOL: PluginProtocol<"timedOut", typeof Configure.Type, typeof Configured.Type> = {
  kind: "credential",
  errorKinds: ["timedOut"],
  configure: { name: "configure", params: Configure, result: Configured },
  methods: [echo, count],
}

/** A plugin that answers `answer`, configured with `version`; `seen` notes each request. */
const plugin =
  (answer: PluginHandler["answer"], seen: Array<string> = [], version = PROTOCOL_VERSION) =>
  () =>
    Effect.succeed<PluginHandler>({
      answer: (method, params, notify) => {
        seen.push(method)
        return method === "configure"
          ? Effect.succeed({ protocolVersion: version, driverVersion: "0.0.0" })
          : answer(method, params, notify)
      },
    })

const open = (plugins: { readonly [kindAndName: string]: PluginFactory }, name = "stub") =>
  Effect.gen(function* () {
    const owner = yield* PluginProcess
    return yield* owner.open(PROTOCOL, name, {}, (fields) => fields)
  }).pipe(Effect.provide(memoryPluginProcess("runbooks/test", plugins)))

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(Effect.exit(effect))

describe("a plugin in memory", () => {
  it("is configured first, then answers calls and streams, a notification carrying its request", async () => {
    const seen: Array<string> = []
    const exit = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* open({
            "credential/stub": plugin(
              (method, params, notify) =>
                method === "echo"
                  ? Effect.succeed(params)
                  : Effect.andThen(
                      Effect.forEach([1, 2], (i) => notify("count.tick", { i }), { discard: true }),
                      Effect.succeed({ n: 2 }),
                    ),
              seen,
            ),
          })
          const word = yield* session.call(echo, { word: "hi" })
          const items = yield* Stream.runCollect(session.stream(count, { n: 2 }))
          return { word, items }
        }),
      ),
    )
    expect(seen).toEqual(["configure", "echo", "count"])
    expect(Exit.isSuccess(exit) && exit.value).toEqual({
      word: { word: "hi" },
      items: [
        { _tag: "Notification", params: { i: 1, request: 3 } },
        { _tag: "Notification", params: { i: 2, request: 3 } },
        { _tag: "Result", result: { n: 2 } },
      ],
    })
  })

  it("is not there when no plugin of that kind and name is", async () => {
    const exit = await run(Effect.scoped(open({}, "missing")))
    expect(Exit.findErrorOption(exit).pipe(Option.map((error) => error._tag))).toEqual(
      Option.some("PluginExited"),
    )
  })

  it("must answer this app's protocol version", async () => {
    const exit = await run(
      Effect.scoped(open({ "credential/stub": plugin(() => Effect.void, [], "2") })),
    )
    expect(Exit.findErrorOption(exit).pipe(Option.map((error) => error._tag))).toEqual(
      Option.some("PluginUnsupportedProtocolVersion"),
    )
  })

  it("ends its session when a call is given up, or an answer breaks its schema", async () => {
    const exits = await Effect.runPromise(
      Effect.forEach(["givenUp", "broken"] as const, (how) =>
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* open({
              "credential/stub": plugin((_method, params) =>
                (params as { word: string }).word === "hang"
                  ? Effect.never
                  : (params as { word: string }).word === "broken"
                    ? Effect.succeed({ word: 1 })
                    : Effect.succeed(params),
              ),
            })
            if (how === "givenUp")
              yield* session.call(echo, { word: "hang" }).pipe(Effect.timeoutOption(10))
            else yield* Effect.exit(session.call(echo, { word: "broken" }))
            return yield* Effect.exit(session.call(echo, { word: "after" }))
          }),
        ),
      ),
    )
    expect(
      exits.map((exit) => Exit.findErrorOption(exit).pipe(Option.map((error) => error._tag))),
    ).toEqual([Option.some("PluginExited"), Option.some("PluginProtocolViolation")])
  })

  it("gives an error kind its protocol does not know as unknown, ending only that call", async () => {
    const exit = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* open({
            "credential/stub": plugin((_method, params) =>
              (params as { word: string }).word === "refuse"
                ? Effect.fail({ kind: "quotaExceeded", message: "Too many." })
                : Effect.succeed(params),
            ),
          })
          const refused = yield* Effect.flip(session.call(echo, { word: "refuse" }))
          const after = yield* session.call(echo, { word: "after" })
          return { refused, after }
        }),
      ),
    )
    expect(Exit.isSuccess(exit) && exit.value).toMatchObject({
      refused: { _tag: "PluginRemoteError", kind: "unknown", rawKind: "quotaExceeded" },
      after: { word: "after" },
    })
  })
})
