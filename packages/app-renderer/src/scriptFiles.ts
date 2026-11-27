/**
 * The window reading the files a block runs as scripts (`GetScriptFiles`)
 * for the frame's source view, "View Source Code", in a store React reads:
 *
 * - It reads a block's script files when a view of the block opens, and again
 *   each time the page draws another runbook (`DocumentChanged`, which
 *   `live.ts` follows) while one is open. It reads nothing for a block with
 *   no view open, and drops what it read once the last one closes.
 * - A read holds only for the runbook whose hash it gives
 *   (`ScriptFiles.document`): one the page does not draw, read before a
 *   reload or after one the page has not drawn yet, is dropped, and the
 *   view shows it is reading until the read for the page drawn comes.
 * - The text is the author's, as the session holds it: what a run runs.
 */
import { Cause, Effect, type Fiber } from "effect"
import type {
  BlockView,
  DocumentView,
  EngineClient,
  ScriptFile,
  SessionId,
} from "@runbooks/core/protocol"
import { clientErrorText, defectText } from "./defect.ts"
import type { LiveStore } from "./live.ts"

type BlockId = BlockView["block"]

/** What a block's open source views show. */
export type ScriptFilesShown =
  | { readonly _tag: "Reading" }
  | { readonly _tag: "Read"; readonly files: ReadonlyArray<ScriptFile> }
  | { readonly _tag: "Failed"; readonly line: string }

/**
 * What came of one read: what it shows, for the runbook whose hash it
 * gives, or why there are none. React reads the same object until it
 * changes.
 */
type Answer =
  | {
      readonly _tag: "Read"
      readonly document: DocumentView["hash"]
      readonly shown: Extract<ScriptFilesShown, { readonly _tag: "Read" }>
    }
  | { readonly _tag: "Failed"; readonly line: string }

const READING: ScriptFilesShown = { _tag: "Reading" }

export interface ScriptFilesStore {
  /** What the open views of `block` show, or nothing while none is open. */
  readonly get: (block: BlockId) => ScriptFilesShown | undefined
  /** Calls `listener` after each change, and after each change to the page drawn, until the function it returns is called. */
  readonly subscribe: (listener: () => void) => () => void
  /** A view of `block` is open until the function it returns is called. */
  readonly open: (block: BlockId) => () => void
}

/** A store no window follows: it reads nothing, and an open view shows it is reading. */
export const NO_SCRIPT_FILES: ScriptFilesStore = {
  get: () => undefined,
  subscribe: () => () => {},
  open: () => () => {},
}

/**
 * The script files of `session`'s blocks, read from `engine` for the page
 * `live` draws. `start` reads again for each runbook the page draws, until
 * the function it returns is called.
 */
export function makeScriptFilesStore(
  engine: EngineClient,
  session: SessionId,
  live: LiveStore,
): ScriptFilesStore & { readonly start: () => () => void } {
  const opens = new Map<BlockId, number>()
  const answers = new Map<BlockId, Answer>()
  const reads = new Map<BlockId, Fiber.Fiber<void>>()
  const listeners = new Set<() => void>()
  const changed = () => {
    for (const listener of listeners) listener()
  }

  const read = (block: BlockId) => {
    reads.get(block)?.interruptUnsafe()
    // Read once the page draws a runbook: `start` reads for the first one.
    if (live.get().document === undefined) return
    reads.set(
      block,
      Effect.runFork(
        Effect.flatMap(readScriptFiles(engine, session, block), (answer) =>
          Effect.sync(() => {
            reads.delete(block)
            answers.set(block, answer)
            changed()
          }),
        ),
      ),
    )
  }

  return {
    get: (block) => {
      if (!opens.has(block)) return undefined
      const answer = answers.get(block)
      if (answer === undefined) return READING
      if (answer._tag === "Failed") return answer
      // A read of a runbook the page does not draw shows nothing.
      return answer.document === live.get().document?.hash ? answer.shown : READING
    },
    subscribe: (listener) => {
      listeners.add(listener)
      const unsubscribe = live.subscribe(listener)
      return () => {
        listeners.delete(listener)
        unsubscribe()
      }
    },
    open: (block) => {
      const before = opens.get(block) ?? 0
      opens.set(block, before + 1)
      if (before === 0) {
        read(block)
        changed()
      }
      let closed = false
      return () => {
        if (closed) return
        closed = true
        const left = (opens.get(block) ?? 1) - 1
        if (left > 0) {
          opens.set(block, left)
          return
        }
        opens.delete(block)
        answers.delete(block)
        reads.get(block)?.interruptUnsafe()
        reads.delete(block)
        changed()
      }
    },
    start: () => {
      let drawn = live.get().document
      const unsubscribe = live.subscribe(() => {
        const now = live.get().document
        if (now === drawn) return
        drawn = now
        for (const block of opens.keys()) read(block)
        changed()
      })
      return () => {
        unsubscribe()
        for (const fiber of reads.values()) fiber.interruptUnsafe()
        reads.clear()
      }
    },
  }
}

/** Reads `block`'s script files in `session`. Every failure is a line that says why there are none. */
const readScriptFiles = (
  engine: EngineClient,
  session: SessionId,
  block: BlockId,
): Effect.Effect<Answer> => {
  const failed = (line: string) => Effect.succeed({ _tag: "Failed", line } as const)
  return engine.GetScriptFiles({ session, block }).pipe(
    Effect.map(({ document, files }): Answer => ({
      _tag: "Read",
      document,
      shown: { _tag: "Read", files },
    })),
    Effect.catchTags({
      UnknownSession: () =>
        failed("This runbook's session closed, so its script files can't be shown."),
      UnknownBlock: () =>
        failed(
          `The engine has no block ${block} in this runbook's session, so it can't show its script files.`,
        ),
      RpcClientError: (error) =>
        failed(
          `The engine did not answer, so the script can't be shown: ${clientErrorText(error)}`,
        ),
    }),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : failed(`The engine failed, so the script can't be shown: ${defectText(cause)}`),
    ),
  )
}
