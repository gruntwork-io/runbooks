/**
 * What a launch of `runbooks` opens, and which saved session a launch that
 * names no runbook resumes.
 *
 * This module doesn't import electron, so it runs under `bun test`.
 */
import * as fs from "node:fs"
import { Effect } from "effect"
import type { SessionPersistence } from "../../src/domain/session/persistence.ts"
import type { SessionRecord } from "../../src/domain/session/store.ts"
import type { Launch } from "./ipc/runbook.ts"
import { makeLogger } from "./logger.ts"

const log = makeLogger("sessions")

/** The runbook a launch opens, and what runbook:get is told about it (expectLaunch). */
export interface LaunchPlan {
  launch: Launch
  open: { path: string } | { remoteUrl: string }
}

/** The runbook a command line names (parseCliArgs). */
export interface LaunchArgs {
  runbookPath: string | null
  remoteUrl: string | null
}

/**
 * What the app's first launch opens: the runbook the command line names, or
 * else the session to resume for `launchDir` (sessionToResume).
 *
 * Undefined when there is nothing to open, and when the launch opens a
 * runbook double-clicked in a file manager (`openFilePath`) instead.
 */
export function planStartupLaunch(
  persistence: SessionPersistence,
  args: LaunchArgs,
  launchDir: string | undefined,
  openFilePath: string | null,
): LaunchPlan | undefined {
  const named = planNamed(args, launchDir)
  if (named !== undefined) return named
  if (openFilePath !== null) return undefined
  return planResume(sessionToResume(persistence, launchDir), launchDir)
}

/**
 * What `runbooks` run again while the app is open brings up: the runbook the
 * command line names, or else the session last launched from `launchDir`.
 *
 * Undefined when there is nothing to bring up: a launch with no directory (the
 * dock), a directory no session was launched from, or a session that is
 * already open (`isOpen`). The window then keeps what it shows.
 */
export function planSecondLaunch(
  persistence: SessionPersistence,
  args: LaunchArgs,
  launchDir: string | undefined,
  isOpen: (sessionId: string) => boolean,
): LaunchPlan | undefined {
  const named = planNamed(args, launchDir)
  if (named !== undefined) return named
  if (launchDir === undefined) return undefined
  const saved = sessionToResume(persistence, launchDir)
  if (saved === undefined || isOpen(saved.id)) return undefined
  return planResume(saved, launchDir)
}

/**
 * The session to resume for `runbooks` run with no arguments: the one most
 * recently launched from `launchDir`, or the most recent of all when
 * `launchDir` is undefined (see launchDirContext in launch-dir.ts).
 *
 * Undefined when there is none, when the database can't be read, or when the
 * session's runbook file has been deleted: the app then opens on its welcome
 * screen instead of an error. A remote runbook is cloned again on resume, so
 * its last clone being gone doesn't matter.
 */
export function sessionToResume(
  persistence: SessionPersistence,
  launchDir: string | undefined,
): SessionRecord | undefined {
  const session = Effect.runSync(
    persistence.findForLaunch(launchDir).pipe(
      Effect.catchAll((err) =>
        Effect.sync(() => {
          log.error("Can't look up the session to resume:", err)
          return undefined
        }),
      ),
    ),
  )
  if (session === undefined) return undefined
  if (session.remoteSource === undefined && !fs.existsSync(session.path)) return undefined
  return session
}

function planNamed(args: LaunchArgs, launchDir: string | undefined): LaunchPlan | undefined {
  if (args.remoteUrl) {
    return {
      launch: { source: args.remoteUrl, launchDir, sessionId: undefined },
      open: { remoteUrl: args.remoteUrl },
    }
  }
  if (args.runbookPath) {
    return {
      launch: { source: args.runbookPath, launchDir, sessionId: undefined },
      open: { path: args.runbookPath },
    }
  }
  return undefined
}

function planResume(
  saved: SessionRecord | undefined,
  launchDir: string | undefined,
): LaunchPlan | undefined {
  if (saved === undefined) return undefined
  return {
    launch: { source: saved.remoteSource ?? saved.path, launchDir, sessionId: saved.id },
    open:
      saved.remoteSource !== undefined ? { remoteUrl: saved.remoteSource } : { path: saved.path },
  }
}
