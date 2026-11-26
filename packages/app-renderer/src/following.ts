/**
 * The session the window follows, as each block's frame reads it: the
 * block's view now (`live.ts`), and a way to ask the engine to act on it.
 * The app provides it (`app.tsx`). With none, as a page rendered on its own,
 * no block has a view and nothing is asked.
 */
import { Effect } from "effect"
import { createContext, useContext, useSyncExternalStore } from "react"
import type { ViewRequest } from "@runbooks/blocks/views"
import type { BlockView, EngineClient, SessionId } from "@runbooks/core/protocol"
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
    act: () => Effect.succeed(undefined),
    start: () => {
      const fiber = Effect.runFork(follow(engine, session, live.set))
      return () => fiber.interruptUnsafe()
    },
  }
}
