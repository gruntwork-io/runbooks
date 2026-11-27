/**
 * A main for the window's tests, at the bridge: it answers each command the
 * engine client sends, and sends chunks down the streams the client opened,
 * as JSON, the way main's server end does. Every answer and chunk arrives on
 * a later turn.
 */
import type { EngineBridge } from "./engine.ts"

/** A command the client sent, as main reads it. */
export interface Asked {
  readonly tag: string
  readonly payload: unknown
}

const FAILURE: unique symbol = Symbol("failure")

/** A cause as main encodes it: a failure with a typed error, or a defect. */
type EncodedCause = ReadonlyArray<
  | { readonly _tag: "Fail"; readonly error: unknown }
  | { readonly _tag: "Die"; readonly defect: unknown }
>

const failing = (cause: EncodedCause) => ({ [FAILURE]: cause })

/** An answer that fails its command with `error`, encoded. */
export const fails = (error: unknown) => failing([{ _tag: "Fail", error }])

/** An answer that fails its command with a defect, as main sends one: `{ name, message }`. */
export const dies = (defect: { readonly name: string; readonly message: string }) =>
  failing([{ _tag: "Die", defect }])

const failureOf = (value: unknown): { readonly cause: unknown } | undefined =>
  typeof value === "object" && value !== null && FAILURE in value
    ? { cause: value[FAILURE] }
    : undefined

/** What a stream command opened: its request, to send chunks down. */
interface Opened {
  readonly tag: string
  readonly requestId: string
}

export interface FakeMain {
  readonly bridge: EngineBridge
  /** Every command the client sent, in order. */
  readonly asked: ReadonlyArray<Asked>
  /** Sends `values`, encoded, as one chunk down each open stream of `tag`. */
  readonly stream: (tag: string, values: ReadonlyArray<unknown>) => void
  /** Ends each open stream of `tag`: done, or failed with `failure` (`fails`, `dies`). */
  readonly end: (tag: string, failure?: unknown) => void
}

/**
 * A main whose `answer` gives each command's encoded success value, or
 * `fails(error)`. A command in `streams` is answered with chunks
 * (`stream`), and one `answer` gives `undefined` for is not answered.
 */
export function fakeMain(
  answer: (tag: string, payload: unknown) => unknown,
  streams: ReadonlySet<string> = new Set(["Events", "WatchSettings"]),
): FakeMain {
  const listeners = new Set<(message: string) => void>()
  const asked: Asked[] = []
  const opened: Opened[] = []
  const reply = (message: unknown) => {
    const text = JSON.stringify(message)
    setTimeout(() => {
      for (const listener of listeners) listener(text)
    }, 0)
  }
  return {
    asked,
    bridge: {
      send: (text) => {
        const sent: { _tag: string; id?: string; tag?: string; payload?: unknown } =
          JSON.parse(text)
        if (sent._tag !== "Request" || sent.id === undefined || sent.tag === undefined) return
        asked.push({ tag: sent.tag, payload: sent.payload })
        if (streams.has(sent.tag)) {
          opened.push({ tag: sent.tag, requestId: sent.id })
          return
        }
        const value = answer(sent.tag, sent.payload)
        if (value === undefined) return
        const failure = failureOf(value)
        reply({
          _tag: "Exit",
          requestId: sent.id,
          exit:
            failure === undefined
              ? { _tag: "Success", value }
              : { _tag: "Failure", cause: failure.cause },
        })
      },
      onMessage: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    stream: (tag, values) => {
      for (const open of opened)
        if (open.tag === tag) reply({ _tag: "Chunk", requestId: open.requestId, values })
    },
    end: (tag, failure) => {
      const failed = failureOf(failure)
      for (const open of opened)
        if (open.tag === tag)
          reply({
            _tag: "Exit",
            requestId: open.requestId,
            exit:
              failed === undefined
                ? { _tag: "Success", value: null }
                : { _tag: "Failure", cause: failed.cause },
          })
    },
  }
}
