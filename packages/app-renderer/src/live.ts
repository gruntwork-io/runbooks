/**
 * The window following one session: its runbook, and each block with a
 * lifecycle, as the engine has them now, kept current from the session's
 * `Events`.
 *
 * - `GetSession` gives the start: the blocks to read, and the event its
 *   view reflects last (`sequence`). `Events` starts after it, so the
 *   window misses no change and reads none twice.
 * - Each batch of events says which blocks changed, and the window reads
 *   each of them again with `GetBlock` before it shows the batch: their
 *   status, actions, log and instruction come from that read, never from
 *   the event.
 * - A block's instruction is built from the values and outputs it reads,
 *   and the window shows it only in instruction mode, as the settings give
 *   it (`Settings.instructionMode`). In the mode, an event that changes a
 *   value or an output reads every block that has an instruction again.
 *   Out of it, the event reads only the blocks it names. When the mode
 *   turns on, the window reads every block that has an instruction again,
 *   then shows the mode (`instructionMode`). Turning it off reads nothing.
 * - A block's log is its latest run's last page: a log longer than one
 *   page is read again from `total - defaultLogLimit`.
 * - Why the session holds back a reload is its view's `reloadHeld`, then
 *   each `ReloadHeldChanged`'s, which clears it when it has no `held`.
 *   That the session stopped watching is its view's `unwatched`, or the
 *   `Unwatched` event's, and nothing clears it.
 * - The session's trust is its view's, then each `TrustChanged`'s. Each
 *   block whose status trust changes has a `BlockStatusChanged` of its own,
 *   which reads it again.
 * - The runbook is the one the window opened with until `DocumentChanged`
 *   says the session reloaded it. The window then reads it again
 *   (`GetDocument`), and every block with a lifecycle the session has now
 *   (`GetSession`), in place of the ones it had: a block the runbook no
 *   longer has goes, and every other block is read again, since a block
 *   that starts over may keep its status. At the start, a session whose
 *   hash is not the opened runbook's reloaded it between the two reads,
 *   which logs no event after its view, so the window reads it again then
 *   too.
 * - A block the engine no longer has when the window reads it went with a
 *   reload after the event that named it, so the window drops it: the
 *   reload's `DocumentChanged` follows.
 * - When the session closes, its events end, or the engine fails a read or
 *   can't be reached, the window says so (`ended`) and stops following.
 *
 * Reads run in turn, a few at a time, and the next batch, or change of the
 * mode, waits for them. The window's queue of events holds `EVENTS_AHEAD`,
 * and while it is full the client stops acking, so events that main sends
 * faster than the window reads wait in main, not in the window's memory.
 */
import { Cause, Effect, Queue, Stream } from "effect"
import {
  type BlockView,
  type DocumentView,
  type EngineClient,
  type EngineEvent,
  LIMITS,
  type ReloadHeld,
  type SessionId,
  type SessionView,
  type TrustState,
  type Unwatched,
} from "@runbooks/core/protocol"
import { clientErrorText, defectText } from "./defect.ts"
import { instructionModeOf, type SettingsStore } from "./settings.ts"

type BlockId = BlockView["block"]

/** A session as the window shows it. */
export interface Live {
  /** Each block with a lifecycle, by id, as the engine had it after the last batch. */
  readonly blocks: ReadonlyMap<string, BlockView>
  /**
   * The session's runbook, which the page draws: the one the window opened
   * with, until the session reloads it. Absent in a store no follower
   * publishes to.
   */
  readonly document?: DocumentView
  /**
   * Whether the window shows instructions: the instruction mode it has read
   * each block's instruction for. Absent in a store no follower publishes to.
   */
  readonly instructionMode?: boolean
  /** The session's trust, as the engine had it after the last batch. Absent until the session is read. */
  readonly trust?: TrustState
  /** Why the session holds back a reload of its runbook, while it does. */
  readonly reloadHeld?: ReloadHeld
  /** Why the session watches nothing, once it stopped. */
  readonly unwatched?: Unwatched
  /** Why the window no longer follows the session, when it doesn't. */
  readonly ended?: string
}

/** What one batch of events says to read again. */
interface Stale {
  readonly blocks: Set<BlockId>
  /** A value or an output changed, so every block's instruction may have. */
  readers: boolean
  /** The instruction mode the batch's last change of it gives, if one does. */
  instructionMode: boolean | undefined
  /** The trust the batch's last `TrustChanged` gives, if one does. */
  trust: TrustState | undefined
  /** The session reloaded its runbook, so every block may have changed. */
  document: boolean
  /** What the batch's last `ReloadHeldChanged` gives, if one does: `now` absent clears it. */
  held: { readonly now: ReloadHeld | undefined } | undefined
  /** What the batch's `Unwatched` gives, if one does. */
  unwatched: Unwatched | undefined
  closed: boolean
}

const READS_AT_ONCE = 4

/** The events the window's queue holds: enough for a round of reads to gather a burst, such as a command's log lines. */
export const EVENTS_AHEAD = 256

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
    case "DocumentChanged":
      stale.document = true
      return
    case "ReloadHeldChanged":
      stale.held = { now: event.held }
      return
    case "Unwatched":
      stale.unwatched = { message: event.message }
      return
    // The session's warnings are not drawn yet.
    case "Warning":
      return
    default: {
      const unhandled: never = event
      throw new Error(`The window has no reading for ${JSON.stringify(unhandled)}.`)
    }
  }
}

/** The blocks in `view` that have a lifecycle, which the window follows. */
const withLifecycle = (view: SessionView): ReadonlyArray<BlockId> =>
  view.blocks.flatMap((block) => (block.status === undefined ? [] : [block.block]))

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

type Events = ReturnType<EngineClient["Events"]>

/** What the window follows, in turn: each event, and each change of the instruction mode. */
type Change = Stream.Success<Events> | boolean

/**
 * Offers to `modes` the instruction mode each time `settings` change it
 * from `shown`, the mode the window shows, until the scope closes: first
 * the mode now, if they changed it before.
 */
const offerInstructionModes = (
  settings: SettingsStore,
  shown: boolean,
  modes: Queue.Queue<boolean>,
) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      let last = shown
      const offer = () => {
        const now = instructionModeOf(settings)
        if (now === last) return
        last = now
        Queue.offerUnsafe(modes, now)
      }
      offer()
      return settings.subscribe(offer)
    }),
    (unsubscribe) => Effect.sync(unsubscribe),
  )

/**
 * Follows `session`, whose runbook the window opened as `opened`, in the
 * instruction mode `settings` give, calling `publish` with what to show at
 * the start and after each batch of events or change of the mode.
 */
export const follow = (
  engine: EngineClient,
  session: SessionId,
  opened: DocumentView,
  settings: SettingsStore,
  publish: (live: Live) => void,
): Effect.Effect<void> => {
  const blocks = new Map<string, BlockView>()
  const read = (ids: Iterable<BlockId>) =>
    Effect.forEach(
      ids,
      (block) =>
        readBlock(engine, session, block).pipe(
          Effect.map((view) => blocks.set(block, view)),
          Effect.catchTag("UnknownBlock", () => Effect.sync(() => blocks.delete(block))),
        ),
      { concurrency: READS_AT_ONCE, discard: true },
    )
  const approvalFor = (approval: string) =>
    [...blocks.values()].find((view) => view.approval?.approval === approval)?.block
  let instructionMode = false
  let trust: TrustState | undefined
  let document = opened
  let held: ReloadHeld | undefined
  let unwatched: Unwatched | undefined
  const show = (ended?: string) =>
    publish({
      blocks: new Map(blocks),
      document,
      instructionMode,
      ...(trust === undefined ? {} : { trust }),
      ...(held === undefined ? {} : { reloadHeld: held }),
      ...(unwatched === undefined ? {} : { unwatched }),
      ...(ended === undefined ? {} : { ended }),
    })
  return Effect.gen(function* () {
    instructionMode = instructionModeOf(settings)
    const view = yield* engine.GetSession({ session })
    trust = view.trust
    held = view.reloadHeld
    unwatched = view.unwatched
    if (view.trust.hash !== document.hash) document = yield* engine.GetDocument({ session })
    yield* read(withLifecycle(view))
    const events = yield* Queue.bounded<Stream.Success<Events>, Stream.Error<Events> | Cause.Done>(
      EVENTS_AHEAD,
    )
    // Started at once, so the window follows the events by the time it shows the session.
    yield* Effect.forkScoped(
      Stream.runIntoQueue(
        engine.Events({
          session,
          ...(view.sequence === undefined ? {} : { after: view.sequence }),
        }),
        events,
      ),
      { startImmediately: true },
    )
    // Only the latest mode matters, and the settings' listener never waits.
    const modes = yield* Queue.sliding<boolean>(1)
    yield* offerInstructionModes(settings, instructionMode, modes)
    show()
    let closed = false
    const changes: Stream.Stream<Change, Stream.Error<Events>> = Stream.merge(
      Stream.fromQueue(events),
      Stream.fromQueue(modes),
      // The modes never end; the session's events do.
      { haltStrategy: "left" },
    )
    yield* Stream.runForEachArray(changes, (batch) =>
      Effect.gen(function* () {
        const stale: Stale = {
          blocks: new Set(),
          readers: false,
          instructionMode: undefined,
          trust: undefined,
          document: false,
          held: undefined,
          unwatched: undefined,
          closed: false,
        }
        for (const change of batch)
          if (typeof change === "boolean") stale.instructionMode = change
          else mark(change.event, stale, approvalFor)
        const mode = stale.instructionMode ?? instructionMode
        if (stale.document) {
          const now = yield* engine.GetSession({ session })
          document = yield* engine.GetDocument({ session })
          blocks.clear()
          yield* read(withLifecycle(now))
        } else {
          // Out of the mode no instruction shows. One the window holds may be stale when the mode turns on.
          if (mode && (stale.readers || !instructionMode))
            for (const [, known] of blocks)
              if (known.instruction !== undefined) stale.blocks.add(known.block)
          yield* read(stale.blocks)
        }
        instructionMode = mode
        trust = stale.trust ?? trust
        if (stale.held !== undefined) held = stale.held.now
        unwatched = stale.unwatched ?? unwatched
        closed ||= stale.closed
        show(closed ? CLOSED : undefined)
      }),
    )
    if (!closed) show(CLOSED)
  }).pipe(
    Effect.scoped,
    Effect.catchTags({
      UnknownSession: () => Effect.sync(() => show(CLOSED)),
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
