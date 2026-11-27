/**
 * The window following one session: each block with a lifecycle as the
 * engine has it now, kept current from the session's `Events`.
 *
 * - `GetSession` gives the start: the blocks to read, and the event its
 *   view reflects last (`sequence`). `Events` starts after it, so the
 *   window misses no change and reads none twice.
 * - Each batch of events says which blocks changed, and the window reads
 *   each of them again with `GetBlock` before it shows the batch: their
 *   status, actions, log and instruction come from that read, never from
 *   the event.
 * - A block's instruction is built from the values and outputs it reads, so
 *   an event that changes a value or an output reads every block that has
 *   an instruction again.
 * - A block's log is its latest run's last page: a log longer than one
 *   page is read again from `total - defaultLogLimit`.
 * - The session's trust is its view's, then each `TrustChanged`'s. Each
 *   block whose status trust changes has a `BlockStatusChanged` of its own,
 *   which reads it again.
 * - When the session closes, its events end, or the engine fails a read or
 *   can't be reached, the window says so (`ended`) and stops following.
 *
 * Reads run in turn, a few at a time, and the next batch waits for them.
 */
import { Cause, Effect, Stream } from "effect"
import {
  type BlockView,
  type EngineClient,
  type EngineEvent,
  LIMITS,
  type SessionId,
  type TrustState,
} from "@runbooks/core/protocol"
import { clientErrorText, defectText } from "./defect.ts"

type BlockId = BlockView["block"]

/** A session as the window shows it. */
export interface Live {
  /** Each block with a lifecycle, by id, as the engine had it after the last batch. */
  readonly blocks: ReadonlyMap<string, BlockView>
  /** The session's trust, as the engine had it after the last batch. Absent until the session is read. */
  readonly trust?: TrustState
  /** Why the window no longer follows the session, when it doesn't. */
  readonly ended?: string
}

/** What one batch of events says to read again. */
interface Stale {
  readonly blocks: Set<BlockId>
  /** A value or an output changed, so every block's instruction may have. */
  readers: boolean
  /** The trust the batch's last `TrustChanged` gives, if one does. */
  trust: TrustState | undefined
  closed: boolean
}

const READS_AT_ONCE = 4

const CLOSED = "This runbook's session closed, so the window shows it as it was left."

/** Marks what `event` changed in `stale`. `approvals` finds the block an approval is for. */
function mark(
  event: EngineEvent,
  stale: Stale,
  approvals: (approval: string) => BlockId | undefined,
) {
  switch (event._tag) {
    case "BlockStatusChanged":
    case "LogLines":
    case "FilesChanged":
    case "FilesOnDiskChanged":
    case "CredentialChanged":
      stale.blocks.add(event.block)
      return
    case "OutputsPublished":
    case "OutputsWithdrawn":
    case "FieldsChanged":
      stale.blocks.add(event.block)
      stale.readers = true
      return
    case "ApprovalRequested":
      stale.blocks.add(event.approval.block)
      return
    case "ApprovalResolved": {
      const block = approvals(event.approval)
      if (block !== undefined) stale.blocks.add(block)
      return
    }
    case "SessionClosed":
      stale.closed = true
      return
    case "TrustChanged":
      stale.trust = event.trust
      return
    // The session's warnings are not drawn yet, nor is a reload or one held back.
    case "Warning":
    case "DocumentChanged":
    case "ReloadHeldChanged":
      return
    default: {
      const unhandled: never = event
      throw new Error(`The window has no reading for ${JSON.stringify(unhandled)}.`)
    }
  }
}

/** A block's view, with its latest run's last page of log. */
const readBlock = (engine: EngineClient, session: SessionId, block: BlockId) =>
  Effect.gen(function* () {
    const view = yield* engine.GetBlock({ session, block })
    const log = view.log
    if (log === undefined || log.total <= log.lines.length) return view
    return yield* engine.GetBlock({
      session,
      block,
      logOffset: log.total - LIMITS.defaultLogLimit,
    })
  })

/** Follows `session`, calling `publish` with what to show at the start and after each batch of events. */
export const follow = (
  engine: EngineClient,
  session: SessionId,
  publish: (live: Live) => void,
): Effect.Effect<void> => {
  const blocks = new Map<string, BlockView>()
  const read = (ids: Iterable<BlockId>) =>
    Effect.forEach(
      ids,
      (block) => Effect.map(readBlock(engine, session, block), (view) => blocks.set(block, view)),
      { concurrency: READS_AT_ONCE, discard: true },
    )
  const approvalFor = (approval: string) =>
    [...blocks.values()].find((view) => view.approval?.approval === approval)?.block
  let trust: TrustState | undefined
  const show = (ended?: string) =>
    publish({
      blocks: new Map(blocks),
      ...(trust === undefined ? {} : { trust }),
      ...(ended === undefined ? {} : { ended }),
    })
  return Effect.gen(function* () {
    const view = yield* engine.GetSession({ session })
    trust = view.trust
    yield* read(view.blocks.flatMap((block) => (block.status === undefined ? [] : [block.block])))
    show()
    let closed = false
    yield* Stream.runForEachArray(
      engine.Events({ session, ...(view.sequence === undefined ? {} : { after: view.sequence }) }),
      (batch) =>
        Effect.gen(function* () {
          const stale: Stale = {
            blocks: new Set(),
            readers: false,
            trust: undefined,
            closed: false,
          }
          for (const { event } of batch) mark(event, stale, approvalFor)
          if (stale.readers)
            for (const [, known] of blocks)
              if (known.instruction !== undefined) stale.blocks.add(known.block)
          yield* read(stale.blocks)
          trust = stale.trust ?? trust
          closed = stale.closed
          show(closed ? CLOSED : undefined)
        }),
    )
    if (!closed) show(CLOSED)
  }).pipe(
    Effect.catchTags({
      UnknownSession: () => Effect.sync(() => show(CLOSED)),
      UnknownBlock: (error) =>
        Effect.sync(() =>
          show(
            `The engine has no block ${error.block} in this runbook's session, so the window stopped following it.`,
          ),
        ),
      UnknownSequence: (error) =>
        Effect.sync(() =>
          show(
            `The engine has logged no event ${error.after} in this runbook's session, so the window stopped following it.`,
          ),
        ),
      RpcClientError: (error) =>
        Effect.sync(() =>
          show(
            `The engine did not answer, so the window stopped following this runbook: ${clientErrorText(error)}`,
          ),
        ),
    }),
    // A defect, as a block's instruction throwing makes in every read. Unmounting interrupts.
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.sync(() =>
            show(
              `The engine failed, so the window stopped following this runbook: ${defectText(cause)}`,
            ),
          ),
    ),
  )
}

/** What the window shows of the session now, for React to read (`useSyncExternalStore`). */
export interface LiveStore {
  readonly get: () => Live
  /** Calls `listener` after each change, until the function it returns is called. */
  readonly subscribe: (listener: () => void) => () => void
}

/** A store that shows no block until `set` is called, as `follow`'s `publish`. */
export function makeLiveStore(): LiveStore & { readonly set: (live: Live) => void } {
  let live: Live = { blocks: new Map() }
  const listeners = new Set<() => void>()
  return {
    get: () => live,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set: (next) => {
      live = next
      for (const listener of listeners) listener()
    },
  }
}
