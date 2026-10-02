/**
 * Which saved session a launch that names no runbook resumes.
 *
 * This module doesn't import electron, so it runs under `bun test`.
 */
import * as fs from "node:fs"
import { Effect } from "effect"
import type { SessionPersistence } from "../../src/domain/session/persistence.ts"
import type { SessionRecord } from "../../src/domain/session/store.ts"
import { makeLogger } from "./logger.ts"

const log = makeLogger("sessions")

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
