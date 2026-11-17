import { vi, type Mock } from "vitest"
import type { RunbooksAPI } from "@/contexts/ApiContext"
import type {
  EventChannel,
  InvokeChannel,
  IpcChannelMap,
  IpcEventMap,
} from "../../../electron/shared/channels.ts"

// =============================================================================
// makeTestApi: a typed fake of the IPC API (window.api) for renderer tests
// =============================================================================
//
// The renderer's counterpart of src/test-utils/TestLayer.ts. A handler's params
// and result come from IpcChannelMap and an event's payload from IpcEventMap,
// so a stub of the wrong shape fails typecheck. Invoking a channel nobody gave
// a handler rejects; it never resolves undefined.

export type Params<C extends InvokeChannel> = IpcChannelMap[C]["params"]
export type Result<C extends InvokeChannel> = IpcChannelMap[C]["result"]
export type Payload<E extends EventChannel> = IpcEventMap[E]

/** Answers one channel's invokes, now or later. A throw rejects the invoke. */
export type Handler<C extends InvokeChannel> = (params: Params<C>) => Result<C> | Promise<Result<C>>

export type Handlers = { [C in InvokeChannel]?: Handler<C> }

/** An invoke that `hold` keeps pending until the test settles it. */
export interface HeldCall<C extends InvokeChannel> {
  readonly params: Params<C>
  resolve(result: Result<C>): void
  reject(error: unknown): void
}

/** One invoke, in the order the code under test made it. `callsTo` types the params. */
export interface InvokeCall {
  readonly channel: InvokeChannel
  readonly params: unknown
}

/**
 * The arguments after the channel: none for a channel that carries nothing
 * (void), else the one params or payload. RunbooksAPI spells invoke's this way.
 */
type PayloadArgs<T> = T extends void ? [] : [payload: T]

/**
 * The params or payload in `args`. TypeScript can't narrow the conditional
 * PayloadArgs tuple for a generic channel, so it can't see that its first
 * element is a `T`. It is: for a channel that carries nothing the tuple is
 * empty, and undefined is a void. This is the fake's one cast.
 */
function payloadOf<T>(args: PayloadArgs<T>): T {
  return args[0] as T
}

export interface TestApi {
  /** Pass this to ApiProvider. */
  readonly api: RunbooksAPI
  /**
   * The spy behind api.invoke, called with the same arguments, for
   * `toHaveBeenCalledWith` and friends. It only records: answers come from
   * the handlers, so give it no implementation.
   */
  readonly invoke: Mock<(channel: InvokeChannel, ...args: unknown[]) => void>
  /** The spy behind api.on, called with the same arguments. */
  readonly on: Mock<(channel: EventChannel, callback: unknown) => void>
  /** Every invoke, in order. */
  readonly calls: readonly InvokeCall[]
  /** The params of every invoke of `channel` so far, in order. */
  callsTo<C extends InvokeChannel>(channel: C): Params<C>[]
  /** Each invoke of a channel with no handler, in order. All of them rejected. */
  readonly unhandled: readonly InvokeChannel[]
  /** Sets or replaces the handler of `channel`. */
  handle<C extends InvokeChannel>(channel: C, handler: Handler<C>): void
  /**
   * From now on, every invoke of `channel` stays pending until the test
   * settles it through the returned list, which grows as the calls arrive.
   */
  hold<C extends InvokeChannel>(channel: C): readonly HeldCall<C>[]
  /** Calls every callback api.on subscribed to `channel`, as main sending the event would. */
  emit<E extends EventChannel>(channel: E, ...args: PayloadArgs<Payload<E>>): void
  /** How many api.on callbacks for `channel` are still subscribed. */
  listenerCount(channel: EventChannel): number
}

/**
 * A fake IPC API that answers each channel with its handler in `handlers`. An
 * invoke of a channel with no handler rejects with
 * "makeTestApi: no handler for <channel>".
 */
export function makeTestApi(handlers: Handlers = {}): TestApi {
  const configured: Handlers = { ...handlers }
  const calls: InvokeCall[] = []
  const callsByChannel: { [C in InvokeChannel]?: Params<C>[] } = {}
  const unhandled: InvokeChannel[] = []
  const listeners: { [E in EventChannel]?: Set<(payload: Payload<E>) => void> } = {}
  const invokeSpy: TestApi["invoke"] = vi.fn()
  const onSpy: TestApi["on"] = vi.fn()

  // These stores hold a value whose type depends on its channel. TypeScript
  // reads such a mapped type through a generic key (configured[channel] is a
  // Handler<C>), but can't check a write through one against the whole
  // record. So each write goes through a view of the record narrowed to the
  // channel's own key, which it can check, and needs no cast.
  function setHandler<C extends InvokeChannel>(channel: C, handler: Handler<C>): void {
    const view: { [K in C]?: Handler<K> } = configured
    view[channel] = handler
  }

  function record<C extends InvokeChannel>(channel: C, params: Params<C>): void {
    calls.push({ channel, params })
    const view: { [K in C]?: Params<K>[] } = callsByChannel
    ;(view[channel] ??= []).push(params)
  }

  function invoke<C extends InvokeChannel>(
    channel: C,
    ...args: PayloadArgs<Params<C>>
  ): Promise<Result<C>> {
    const params = payloadOf<Params<C>>(args)
    record(channel, params)
    invokeSpy(channel, ...args)
    const handler = configured[channel]
    if (!handler) {
      unhandled.push(channel)
      return Promise.reject(new Error(`makeTestApi: no handler for ${channel}`))
    }
    // A handler that throws rejects the invoke, as a throw in main's handler does.
    try {
      return Promise.resolve(handler(params))
    } catch (error) {
      return Promise.reject(error)
    }
  }

  function on<E extends EventChannel>(channel: E, callback: (payload: Payload<E>) => void) {
    const view: { [K in E]?: Set<(payload: Payload<K>) => void> } = listeners
    const subscribed = (view[channel] ??= new Set())
    subscribed.add(callback)
    onSpy(channel, callback)
    return () => {
      subscribed.delete(callback)
    }
  }

  function emit<E extends EventChannel>(channel: E, ...args: PayloadArgs<Payload<E>>): void {
    const payload = payloadOf<Payload<E>>(args)
    // The callbacks subscribed when the event was sent, as Electron's emitter
    // calls them: one that another unsubscribes on the way is still called.
    const subscribed = Array.from(listeners[channel] ?? [])
    for (const callback of subscribed) callback(payload)
  }

  return {
    api: { invoke, on },
    invoke: invokeSpy,
    on: onSpy,
    calls,
    callsTo: (channel) => [...(callsByChannel[channel] ?? [])],
    unhandled,
    handle: setHandler,
    hold(channel) {
      const held: HeldCall<typeof channel>[] = []
      setHandler(
        channel,
        (params) =>
          new Promise((resolve, reject) => {
            held.push({ params, resolve, reject })
          }),
      )
      return held
    },
    emit,
    listenerCount: (channel) => listeners[channel]?.size ?? 0,
  }
}
