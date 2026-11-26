/**
 * The window's client of the engine: an `RpcClient.Protocol` over the bridge
 * the preload gives the page (`window.engine`), with the JSON codecs
 * (`RpcSerialization.json`), as main's server end has. Each message is one
 * JSON string through the bridge.
 *
 * - A page load makes one client. Main knows it by the page load, so a
 *   reload starts a new one there too, and nothing the client sends names it.
 * - Each message from main is handed to the client on a fiber of its own,
 *   so a stream whose buffer is full does not hold up the answer its reader
 *   is waiting on. Acks bound them: a stream has one chunk in flight at
 *   most, and a call one answer.
 * - A message the bridge refuses (over its 1 MiB cap) fails its call with
 *   an `RpcClientError`, and one from main that is not JSON or not an
 *   answer, a chunk or a defect is dropped.
 *
 * It imports the core's protocol and effect only.
 */
import { Deferred, Effect, FiberSet, Option, Schema, type Scope } from "effect"
import { RpcClient, RpcClientError, type RpcMessage, RpcSerialization } from "effect/rpc"
import { type EngineClient, EngineProtocol } from "@runbooks/core/protocol"

/** The bridge, as the preload gives it (packages/app-main/src/bridge.ts). */
export interface EngineBridge {
  /** Sends one message to the engine. Throws, sending nothing, for one over the cap. */
  readonly send: (message: string) => void
  /** Calls `listener` with each message from the engine until the function it returns is called. */
  readonly onMessage: (listener: (message: string) => void) => () => void
}

declare global {
  interface Window {
    /** The preload's bridge to the engine. */
    readonly engine: EngineBridge
  }
}

// A request id as the server encodes it.
const RequestId = Schema.Union([Schema.String, Schema.Number])

/**
 * What main sends: an answer, a stream's chunk, or a defect. The client
 * decodes their values with each command's schemas.
 */
const ServerMessage = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Exit"), requestId: RequestId, exit: Schema.Any }),
  Schema.Struct({
    _tag: Schema.Literal("Chunk"),
    requestId: RequestId,
    values: Schema.NonEmptyArray(Schema.Unknown),
  }),
  Schema.Struct({ _tag: Schema.Literal("Defect"), defect: Schema.Unknown }),
])
const decodeServerMessage = Schema.decodeUnknownOption(ServerMessage)

/** The message `text` holds, when it is one main sends. */
function readServerMessage(text: string): RpcMessage.FromServerEncoded | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  return Option.getOrUndefined(decodeServerMessage(parsed))
}

/** A client of the engine over `bridge`. It stops hearing the bridge when the scope closes. */
export const makeEngineClient = Effect.fnUntraced(function* (
  bridge: EngineBridge,
): Effect.fn.Return<EngineClient, never, Scope.Scope> {
  const receiver =
    yield* Deferred.make<(message: RpcMessage.FromServerEncoded) => Effect.Effect<void>>()
  const deliver = yield* FiberSet.makeRuntime<never>()
  const stop = bridge.onMessage((text) => {
    const message = readServerMessage(text)
    if (message === undefined) return
    deliver(Effect.flatMap(Deferred.await(receiver), (receive) => receive(message)))
  })
  yield* Effect.addFinalizer(() => Effect.sync(stop))

  const protocol = RpcClient.Protocol.of({
    run: (_client, receive) => Effect.andThen(Deferred.succeed(receiver, receive), Effect.never),
    send: (_client, request) =>
      Effect.try({
        // As RpcSerialization.json encodes it.
        try: () => bridge.send(JSON.stringify(request)),
        catch: (cause) =>
          new RpcClientError.RpcClientError({
            reason: new RpcClientError.RpcClientDefect({
              message: "The engine bridge refused the message.",
              cause,
            }),
          }),
      }),
    supportsAck: true,
    supportsTransferables: false,
    codecFor: RpcSerialization.json.codecFor,
  })
  return yield* RpcClient.make(EngineProtocol).pipe(
    Effect.provideService(RpcClient.Protocol, protocol),
  )
})
