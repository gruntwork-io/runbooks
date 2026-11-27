/**
 * The runbook a launch of the app names, and opening it for the person who
 * launched it.
 *
 * - The command line's first argument that is not a switch names it. An
 *   unpackaged run (`electron <entry> ...`) passes the app's entry first,
 *   which is not a runbook. Chromium's and Electron's switches start with
 *   `-`, as `-psn_...` does, which macOS adds to an app it starts.
 * - A remote source (`isRemoteSource`: a GitHub or GitLab URL, or a
 *   go-getter source) is cloned into the clones folder, and the runbook it
 *   names there opens (`remoteRunbook.ts`).
 * - Otherwise it is a path. A relative path resolves against the folder the
 *   app was started in, and a folder names the `runbook.mdx` in it.
 * - Main opens it with a client of its own on the engine it serves the page,
 *   with a person's origin: the person launched the app with that path. Main
 *   serves the page only once that open is done. A page that asks before then
 *   waits in main's queue (`ipcServer.ts`), and `ListSessions` finds the
 *   session.
 * - What keeps it from opening goes to `log`, one line each: main's standard
 *   error. A line shows a remote source without its credentials, and no
 *   token (`redactSecrets`). The page cannot learn of an open it did not make
 *   that failed: it finds no session, and shows the welcome screen.
 * - A later launch on the same user data folder hands its runbook to this
 *   app, which opens them one at a time once the first is open. Each that
 *   opens is shown (`Launches.show`): main reloads the page, and the page
 *   shows the session the engine opened last. One that doesn't open leaves
 *   the page as it is, and its line goes to this app's standard error.
 */
import path from "node:path"
import { Cause, Effect, Queue } from "effect"
import type { Rpc, RpcClientError, RpcServer } from "effect/rpc"
import { redactSecrets } from "@runbooks/core/domain/vcs/redact"
import type { RemoteSourceError } from "@runbooks/core/errors"
import { makeInProcessClient } from "@runbooks/core/inProcess"
import type { EngineCommand, RunbookUnreadable } from "@runbooks/core/protocol"
import { isRemoteSource, redactSourceCredentials } from "@runbooks/core/remote-source"
import type { Environment } from "@runbooks/core/services/Environment"
import { FileSystem } from "@runbooks/core/services/FileSystem"
import type { GitClient } from "@runbooks/core/services/GitClient"
import type { ProcessSpawner } from "@runbooks/core/services/ProcessSpawner"
import type { VcsCredentials } from "@runbooks/core/services/VcsCredentials"
import { servePage } from "./ipcServer.ts"
import { resolveRemoteRunbook } from "./remoteRunbook.ts"

/** The file a folder given on the command line names. */
export const RUNBOOK_FILE = "runbook.mdx"

/**
 * The runbook argument in `argv` (`process.argv`), if any. `defaultApp` is
 * `process.defaultApp`: true in an unpackaged run, whose first argument that
 * is not a switch is the app's entry.
 */
export function launchArgument(
  argv: ReadonlyArray<string>,
  defaultApp: boolean,
): string | undefined {
  const positional = argv.slice(1).filter((argument) => !argument.startsWith("-"))
  return positional[defaultApp ? 1 : 0]
}

/** Why the runbook a launch names could not be found. */
export type LaunchProblem =
  | { readonly _tag: "Missing"; readonly path: string }
  | { readonly _tag: "NoRunbookInFolder"; readonly folder: string }
  | { readonly _tag: "UnknownFolder"; readonly argument: string }

/**
 * The runbook file `argument` names: itself, or the `runbook.mdx` in the
 * folder it names. `startedIn` is the folder the app was started in, or
 * undefined when it can't be read (it was deleted), and a relative argument
 * then names nothing.
 */
export const findLaunchRunbook = (
  argument: string,
  startedIn: string | undefined,
): Effect.Effect<string, LaunchProblem, FileSystem> =>
  Effect.gen(function* () {
    if (startedIn === undefined && !path.isAbsolute(argument))
      return yield* Effect.fail<LaunchProblem>({ _tag: "UnknownFolder", argument })
    const target = path.resolve(startedIn ?? "/", argument)
    const fs = yield* FileSystem
    const stat = yield* fs
      .stat(target)
      .pipe(Effect.mapError((): LaunchProblem => ({ _tag: "Missing", path: target })))
    if (!stat.isDirectory) return target
    const runbook = path.join(target, RUNBOOK_FILE)
    if (!(yield* fs.exists(runbook)))
      return yield* Effect.fail<LaunchProblem>({ _tag: "NoRunbookInFolder", folder: target })
    return runbook
  })

/** What a launch gives: the argument, and the folder it was started in. */
export interface Launch {
  readonly argument: string
  readonly startedIn: string | undefined
}

/** How many later launches may wait to open. One past them is refused. */
export const MAX_WAITING_LAUNCHES = 16

/** The line that waits for the runbooks later launches name. */
export const makeLaterLaunches = (): Effect.Effect<Queue.Queue<Launch>> =>
  Queue.dropping<Launch>(MAX_WAITING_LAUNCHES)

/** `argument` as a line shows it: a remote source without its credentials. */
const shownArgument = (argument: string): string =>
  isRemoteSource(argument) ? redactSourceCredentials(argument) : argument

/**
 * Puts `launch` in `later` to open, or says on `log` that it can't when
 * `MAX_WAITING_LAUNCHES` already wait.
 */
export function waitToOpen(
  later: Queue.Enqueue<Launch>,
  launch: Launch,
  log: (line: string) => void,
): void {
  if (Queue.offerUnsafe(later, launch)) return
  log(
    redactSecrets(
      `Runbooks could not open ${shownArgument(launch.argument)}: ${MAX_WAITING_LAUNCHES} launches already wait to open. Launch it again once they have.`,
    ),
  )
}

/** Why the launch's runbook did not open. */
type LaunchFailure =
  | LaunchProblem
  | RemoteSourceError
  | RunbookUnreadable
  | RpcClientError.RpcClientError

/** The line that says why `failure` kept the launch's runbook from opening. */
const failureLine = (failure: LaunchFailure): string => {
  switch (failure._tag) {
    case "Missing":
      return `Runbooks could not open ${failure.path}: there is no file or folder there.`
    case "NoRunbookInFolder":
      return `Runbooks could not open ${failure.folder}: the folder has no ${RUNBOOK_FILE}.`
    case "UnknownFolder":
      return `Runbooks could not open ${failure.argument}: the folder Runbooks was started in can't be read, so a relative path names nothing. Give the runbook's full path.`
    case "RemoteSourceError":
      return `Runbooks could not open ${failure.url}: ${failure.message}`
    case "RunbookUnreadable":
      return `Runbooks could not open ${failure.path}: ${failure.message}`
    case "RpcClientError":
      return `Runbooks could not open the runbook: the engine failed: ${failure.message}`
    default: {
      const unhandled: never = failure
      throw new Error(`Unhandled launch failure: ${String(unhandled)}`)
    }
  }
}

/** The line that says the engine failed opening `shown`: a defect, not an answer. */
const defectLine = (shown: string, cause: Cause.Cause<unknown>): string => {
  const defect = Cause.squash(cause)
  const reason = defect instanceof Error ? `${defect.name}: ${defect.message}` : String(defect)
  return `Runbooks could not open ${shown}: the engine failed: ${reason}`
}

/** The services cloning a remote source takes. */
type RemoteServices = VcsCredentials | GitClient | ProcessSpawner | Environment

/** The launches main opens runbooks for, and what it does with them. */
export interface Launches {
  /** The runbook the app's own command line names, if any. */
  readonly first: Launch | undefined
  /** The runbooks later launches name (`waitToOpen`). */
  readonly later: Queue.Dequeue<Launch>
  /** The folder a remote source is cloned into. */
  readonly clones: string
  /** Main's standard error, one line at a time. */
  readonly log: (line: string) => void
  /** Shows in the window the runbook a later launch opened. */
  readonly show: () => void
}

/**
 * Opens the runbook `launch` names, as the person who launched the app, on
 * the engine in context, and succeeds with whether it opened. A remote
 * source is cloned into `clones` first. What kept it from opening goes to
 * `log`: a line for the runbook, then one for each error the engine found
 * in it. When the engine fails instead of answering, as a runbook nested
 * deep enough to overflow its stack makes it, that is one line too, and
 * main still serves the page.
 */
const openLaunch = (
  launch: Launch,
  { clones, log }: Launches,
): Effect.Effect<boolean, never, Rpc.ToHandler<EngineCommand> | FileSystem | RemoteServices> => {
  const say = (line: string) => log(redactSecrets(line))
  const remote = isRemoteSource(launch.argument)
  const shown = shownArgument(launch.argument)
  return Effect.gen(function* () {
    const runbook = remote
      ? yield* resolveRemoteRunbook(launch.argument, clones)
      : yield* findLaunchRunbook(launch.argument, launch.startedIn)
    const client = yield* makeInProcessClient("person")
    const result = yield* client.OpenSession({ path: runbook })
    if (result._tag === "Opened") return true
    say(`Runbooks could not open ${remote ? shown : runbook}:`)
    for (const error of result.errors) {
      const { file, span } = error.location
      say(`  ${file}:${span.start.line}:${span.start.column}: ${error.message}`)
    }
    return false
  }).pipe(
    Effect.scoped,
    Effect.catch((failure) =>
      Effect.as(
        Effect.sync(() => say(failureLine(failure))),
        false,
      ),
    ),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.as(
            Effect.sync(() => say(defectLine(shown, cause))),
            false,
          ),
    ),
  )
}

/**
 * Opens the runbook the first launch names, if any, then serves the page
 * over `protocol` until interrupted. The page's commands wait in the
 * protocol's queue until that open is done. Meanwhile it opens the runbooks
 * later launches name, one at a time, and shows each that opens.
 */
export const serveLaunch = (
  protocol: RpcServer.Protocol["Service"],
  launches: Launches,
): Effect.Effect<never, never, Rpc.ToHandler<EngineCommand> | FileSystem | RemoteServices> =>
  Effect.gen(function* () {
    if (launches.first !== undefined) yield* openLaunch(launches.first, launches)
    yield* Queue.take(launches.later).pipe(
      Effect.flatMap((launch) => openLaunch(launch, launches)),
      Effect.flatMap((opened) => (opened ? Effect.sync(launches.show) : Effect.void)),
      Effect.forever,
      Effect.forkScoped,
    )
    return yield* servePage(protocol)
  }).pipe(Effect.scoped)
