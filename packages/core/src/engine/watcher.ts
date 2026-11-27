/**
 * A session's watcher: what it watches on disk in its watch mode
 * (`WatchMode`), and what a save there does.
 *
 * - A save of a file a block names gives the notice: the session reads it
 *   and the block shows how it differs (`Session.filesChanged`). It never
 *   reloads the runbook, in any mode.
 * - A save of the runbook reloads it in `runbook`, each named file at the
 *   text the session holds, and in `runbookAndFiles`, each read again.
 *
 * Saves less than `WATCH_DEBOUNCE` apart are taken together, once the last
 * is that old, as the old app's watcher took them. The watcher takes one
 * batch at a time, so a reload's reads come after every read before them.
 * It watches through the `FileSystem` service, in the session's scope, and
 * watches again what a reload names, however the reload came: from a save,
 * or held back until a run ended. A watch the system refuses ends the
 * watching, and the session says why and what to do (`Session.unwatched`).
 */
import path from "node:path"
import { Duration, Effect, Option, Stream } from "effect"
import type { RunbookPath } from "@runbooks/blocks-core/contract"
import type { FileFact } from "../document/files.ts"
import type { FileWatchError } from "../errors/index.ts"
import { isContainedIn } from "../path-validation.ts"
import { type FileChangeEvent, FileSystem } from "../services/FileSystem.ts"
import type { EventEnvelope, UnknownSequence, UnknownSession, WatchMode } from "./protocol.ts"
import type { ReloadFilesFrom } from "./session.ts"

/** How long the watcher waits after a save for another, as the old app's `DEBOUNCE_MS`. */
export const WATCH_DEBOUNCE = Duration.millis(300)

/** What a watcher needs of its session. */
export interface Watched {
  /** The runbook, by absolute path. */
  readonly runbook: string
  /** What the session holds at each path its runbook names, now. */
  readonly files: () => ReadonlyMap<RunbookPath, FileFact>
  /** The sequence of the last event the session logged. */
  readonly sequence: () => number | undefined
  readonly events: (after: number | undefined) => Stream.Stream<EventEnvelope, UnknownSequence>
  /** Reads `paths` from disk and gives the session what it read (`Engine.filesChanged`). */
  readonly filesChanged: (paths: ReadonlyArray<RunbookPath>) => Effect.Effect<void, UnknownSession>
  /** Reads the runbook from disk and reloads the session with it (`Engine.reloadRunbook`). */
  readonly reload: (from: ReloadFilesFrom) => Effect.Effect<unknown, UnknownSession>
  /** Tells the session it watches nothing from now on, and why (`Session.unwatched`). */
  readonly unwatched: (message: string) => Effect.Effect<void, UnknownSession>
}

/** What a watcher watches: folders at depth 0, and folders whole. */
interface WatchSet {
  readonly shallow: ReadonlyArray<string>
  readonly deep: ReadonlyArray<string>
}

/** A named path the parser read as a folder: a file's one text is at the path itself. */
const isFolder = (named: RunbookPath, fact: FileFact): boolean =>
  fact._tag === "Found" && !(fact.texts.length === 1 && fact.texts[0]?.path === named)

/**
 * The runbook's folder and the folder of each other path the runbook
 * names, at depth 0, and each folder it names whole. A folder is watched
 * whole only as the loader found it, read whole within
 * `RUNBOOK_FILE_LIMITS` (2000 entries, 16 folders deep): one over a limit
 * stops its block (`badFile`) and is watched at its own folder, as a path
 * missing is. So the document bounds what is watched. A path outside the
 * runbook's folder, which stops its block too, is not watched.
 */
const watchSetOf = (runbook: string, files: ReadonlyMap<RunbookPath, FileFact>): WatchSet => {
  const folder = path.dirname(runbook)
  const shallow = new Set([folder])
  const deep = new Set<string>()
  for (const [named, fact] of files) {
    const at = path.resolve(folder, named)
    if (!isContainedIn(at, folder)) continue
    if (isFolder(named, fact)) deep.add(at)
    else shallow.add(path.dirname(at))
  }
  return { shallow: [...shallow].sort(), deep: [...deep].sort() }
}

const keyOf = (set: WatchSet) => JSON.stringify(set)

/**
 * Whether a file system event is the runbook's, and the named paths it is
 * at or in. Compared without case: a file system that ignores it reports
 * the name as it is on disk, which may not be as the runbook spells it,
 * and a match too many only reads a file again.
 */
const touched = (
  event: FileChangeEvent,
  runbook: string,
  files: ReadonlyMap<RunbookPath, FileFact>,
): { readonly runbook: boolean; readonly paths: ReadonlyArray<RunbookPath> } => {
  const at = path.resolve(event.path).toLowerCase()
  const folder = path.dirname(runbook)
  const paths = [...files.keys()].filter((named) => {
    const full = path.resolve(folder, named).toLowerCase()
    return at === full || at.startsWith(`${full}${path.sep}`)
  })
  return { runbook: at === path.resolve(runbook).toLowerCase(), paths }
}

/**
 * Why a session watches nothing once a watch failed with `cause`, and what
 * to do. A watch fails with ENOSPC only past Linux's limit on file watches,
 * which the person can raise; for any other failure, opening the runbook
 * again watches it again.
 */
const unwatchedMessage = (runbook: string, cause: unknown): string => {
  const reason = cause instanceof Error ? cause.message : String(cause)
  const failed = `Runbooks could not watch ${runbook}, or the files it names, for changes (${reason}), so saving them shows nothing here.`
  return reason.includes("ENOSPC")
    ? `${failed} Linux's limit on file watches was reached: raise fs.inotify.max_user_watches, then open the runbook again.`
    : `${failed} Open the runbook again to watch it.`
}

/**
 * Watches the session's runbook and the files it names in `mode` for the
 * session's lifetime. A watch that fails ends the watching: it is logged,
 * and the session says so (`unwatched`). The session holds nothing back for
 * it.
 */
export const watchSession = (
  mode: Exclude<WatchMode, "off">,
  watched: Watched,
): Effect.Effect<void, never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const reloads = mode === "runbook" || mode === "runbookAndFiles"
    // Kept across each watch again, so a save seen before it is taken after.
    const batch = { runbook: false, paths: new Set<RunbookPath>() }
    const take = Effect.suspend(() => {
      const { runbook } = batch
      const paths = [...batch.paths]
      batch.runbook = false
      batch.paths.clear()
      return Effect.andThen(
        paths.length === 0 ? Effect.void : watched.filesChanged(paths),
        runbook ? watched.reload(mode === "runbook" ? "held" : "read") : Effect.void,
      )
    })

    /**
     * Watches what the session names now until a reload names other paths.
     * A batch and the reload's news are taken in turn, so a batch is taken
     * whole before the watch ends.
     */
    const watchOnce = Effect.suspend(() => {
      const after = watched.sequence()
      const set = watchSetOf(watched.runbook, watched.files())
      const seen = Stream.mergeAll(
        [
          fs.watch([...set.shallow], { depth: 0 }),
          ...(set.deep.length === 0 ? [] : [fs.watch([...set.deep])]),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Stream.map((event) => touched(event, watched.runbook, watched.files())),
        // Before the debounce, so an event the mode ignores keeps no other waiting.
        Stream.filter((news) => (reloads && news.runbook) || news.paths.length > 0),
        Stream.tap((news) =>
          Effect.sync(() => {
            if (reloads && news.runbook) batch.runbook = true
            for (const named of news.paths) batch.paths.add(named)
          }),
        ),
      )
      const waiting = batch.runbook || batch.paths.size > 0
      const saves = (waiting ? Stream.concat(Stream.succeed(undefined), seen) : seen).pipe(
        Stream.debounce(WATCH_DEBOUNCE),
        Stream.as("take" as const),
      )
      const renamed = Stream.filter(
        watched.events(after),
        (envelope) =>
          envelope.event._tag === "DocumentChanged" &&
          keyOf(watchSetOf(watched.runbook, watched.files())) !== keyOf(set),
      ).pipe(Stream.as("watchAgain" as const))
      return Stream.merge(saves, renamed).pipe(
        Stream.mapEffect((next) =>
          next === "take" ? Effect.as(take, false) : Effect.succeed(true),
        ),
        Stream.takeUntil((again) => again),
        Stream.runLast,
        Effect.map(Option.getOrElse(() => false)),
      )
    })

    const watchFrom: Effect.Effect<
      void,
      FileWatchError | UnknownSession | UnknownSequence,
      FileSystem
    > = Effect.flatMap(watchOnce, (again) => (again ? watchFrom : Effect.void))
    yield* watchFrom
  }).pipe(
    Effect.catchTag("FileWatchError", ({ cause }) => {
      const message = unwatchedMessage(watched.runbook, cause)
      return Effect.andThen(Effect.logWarning(message), watched.unwatched(message))
    }),
    // The session is closing.
    Effect.catchTags({ UnknownSession: () => Effect.void, UnknownSequence: () => Effect.void }),
  )
