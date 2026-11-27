/**
 * The window asking the engine to trust the session it follows, for the
 * trust prompt: what came of the last ask, in a store React reads, and the
 * ask itself. Trust takes effect through the session's events
 * (`TrustChanged`, then each block's status), which `live.ts` follows.
 */
import { Cause, Effect } from "effect"
import type {
  DocumentView,
  EngineClient,
  SessionId,
  TrustResult,
  TrustState,
} from "@runbooks/core/protocol"
import { clientErrorText, defectText } from "./defect.ts"

/** What came of the last ask. Empty before the first, and after one that trusted the session. */
export interface Trusting {
  /**
   * The runbook changed since the window showed it, so nothing was
   * trusted: what it holds now, which the prompt shows in place of the
   * page's, and the hash the next ask sends.
   */
  readonly changed?: {
    readonly hash: TrustState["hash"]
    readonly blocks: DocumentView["blocks"]
  }
  /** Why nothing was trusted, when the ask failed. */
  readonly failed?: string
}

/** What came of the last ask, for React to read (`useSyncExternalStore`). */
export interface TrustingStore {
  readonly get: () => Trusting
  /** Calls `listener` after each change, until the function it returns is called. */
  readonly subscribe: (listener: () => void) => () => void
}

/** A store that holds nothing until `set` is called. */
export function makeTrustingStore(): TrustingStore & {
  readonly set: (trusting: Trusting) => void
} {
  let trusting: Trusting = {}
  const listeners = new Set<() => void>()
  return {
    get: () => trusting,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set: (next) => {
      trusting = next
      for (const listener of listeners) listener()
    },
  }
}

/** What the window keeps of `result`, reading what the runbook holds now when it changed. */
const answered = (engine: EngineClient, session: SessionId, result: TrustResult) => {
  switch (result._tag) {
    // The prompt goes once the session's events say it is trusted.
    case "Trusted":
      return Effect.succeed<Trusting>({})
    case "HashChanged":
      return Effect.map(engine.GetDocument({ session }), ({ blocks }): Trusting => ({
        changed: { hash: result.current, blocks },
      }))
    default: {
      const unhandled: never = result
      throw new Error(`The window has no reading for ${JSON.stringify(unhandled)}.`)
    }
  }
}

/**
 * Asks the engine to trust `session` for `hash`, the one the person was
 * shown, and gives what the window keeps of the answer, `before` being
 * what it kept of the last. Every failure, the read after a change
 * included, is a line that says nothing was trusted, and keeps what the
 * runbook was last said to hold, so the prompt still shows it.
 */
export const askToTrust = (
  engine: EngineClient,
  session: SessionId,
  hash: TrustState["hash"],
  before: Trusting,
): Effect.Effect<Trusting> => {
  const failed = (line: string) => Effect.succeed<Trusting>({ ...before, failed: line })
  return engine.TrustSession({ session, hash }).pipe(
    Effect.flatMap((result) => answered(engine, session, result)),
    Effect.catchTags({
      UnknownSession: () => failed("This runbook's session closed, so nothing was trusted."),
      Forbidden: () =>
        failed("The engine doesn't take trust from this window, so nothing was trusted."),
      RpcClientError: (error) =>
        failed(`The engine did not answer, so nothing was trusted: ${clientErrorText(error)}`),
    }),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : failed(`The engine failed, so nothing was trusted: ${defectText(cause)}`),
    ),
  )
}
