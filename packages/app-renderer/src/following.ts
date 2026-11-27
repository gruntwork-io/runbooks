/**
 * The session the window follows, as each block's frame reads it: the
 * block's view now (`live.ts`), and a way to ask the engine to act on it.
 * The app provides it (`app.tsx`). With none, as a page rendered on its own,
 * no block has a view and nothing is asked.
 */
import { Cause, Effect } from "effect"
import { createContext, useContext, useSyncExternalStore } from "react"
import type { ViewRequest } from "@runbooks/blocks/views"
import type {
  ActResult,
  BlockView,
  EngineClient,
  Refusal,
  RunResult,
  SessionId,
  SetValuesResult,
} from "@runbooks/core/protocol"
import { clientErrorText, defectText } from "./defect.ts"
import { follow, type LiveStore, makeLiveStore } from "./live.ts"

export interface Following {
  readonly live: LiveStore
  /** Asks the engine for `request` on `block`. It gives what to tell the person about the answer, if anything. */
  readonly act: (
    block: BlockView["block"],
    request: ViewRequest,
  ) => Effect.Effect<string | undefined>
}

export const FollowingContext = createContext<Following>({
  live: makeLiveStore(),
  act: () => Effect.succeed(undefined),
})

/** The view of `block` the engine sent last, if it sent one. */
export function useBlockView(block: string | undefined): BlockView | undefined {
  const { live } = useContext(FollowingContext)
  const select = () => (block === undefined ? undefined : live.get().blocks.get(block))
  return useSyncExternalStore(live.subscribe, select, select)
}

/** Why the window no longer follows the session, when it doesn't. */
export function useEnded(): string | undefined {
  const { live } = useContext(FollowingContext)
  const select = () => live.get().ended
  return useSyncExternalStore(live.subscribe, select, select)
}

/**
 * The window following `session` in `engine`. `start` follows it until the
 * function it returns is called, which a component calls from its effect.
 */
export function followingOf(
  engine: EngineClient,
  session: SessionId,
): Following & { readonly start: () => () => void } {
  const live = makeLiveStore()
  return {
    live,
    act: (block, request) => ask(engine, session, block, request),
    start: () => {
      const fiber = Effect.runFork(follow(engine, session, live.set))
      return () => fiber.interruptUnsafe()
    },
  }
}

type BlockId = BlockView["block"]

/** Sends `request` for `block`, and gives what to tell the person about the answer. */
const ask = (
  engine: EngineClient,
  session: SessionId,
  block: BlockId,
  request: ViewRequest,
): Effect.Effect<string | undefined> => {
  const asked = (() => {
    switch (request._tag) {
      case "RunBlock":
        return Effect.map(engine.RunBlock({ session, block }), ran)
      case "CancelBlock":
        return Effect.map(engine.CancelBlock({ session, block }), (answer) =>
          answer === "notRunning" ? "It wasn't running, so nothing was cancelled." : undefined,
        )
      case "ResetBlock":
        return Effect.as(engine.ResetBlock({ session, block }), undefined)
      case "SetValues":
        return Effect.map(engine.SetValues({ session, block, values: request.values }), entered)
      case "ActOnCredential":
        return Effect.map(engine.ActOnCredential({ session, block, action: request.action }), acted)
      default: {
        const unhandled: never = request
        throw new Error(`The window can't ask the engine for ${JSON.stringify(unhandled)}.`)
      }
    }
  })()
  return asked.pipe(
    Effect.catchTags({
      UnknownSession: () => Effect.succeed("This runbook's session closed."),
      UnknownBlock: () =>
        Effect.succeed(`The engine has no block ${block} in this runbook's session.`),
      WrongClass: (error) =>
        Effect.succeed(`The engine doesn't take that for a ${error.class} block.`),
      RpcClientError: (error) =>
        Effect.succeed(`The engine did not answer: ${clientErrorText(error)}`),
    }),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.succeed(`The engine failed: ${defectText(cause)}`),
    ),
  )
}

/** What a run's answer says, when the run did not start. */
function ran(result: RunResult): string | undefined {
  switch (result._tag) {
    case "Started":
    case "Submitted":
      return undefined
    case "AwaitingApproval":
      return "It runs once you approve it."
    case "Refused":
      return refused(result.reason)
    default: {
      const unhandled: never = result
      throw new Error(`The window has no words for ${JSON.stringify(unhandled)}.`)
    }
  }
}

function refused(reason: Refusal): string {
  switch (reason._tag) {
    case "Blocked":
      return "It didn't run: it is waiting, as it says above."
    case "NeedsInput":
      return `It didn't run: it needs ${reason.fields.join(", ")}.`
    case "NeedsReview":
      return `It didn't run: ${reason.unreviewed.join(", ")} in ${reason.form} are not reviewed.`
    case "AlreadyRunning":
      return "It is already running."
    case "Misconfigured":
      return "Its configuration has errors, so it doesn't run."
    default: {
      const unhandled: never = reason
      throw new Error(`The window has no words for ${JSON.stringify(unhandled)}.`)
    }
  }
}

/** What entering values says: each value not entered, and each field's error. */
function entered(result: SetValuesResult): string | undefined {
  const problems = [...Object.entries(result.rejected), ...Object.entries(result.errors)]
  return problems.length === 0
    ? undefined
    : problems.map(([field, problem]) => `${field}: ${problem}`).join(" ")
}

/** What a credential action's answer says, when it was not taken. */
function acted(result: ActResult): string | undefined {
  switch (result._tag) {
    case "Accepted":
      return undefined
    case "AwaitingApproval":
      return "It goes ahead once you approve it."
    case "NotAllowed":
      return `It can't do that while it is ${result.state}.`
    case "NotOffered":
      return `It doesn't offer ${result.value ?? "no choice"} for its ${result.field}. It offers: ${result.offered.join(", ")}.`
    default: {
      const unhandled: never = result
      throw new Error(`The window has no words for ${JSON.stringify(unhandled)}.`)
    }
  }
}
