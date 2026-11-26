/**
 * The runbook a launch of the app names, and opening it for the person who
 * launched it.
 *
 * - The command line's first argument that is not a switch names it. An
 *   unpackaged run (`electron <entry> ...`) passes the app's entry first,
 *   which is not a runbook. Chromium's and Electron's switches start with
 *   `-`, as `-psn_...` does, which macOS adds to an app it starts.
 * - A relative path resolves against the folder the app was started in.
 * - A folder names the `runbook.mdx` in it.
 * - Main opens it with a client of its own on the engine it serves the page,
 *   with a person's origin: the person launched the app with that path. Main
 *   serves the page only once that open is done. A page that asks before then
 *   waits in main's queue (`ipcServer.ts`), and `ListSessions` finds the
 *   session.
 * - What keeps it from opening goes to `log`, one line each: main's standard
 *   error. The page cannot learn of an open it did not make that failed: it
 *   finds no session, and shows the welcome screen.
 */
import path from "node:path"
import { Cause, Effect } from "effect"
import type { Rpc, RpcClientError, RpcServer } from "effect/rpc"
import { makeInProcessClient } from "@runbooks/core/inProcess"
import type { EngineCommand, RunbookUnreadable } from "@runbooks/core/protocol"
import { FileSystem } from "@runbooks/core/services/FileSystem"
import { servePage } from "./ipcServer.ts"

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

/** Why the launch's runbook did not open. */
type LaunchFailure = LaunchProblem | RunbookUnreadable | RpcClientError.RpcClientError

/** The line that says why `failure` kept the launch's runbook from opening. */
const failureLine = (failure: LaunchFailure): string => {
  switch (failure._tag) {
    case "Missing":
      return `Runbooks could not open ${failure.path}: there is no file or folder there.`
    case "NoRunbookInFolder":
      return `Runbooks could not open ${failure.folder}: the folder has no ${RUNBOOK_FILE}.`
    case "UnknownFolder":
      return `Runbooks could not open ${failure.argument}: the folder Runbooks was started in can't be read, so a relative path names nothing. Give the runbook's full path.`
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

/** The line that says the engine failed opening `argument`: a defect, not an answer. */
const defectLine = (argument: string, cause: Cause.Cause<unknown>): string => {
  const defect = Cause.squash(cause)
  const reason = defect instanceof Error ? `${defect.name}: ${defect.message}` : String(defect)
  return `Runbooks could not open ${argument}: the engine failed: ${reason}`
}

/**
 * Opens the runbook `launch` names, as the person who launched the app, on
 * the engine in context. What kept it from opening goes to `log`: a line
 * for the runbook, then one for each error the engine found in it. When
 * the engine fails instead of answering, as a runbook nested deep enough to
 * overflow its stack makes it, that is one line too, and main still serves
 * the page.
 */
const openLaunch = (
  launch: Launch,
  log: (line: string) => void,
): Effect.Effect<void, never, Rpc.ToHandler<EngineCommand> | FileSystem> =>
  Effect.gen(function* () {
    const runbook = yield* findLaunchRunbook(launch.argument, launch.startedIn)
    const client = yield* makeInProcessClient("person")
    const result = yield* client.OpenSession({ path: runbook })
    if (result._tag === "Opened") return
    log(`Runbooks could not open ${runbook}:`)
    for (const error of result.errors) {
      const { file, span } = error.location
      log(`  ${file}:${span.start.line}:${span.start.column}: ${error.message}`)
    }
  }).pipe(
    Effect.scoped,
    Effect.catch((failure) => Effect.sync(() => log(failureLine(failure)))),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.sync(() => log(defectLine(launch.argument, cause))),
    ),
  )

/**
 * Opens the runbook `launch` names, if any, then serves the page over
 * `protocol` until interrupted. The page's commands wait in the protocol's
 * queue until the open is done.
 */
export const serveLaunch = (
  protocol: RpcServer.Protocol["Service"],
  launch: Launch | undefined,
  log: (line: string) => void,
): Effect.Effect<never, never, Rpc.ToHandler<EngineCommand> | FileSystem> =>
  Effect.andThen(launch === undefined ? Effect.void : openLaunch(launch, log), servePage(protocol))
