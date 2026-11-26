/**
 * The engine's server end over Electron IPC: an `RpcServer.Protocol` on the
 * app window's web contents, which serves `EngineProtocol` to the window's
 * page. Messages are JSON strings, one RPC envelope each, encoded with the
 * JSON codecs (`RpcSerialization.json`), as the in-process transport's.
 *
 * - Only the app's page is heard. A message reaches the server only when it
 *   comes from the main frame the window's contents show now, a frame of a
 *   window (not a `<webview>` guest), still attached, at the app's page URL
 *   (`isAppPage`). Main drops the rest unread.
 * - One client per page load. Main gives each document the main frame
 *   commits (`did-navigate`, a reload too) a connection of its own, with an
 *   id main counts out: nothing the page sends chooses or names it. A new
 *   document, the renderer's process ending or the contents going ends the
 *   connection, and the server then ends that client's calls and streams.
 * - The caller is a person: `CallerMiddleware` gives every command from the
 *   page that origin, from the connection, never from the message.
 * - Bounded. A stream's next chunk waits for the page's ack. A message the
 *   page sends is a string of at most `MAX_PAGE_MESSAGE` code units, parsed
 *   only then, and is one of a request, an ack or an interrupt. Main holds
 *   at most `MAX_QUEUED` of a page load's messages the server has not
 *   taken; a page that sends more loses its connection, as a reload would.
 *   What main sends the page is not capped: the engine's answers are bounded
 *   by the protocol's `LIMITS`, and its streams by the acks.
 *
 * What it drops it logs once per page load and kind, in a fixed line that
 * holds nothing from the message or its sender.
 *
 * Only `import type` from electron, so the tests drive it with stand-ins.
 */
import type { IpcMainEvent, WebContents } from "electron"
import { Deferred, Effect, FiberSet, Option, Queue, Schema, type Scope } from "effect"
import { type Rpc, type RpcMessage, RpcSerialization, RpcServer } from "effect/rpc"
import {
  Caller,
  CallerMiddleware,
  type EngineCommand,
  EngineProtocol,
} from "@runbooks/core/protocol"
import { FROM_PAGE, MAX_PAGE_MESSAGE, TO_PAGE } from "./bridge.ts"

/**
 * A page load's messages main holds before the server takes them. The
 * server takes each as it comes, so only a page that floods main, or one
 * that sends while the engine is still starting, gets near it.
 */
export const MAX_QUEUED = 1024

/**
 * Ended connections the server has not yet been told of. Each page load
 * ends one; past this many, the next waits for the server to take one.
 */
const MAX_PENDING_DISCONNECTS = 16

/** The lines main logs when it drops a message, by kind. */
export const DROPPED = {
  refused: "The engine dropped a message that did not come from the app's page.",
  malformed: `The engine dropped a message from the app's page that was not a request, an ack or an interrupt of at most ${MAX_PAGE_MESSAGE} characters.`,
  flooded: `The engine ended the page's connection: the page sent more than ${MAX_QUEUED} messages before the engine took them.`,
} as const

/** A frame as the sender check reads it. */
interface Frame {
  readonly url: string
  readonly parent: unknown
  readonly detached: boolean
  readonly processId: number
  readonly routingId: number
}

/** The web contents as the sender check reads them. */
interface Contents {
  readonly mainFrame: Frame
  isDestroyed(): boolean
  getType(): string
}

/** An IPC event as the sender check reads it. */
export interface SenderEvent {
  readonly sender: unknown
  readonly senderFrame: Frame | null
}

/**
 * Whether `event` comes from the app's page in `contents`: from the main
 * frame those contents show now, of a window, at `page` (fragment aside).
 * Any other frame, a frame that has gone or been replaced, a `<webview>`
 * guest, or another page in the app's window is refused.
 */
export function isAppPage(event: SenderEvent, contents: Contents, page: URL): boolean {
  if (event.sender !== contents || contents.isDestroyed() || contents.getType() !== "window")
    return false
  const frame = event.senderFrame
  if (frame === null || frame.detached || frame.parent !== null) return false
  const main = contents.mainFrame
  if (frame.processId !== main.processId || frame.routingId !== main.routingId) return false
  const url = URL.parse(frame.url)
  if (url === null) return false
  url.hash = ""
  return url.href === withoutFragment(page).href
}

function withoutFragment(url: URL): URL {
  const copy = new URL(url)
  copy.hash = ""
  return copy
}

// A request id as the client encodes it.
const RequestId = Schema.Union([Schema.String, Schema.Number])

/**
 * What the page may send: a request, an ack of a stream's chunk, or an
 * interrupt. The server decodes a request's payload with its command's
 * schema. Fields beyond these are dropped here.
 */
const PageMessage = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("Request"),
    id: RequestId,
    tag: Schema.String,
    payload: Schema.Unknown,
    headers: Schema.Array(Schema.mutable(Schema.Tuple([Schema.String, Schema.String]))),
  }),
  Schema.Struct({ _tag: Schema.Literal("Ack"), requestId: RequestId }),
  Schema.Struct({ _tag: Schema.Literal("Interrupt"), requestId: RequestId }),
])
const decodePageMessage = Schema.decodeUnknownOption(PageMessage)

/** The message `message` holds, when it is one the page may send. */
function readPageMessage(message: unknown): RpcMessage.FromClientEncoded | undefined {
  if (typeof message !== "string" || message.length > MAX_PAGE_MESSAGE) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(message)
  } catch {
    return undefined
  }
  return Option.getOrUndefined(decodePageMessage(parsed))
}

const serialization = RpcSerialization.json.makeUnsafe()

/** A page load's connection: its client id, and the messages the server has yet to take. */
interface Connection {
  readonly id: number
  readonly inbox: Queue.Queue<RpcMessage.FromClientEncoded>
  /** Hands the inbox to the server, and tells the server of the end. */
  readonly fiber: { readonly interruptUnsafe: () => void }
}

export interface IpcServerOptions {
  /** The app window's web contents. */
  readonly contents: WebContents
  /** The app's page: its file URL in a build, the dev server's in dev. */
  readonly page: URL
  /** Where a dropped message is reported. */
  readonly log: (line: string) => void
}

/**
 * The server protocol on `options.contents`, listening from now on, so
 * make it before the window loads its page. It stops listening, and ends
 * the page's connection, when the scope closes.
 */
export const makeIpcServerProtocol = Effect.fnUntraced(function* (
  options: IpcServerOptions,
): Effect.fn.Return<RpcServer.Protocol["Service"], never, Scope.Scope> {
  const { contents, page, log } = options
  const receiver =
    yield* Deferred.make<
      (client: number, message: RpcMessage.FromClientEncoded) => Effect.Effect<void>
    >()
  const disconnects = yield* Queue.bounded<number>(MAX_PENDING_DISCONNECTS)
  const fork = yield* FiberSet.makeRuntime<never>()
  // Finalizers run last first: closing, a connection's end does not wait
  // for a server that has stopped.
  yield* Effect.addFinalizer(() => Queue.shutdown(disconnects))

  let nextId = 0
  let current: Connection | undefined
  let logged = new Set<keyof typeof DROPPED>()
  const drop = (kind: keyof typeof DROPPED) => {
    if (logged.has(kind)) return
    logged.add(kind)
    log(DROPPED[kind])
  }

  const open = (): Connection => {
    const id = nextId++
    const inbox = Effect.runSync(Queue.bounded<RpcMessage.FromClientEncoded>(MAX_QUEUED))
    const fiber = fork(
      Effect.flatMap(Deferred.await(receiver), (receive) =>
        Effect.forever(Effect.flatMap(Queue.take(inbox), (message) => receive(id, message))),
      ).pipe(
        // After the last message it handed over, so the server cannot see
        // this client again once it has ended it.
        Effect.ensuring(Queue.offer(disconnects, id)),
      ),
    )
    return { id, inbox, fiber }
  }
  const end = () => {
    const ended = current
    current = undefined
    ended?.fiber.interruptUnsafe()
  }

  const onMessage = (event: IpcMainEvent, message: unknown) => {
    if (!isAppPage(event, contents, page)) return drop("refused")
    const connection = current
    if (connection === undefined) return
    const read = readPageMessage(message)
    if (read === undefined) return drop("malformed")
    if (Queue.offerUnsafe(connection.inbox, read)) return
    drop("flooded")
    end()
  }
  const onNavigate = () => {
    end()
    logged = new Set()
    current = open()
  }

  contents.ipc.on(FROM_PAGE, onMessage)
  contents.on("did-navigate", onNavigate)
  contents.on("render-process-gone", end)
  contents.on("destroyed", end)
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (!contents.isDestroyed()) {
        contents.ipc.off(FROM_PAGE, onMessage)
        contents.off("did-navigate", onNavigate)
        contents.off("render-process-gone", end)
        contents.off("destroyed", end)
      }
      end()
    }),
  )

  return RpcServer.Protocol.of({
    run: (receive) => Effect.andThen(Deferred.succeed(receiver, receive), Effect.never),
    disconnects,
    send: (client, response) =>
      Effect.sync(() => {
        if (current?.id !== client || contents.isDestroyed()) return
        contents.send(TO_PAGE, serialization.encode(response))
      }),
    end: () => Effect.void,
    clientIds: Effect.sync(() => new Set(current === undefined ? [] : [current.id])),
    initialMessage: Effect.succeed(Option.none()),
    supportsAck: true,
    supportsTransferables: false,
    supportsSpanPropagation: false,
    supportsNotifications: false,
    codecFor: RpcSerialization.json.codecFor,
  })
})

/**
 * Serves the handlers in context over `protocol`, every command as a
 * person's. It runs until interrupted.
 */
export const servePage = (
  protocol: RpcServer.Protocol["Service"],
): Effect.Effect<never, never, Rpc.ToHandler<EngineCommand>> =>
  RpcServer.make(EngineProtocol).pipe(
    Effect.provideService(RpcServer.Protocol, protocol),
    Effect.provideService(CallerMiddleware, (effect) =>
      Effect.provideService(effect, Caller, { origin: "person" }),
    ),
  )
