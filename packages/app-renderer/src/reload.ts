/**
 * The window asking the engine to reload a block's files, for the frame's
 * "Script changed" notice: what came of the last ask for each block, in a
 * store React reads, and the ask itself. A reload takes effect through the
 * session's events (`DocumentChanged`), which `live.ts` follows.
 */
import { Cause, Effect } from "effect"
import type {
  BlockView,
  DocumentView,
  EngineClient,
  FilesOnDisk,
  ReloadFilesResult,
  SessionId,
} from "@runbooks/core/protocol"
import { clientErrorText, defectText } from "./defect.ts"

type BlockId = BlockView["block"]

/** What came of the last ask to reload a block's files. */
export interface Reloading {
  /** The hash of the files the block showed, which the ask sent. */
  readonly hash: FilesOnDisk["hash"]
  /**
   * The runbook the page drew when the person asked, as `live.ts` read it.
   * The window reads the runbook again for each `DocumentChanged`, so an
   * answer holds only until the page draws the runbook that took the
   * files, or any other (`reloadOver`).
   */
  readonly drawn: DocumentView | undefined
  /**
   * The engine's answer (`ReloadFilesResult`), while it is asked
   * (`Asking`), or why it gave none (`Failed`).
   */
  readonly answer:
    | ReloadFilesResult
    | { readonly _tag: "Asking" }
    | { readonly _tag: "Failed"; readonly line: string }
}

/** What came of the last ask for each block, by id, for React to read (`useSyncExternalStore`). */
export interface ReloadingStore {
  readonly get: () => ReadonlyMap<BlockId, Reloading>
  /** Calls `listener` after each change, until the function it returns is called. */
  readonly subscribe: (listener: () => void) => () => void
}

/** A store that holds nothing until `set` is called. */
export function makeReloadingStore(): ReloadingStore & {
  readonly set: (block: BlockId, reloading: Reloading) => void
} {
  let reloading: ReadonlyMap<BlockId, Reloading> = new Map()
  const listeners = new Set<() => void>()
  return {
    get: () => reloading,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set: (block, next) => {
      reloading = new Map(reloading).set(block, next)
      for (const listener of listeners) listener()
    },
  }
}

/**
 * What came of the last ask to reload a block's files, while it holds: the
 * ask was for the files the block shows now (`onDisk`), from the page drawn
 * now (`drawn`). A hash alone could hold again: two blocks that name one
 * file can each take it in turn, and the file come back to bytes it had.
 */
export const reloadOver = (
  reloading: Reloading | undefined,
  onDisk: FilesOnDisk,
  drawn: DocumentView | undefined,
): Reloading["answer"] | undefined =>
  reloading !== undefined && reloading.hash === onDisk.hash && reloading.drawn === drawn
    ? reloading.answer
    : undefined

/**
 * Asks the engine to reload `block`'s files in `session` at `hash`, the
 * hash of the files the person was shown, and gives its answer. Every
 * failure is a line that says nothing was reloaded.
 */
export const askToReload = (
  engine: EngineClient,
  session: SessionId,
  block: BlockId,
  hash: FilesOnDisk["hash"],
): Effect.Effect<Reloading["answer"]> => {
  const failed = (line: string) => Effect.succeed({ _tag: "Failed", line } as const)
  return engine.ReloadFiles({ session, block, hash }).pipe(
    Effect.catchTags({
      UnknownSession: () => failed("This runbook's session closed, so nothing was reloaded."),
      UnknownBlock: () =>
        failed(
          `The engine has no block ${block} in this runbook's session, so nothing was reloaded.`,
        ),
      Forbidden: () =>
        failed("The engine doesn't take reloads from this window, so nothing was reloaded."),
      RpcClientError: (error) =>
        failed(`The engine did not answer, so nothing was reloaded: ${clientErrorText(error)}`),
    }),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : failed(`The engine failed, so nothing was reloaded: ${defectText(cause)}`),
    ),
  )
}
