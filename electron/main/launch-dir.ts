/**
 * The directory `runbooks` was launched from, when that directory may have
 * been deleted.
 *
 * A shell can sit in a folder that no longer exists (a removed git worktree,
 * a deleted temp dir). When `runbooks` is run there:
 *
 * - Node's process.cwd() throws `ENOENT: process.cwd failed ... uv_cwd` in
 *   Electron's main process, which would crash startup at the first call.
 * - Chromium's single-instance hand-off puts the current directory into the
 *   message it sends the running app, and gives up when it can't read it. It
 *   then tries to take the lock itself, prints
 *   `Failed to create .../SingletonLock: File exists (17)`, and
 *   requestSingleInstanceLock() returns false: the running window is never
 *   told, so nothing happens.
 *
 * recoverLaunchDirectory() runs before the lock is requested. It moves the
 * process to a directory that exists, so the hand-off and every later
 * process.cwd() work, and it returns the folder relative CLI paths should
 * resolve against: $PWD, the shell's name for the folder the user typed the
 * path in. If a folder has been recreated at that path (a branch switch, a
 * re-clone), `runbooks .` opens it; otherwise runbook:get reports that the
 * path no longer exists.
 *
 * This module doesn't import electron, so it runs under `bun test`.
 */
import os from "node:os"
import path from "node:path"
import { makeLogger } from "./logger.ts"

const log = makeLogger("main")

/** The parts of `process` that recoverLaunchDirectory reads and changes. */
export interface ProcessDirectory {
  cwd(): string
  chdir(dir: string): void
  /** $PWD: the directory the launching shell believes it is in. */
  pwd: string | undefined
  home: string
}

/** This process, read when called. */
function currentProcess(): ProcessDirectory {
  return {
    cwd: () => process.cwd(),
    chdir: (dir) => process.chdir(dir),
    pwd: process.env.PWD,
    home: os.homedir(),
  }
}

/**
 * Return the directory relative CLI paths resolve against, and make sure the
 * process's own cwd can be read. A readable cwd is returned as-is and nothing
 * changes. Otherwise the process moves to the home directory (or `/`), and the
 * result is $PWD when it is absolute, or the home directory when it isn't.
 * Never throws.
 */
export function recoverLaunchDirectory(proc: ProcessDirectory = currentProcess()): string {
  let reason: unknown
  try {
    return proc.cwd()
  } catch (err) {
    // ENOENT when the folder was deleted, EACCES when it can't be read. Any
    // other failure leaves the process just as stuck, so it is handled alike.
    reason = (err as NodeJS.ErrnoException | null)?.code ?? err
  }

  const launchDir = proc.pwd && path.isAbsolute(proc.pwd) ? proc.pwd : proc.home

  let movedTo: string | undefined
  for (const dir of [proc.home, "/"]) {
    try {
      proc.chdir(dir)
      movedTo = dir
      break
    } catch {
      // Try the next one.
    }
  }

  log.warn(
    `Can't read the directory runbooks was run from (${String(reason)}). ` +
      `Relative paths resolve against ${launchDir}; ` +
      (movedTo ? `Runbooks now runs from ${movedTo}.` : "Runbooks couldn't move to another directory."),
  )
  return launchDir
}

/**
 * The directory a second instance was launched from, for resolving the
 * relative paths in its argv. The second instance forwards its launch
 * directory as `additionalData.cwd` (see index.ts). Prefer that: when its own
 * folder was deleted it has already moved to the home directory, which is what
 * Electron then reports as `workingDirectory`. A sender without an absolute
 * `cwd` string (an older build) falls back to `workingDirectory`.
 */
export function secondInstanceLaunchDirectory(workingDirectory: string, additionalData: unknown): string {
  const forwarded = (additionalData as { cwd?: unknown } | null | undefined)?.cwd
  return typeof forwarded === "string" && path.isAbsolute(forwarded) ? forwarded : workingDirectory
}
