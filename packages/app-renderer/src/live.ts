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
 * - When the session closes, or the engine fails a read, the window says
 *   so (`ended`) and stops following.
 *
 * Reads run in turn, a few at a time, and the next batch waits for them.
 */
import { Effect, Stream } from "effect"
import {
  type BlockView,
  type EngineClient,
  type EngineEvent,
  LIMITS,
  type SessionId,
} from "@runbooks/core/protocol"

type BlockId = BlockView["block"]

/** A session as the window shows it. */
export interface Live {
  /** Each block with a lifecycle, by id, as the engine had it after the last batch. */
  readonly blocks: ReadonlyMap<string, BlockView>
  /** Why the window no longer follows the session, when it doesn't. */
  readonly ended?: string
}

/** What one batch of events says to read again. */
interface Stale {
  readonly blocks: Set<BlockId>
  /** A value or an output changed, so every block's instruction may have. */
  readers: boolean
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
    // Each block whose status trust changes has a `BlockStatusChanged` of its own.
    case "TrustChanged":
    // The session's warnings are not drawn yet.
    case "Warning":
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
  return Effect.gen(function* () {
    const view = yield* engine.GetSession({ session })
    yield* read(view.blocks.flatMap((block) => (block.status === undefined ? [] : [block.block])))
    publish({ blocks: new Map(blocks) })
    let closed = false
    yield* Stream.runForEachArray(
      engine.Events({ session, ...(view.sequence === undefined ? {} : { after: view.sequence }) }),
      (batch) =>
        Effect.gen(function* () {
          const stale: Stale = { blocks: new Set(), readers: false, closed: false }
          for (const { event } of batch) mark(event, stale, approvalFor)
          if (stale.readers)
            for (const [, known] of blocks)
              if (known.instruction !== undefined) stale.blocks.add(known.block)
          yield* read(stale.blocks)
          closed = stale.closed
          publish({ blocks: new Map(blocks), ...(closed ? { ended: CLOSED } : {}) })
        }),
    )
    if (!closed) publish({ blocks: new Map(blocks), ended: CLOSED })
  }).pipe(
    Effect.catchTags({
      UnknownSession: () => Effect.sync(() => publish({ blocks: new Map(blocks), ended: CLOSED })),
      UnknownBlock: (error) =>
        Effect.sync(() =>
          publish({
            blocks: new Map(blocks),
            ended: `The engine has no block ${error.block} in this runbook's session, so the window stopped following it.`,
          }),
        ),
      UnknownSequence: (error) =>
        Effect.sync(() =>
          publish({
            blocks: new Map(blocks),
            ended: `The engine has logged no event ${error.after} in this runbook's session, so the window stopped following it.`,
          }),
        ),
      RpcClientError: (error) =>
        Effect.sync(() =>
          publish({
            blocks: new Map(blocks),
            ended: `The engine did not answer, so the window stopped following this runbook: ${error.message}`,
          }),
        ),
    }),
  )
}
