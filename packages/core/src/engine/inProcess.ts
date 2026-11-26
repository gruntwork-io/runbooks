/**
 * The in-process transport: how the CLI and MCP drive the engine in their
 * own process. It serves `EngineProtocol` with effect's `RpcServer.make` and
 * `RpcClient.make`, as a transport over a wire does, with the JSON codecs
 * (`RpcSerialization.json`). Every command, answer, error and event is
 * encoded and decoded through the protocol's schemas both ways, so a value
 * a schema cannot carry fails under test as it does over a wire. The
 * encoded messages are handed straight to the other side.
 *
 * - Who is calling is fixed when the client is made. Each client has a
 *   server of its own, whose `CallerMiddleware` gives every command that
 *   origin; nothing the client sends, payload or headers, is read for it.
 * - A stream's next chunk is read only once the client has taken the last
 *   into its buffer, which holds `streamBufferSize` items (effect's 16,
 *   unless a call says otherwise).
 * - The client and its server live in the caller's scope. Closing it ends
 *   the client's calls and streams, and the server's work for them.
 */
import { Deferred, Effect, Option, Queue, type Scope } from "effect"
import {
  type Rpc,
  RpcClient,
  type RpcClientError,
  type RpcMessage,
  RpcSerialization,
  RpcServer,
} from "effect/rpc"
import {
  Caller,
  CallerMiddleware,
  type EngineCommand,
  EngineProtocol,
  type Origin,
} from "./protocol.ts"

/** A client of the engine, as every transport gives one. */
export type EngineClient = RpcClient.RpcClient<EngineCommand, RpcClientError.RpcClientError>

/** The id the one client of each server has. */
const CLIENT = 0

const { codecFor } = RpcSerialization.json

/**
 * A client of the engine for a caller of `origin`, served by the handlers
 * in context (`EngineHandlers`). It lasts as long as the scope.
 */
export const makeInProcessClient = Effect.fnUntraced(function* (
  origin: Origin,
): Effect.fn.Return<EngineClient, never, Scope.Scope | Rpc.ToHandler<EngineCommand>> {
  const toServer =
    yield* Deferred.make<
      (client: number, message: RpcMessage.FromClientEncoded) => Effect.Effect<void>
    >()
  const toClient =
    yield* Deferred.make<(message: RpcMessage.FromServerEncoded) => Effect.Effect<void>>()

  const server = RpcServer.Protocol.of({
    run: (receive) => Effect.andThen(Deferred.succeed(toServer, receive), Effect.never),
    // Nothing disconnects: the client and its server close with one scope.
    disconnects: yield* Queue.bounded<number>(1),
    send: (_client, response) =>
      Effect.flatMap(Deferred.await(toClient), (receive) => receive(response)),
    end: () => Effect.void,
    clientIds: Effect.sync(() => new Set([CLIENT])),
    initialMessage: Effect.succeed(Option.none()),
    supportsAck: true,
    supportsTransferables: false,
    supportsSpanPropagation: true,
    supportsNotifications: false,
    codecFor,
  })
  yield* RpcServer.make(EngineProtocol).pipe(
    Effect.provideService(RpcServer.Protocol, server),
    Effect.provideService(CallerMiddleware, (effect) =>
      Effect.provideService(effect, Caller, { origin }),
    ),
    Effect.forkScoped,
  )

  const client = RpcClient.Protocol.of({
    run: (_client, receive) => Effect.andThen(Deferred.succeed(toClient, receive), Effect.never),
    send: (_client, request) =>
      Effect.flatMap(Deferred.await(toServer), (receive) => receive(CLIENT, request)),
    supportsAck: true,
    supportsTransferables: false,
    codecFor,
  })
  return yield* RpcClient.make(EngineProtocol).pipe(
    Effect.provideService(RpcClient.Protocol, client),
  )
})
