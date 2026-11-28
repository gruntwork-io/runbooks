/**
 * The session the window follows, as each block's frame and the trust
 * prompt read it: the block's view and the session's trust now
 * (`live.ts`), the settings now (`settings.ts`), what came of asking to
 * trust the session (`trust.ts`) or to reload a block's files
 * (`reload.ts`), the script files of each block whose source view is open
 * (`scriptFiles.ts`), and a way to ask the engine to act on a block, trust the
 * session, or reload a block's files. The app provides it (`app.tsx`).
 * With none, as a page rendered on its own, no block has a view, no trust
 * or setting is read, and nothing is asked.
 */
import { Cause, Effect, Semaphore } from "effect"
import { createContext, useContext, useSyncExternalStore } from "react"
import type { ViewRequest } from "@runbooks/blocks/views"
import type {
  ActResult,
  BlockView,
  DocumentView,
  EngineClient,
  Refusal,
  ReloadHeld,
  RunResult,
  SessionId,
  Settings,
  SetValuesResult,
  TrustState,
  Unwatched,
} from "@runbooks/core/protocol"
import { clientErrorText, defectText } from "./defect.ts"
import { follow, type LiveStore, makeLiveStore } from "./live.ts"
import { askToReload, makeReloadingStore, type Reloading, type ReloadingStore } from "./reload.ts"
import {
  makeScriptFilesStore,
  NO_SCRIPT_FILES,
  type ScriptFilesShown,
  type ScriptFilesStore,
} from "./scriptFiles.ts"
import {
  followSettings,
  instructionModeOf,
  makeSettingsStore,
  type SettingsStore,
} from "./settings.ts"
import {
  askToTrust,
  changeOver,
  makeTrustingStore,
  type Trusting,
  type TrustingStore,
} from "./trust.ts"

export interface Following {
  readonly live: LiveStore
  readonly settings: SettingsStore
  /** What came of the last ask to trust the session. */
  readonly trusting: TrustingStore
  /** What came of the last ask to reload each block's files. */
  readonly reloading: ReloadingStore
  /** The script files of each block whose source view is open, which a view opens. */
  readonly scriptFiles: ScriptFilesStore
  /**
   * Asks the engine for `request` on `block`. It gives what to tell the
   * person about the answer, if anything. Requests go one at a time, in the
   * order asked, each once the engine answered the one before: a Submit
   * goes after the values typed before it, and values in the order typed.
   */
  readonly act: (
    block: BlockView["block"],
    request: ViewRequest,
  ) => Effect.Effect<string | undefined>
  /**
   * Asks the engine to trust the session for the hash of what the prompt
   * shows: the runbook the page draws (`DocumentView.hash`), or what the
   * engine said the runbook holds now, after it said it changed since the
   * page drew it (`changeOver`). It keeps what came of it in `trusting`.
   * Nothing is asked before the session is read.
   */
  readonly trust: () => Effect.Effect<void>
  /**
   * Asks the engine, as the person, to reload `block`'s files at `hash`,
   * the hash of the files its notice shows (`FilesOnDisk.hash`). It keeps
   * what came of it in `reloading`, for the files at `hash` on the page
   * drawn now, and keeps that it is asking until the engine answers.
   */
  readonly reload: (block: BlockView["block"], hash: Reloading["hash"]) => Effect.Effect<void>
}

export const FollowingContext = createContext<Following>({
  live: makeLiveStore(),
  settings: makeSettingsStore(undefined),
  trusting: makeTrustingStore(),
  reloading: makeReloadingStore(),
  scriptFiles: NO_SCRIPT_FILES,
  act: () => Effect.succeed(undefined),
  trust: () => Effect.void,
  reload: () => Effect.void,
})

/** The view of `block` the engine sent last, if it sent one. */
export function useBlockView(block: string | undefined): BlockView | undefined {
  const { live } = useContext(FollowingContext)
  const select = () => (block === undefined ? undefined : live.get().blocks.get(block))
  return useSyncExternalStore(live.subscribe, select, select)
}

/**
 * Whether the window shows instructions in place of running blocks: as
 * the settings give it until the window has read the session, then the
 * mode the window has read each instruction for (`Live.instructionMode`).
 * Off until the settings are read.
 */
export function useInstructionMode(): boolean {
  const { live, settings } = useContext(FollowingContext)
  const selectRead = () => live.get().instructionMode
  const read = useSyncExternalStore(live.subscribe, selectRead, selectRead)
  const selectSetting = () => instructionModeOf(settings)
  const setting = useSyncExternalStore(settings.subscribe, selectSetting, selectSetting)
  return read ?? setting
}

/** The session's runbook as the engine holds it, once the window has read the session. */
export function useDocument(): DocumentView | undefined {
  const { live } = useContext(FollowingContext)
  const select = () => live.get().document
  return useSyncExternalStore(live.subscribe, select, select)
}

/** Why the session holds back a reload of its runbook, while it does. */
export function useReloadHeld(): ReloadHeld | undefined {
  const { live } = useContext(FollowingContext)
  const select = () => live.get().reloadHeld
  return useSyncExternalStore(live.subscribe, select, select)
}

/** Why the session watches nothing, once it stopped. */
export function useUnwatched(): Unwatched | undefined {
  const { live } = useContext(FollowingContext)
  const select = () => live.get().unwatched
  return useSyncExternalStore(live.subscribe, select, select)
}

/** Why the window no longer follows the session, when it doesn't. */
export function useEnded(): string | undefined {
  const { live } = useContext(FollowingContext)
  const select = () => live.get().ended
  return useSyncExternalStore(live.subscribe, select, select)
}

/** The session's trust, once the window has read it. */
export function useTrust(): TrustState | undefined {
  const { live } = useContext(FollowingContext)
  const select = () => live.get().trust
  return useSyncExternalStore(live.subscribe, select, select)
}

/** What came of the last ask to trust the session. */
export function useTrusting(): Trusting {
  const { trusting } = useContext(FollowingContext)
  return useSyncExternalStore(trusting.subscribe, trusting.get, trusting.get)
}

/** What came of the last ask to reload `block`'s files, if the person asked. */
export function useReloading(block: BlockView["block"]): Reloading | undefined {
  const { reloading } = useContext(FollowingContext)
  const select = () => reloading.get().get(block)
  return useSyncExternalStore(reloading.subscribe, select, select)
}

/** What `block`'s open source views show, or nothing while none is open. */
export function useScriptFiles(block: BlockView["block"]): ScriptFilesShown | undefined {
  const { scriptFiles } = useContext(FollowingContext)
  const select = () => scriptFiles.get(block)
  return useSyncExternalStore(scriptFiles.subscribe, select, select)
}

/**
 * The window following `session` in `engine`, from its runbook and the
 * settings as the window read them (`opened`). `start` follows the session
 * and the settings until the function it returns is called, which a
 * component calls from its effect.
 */
export function followingOf(
  engine: EngineClient,
  session: SessionId,
  opened: { readonly document: DocumentView; readonly settings: Settings },
): Following & { readonly start: () => () => void } {
  const live = makeLiveStore()
  const settingsNow = makeSettingsStore(opened.settings)
  const trusting = makeTrustingStore()
  const reloading = makeReloadingStore()
  const scriptFiles = makeScriptFilesStore(engine, session, live)
  // A semaphore lets its waiters in in the order they came.
  const inTurn = Semaphore.makeUnsafe(1)
  return {
    live,
    settings: settingsNow,
    trusting,
    reloading,
    scriptFiles,
    act: (block, request) => inTurn.withPermit(ask(engine, session, block, request)),
    trust: () => {
      const { document } = live.get()
      if (document === undefined) return Effect.void
      const before = trusting.get()
      const asked = {
        shown: document.hash,
        hash: changeOver(before, document)?.hash ?? document.hash,
      }
      return Effect.flatMap(askToTrust(engine, session, asked, before), (next) =>
        Effect.sync(() => trusting.set(next)),
      )
    },
    reload: (block, hash) =>
      Effect.suspend(() => {
        const drawn = live.get().document
        reloading.set(block, { hash, drawn, answer: { _tag: "Asking" } })
        return Effect.flatMap(askToReload(engine, session, block, hash), (answer) =>
          Effect.sync(() => reloading.set(block, { hash, drawn, answer })),
        )
      }),
    start: () => {
      const stopReading = scriptFiles.start()
      const fiber = Effect.runFork(
        Effect.all(
          [
            follow(engine, session, opened.document, settingsNow, live.set),
            followSettings(engine, settingsNow.set),
          ],
          {
            concurrency: "unbounded",
            discard: true,
          },
        ),
      )
      return () => {
        fiber.interruptUnsafe()
        stopReading()
      }
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

/** What entering values says: each value not entered. A field's error shows on the field. */
function entered(result: SetValuesResult): string | undefined {
  const rejected = Object.entries(result.rejected)
  return rejected.length === 0
    ? undefined
    : rejected.map(([field, why]) => `${field}: ${why}`).join(" ")
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
