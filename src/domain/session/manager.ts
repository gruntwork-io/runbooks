/**
 * A SessionManager holds the single live session for the open runbook ("one
 * runbook = one environment"). Variables that auth blocks set, and that
 * scripts write to RUNBOOK_ENV, persist across block executions.
 *
 * The manager keeps nothing on disk. It reports every change to a listener
 * (setChangeListener), and resumeSession rebuilds a session from what the
 * listener saved; persistence.ts does both.
 */

import { Effect } from "effect"

import { Environment } from "../../services/Environment.js"
import { SessionError, SessionNotFoundError } from "../../errors/index.js"
import type { SessionMetadata, SessionExecSnapshot } from "../../types.js"

// ---------------------------------------------------------------------------
// Internal session state
// ---------------------------------------------------------------------------

interface Session {
  env: Map<string, string>
  initialEnv: Map<string, string>
  /** The session's directory, where scripts run unless their block sets `workingDir`. */
  workingDir: string
  executionCount: number
  createdAt: Date
  lastActivity: Date
  registeredWorkTreePaths: string[]
  activeWorkTreePath: string
  /** The runbook file this session belongs to. Used to detect "a different
   *  runbook was opened" so per-runbook state (worktrees, env) doesn't leak
   *  into an unrelated runbook that happens to reuse the same running app. */
  runbookPath: string
}

/** What scripts and auth blocks changed in the env the session started with. */
export interface EnvChanges {
  set: Record<string, string>
  unset: string[]
}

/** The part of a session that outlives the app: what a change listener is given and resumeSession takes back. */
export interface SessionState {
  env: EnvChanges
  /** The registered git worktrees, oldest first. */
  worktrees: string[]
  /** The worktree the user selected, or "" for the last registered one. */
  activeWorktree: string
  executionCount: number
  lastActivity: Date
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function copyEnvMap(src: Map<string, string>): Map<string, string> {
  return new Map(src)
}

function recordToMap(rec: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(rec))
}

function mapToRecord(m: Map<string, string>): Record<string, string> {
  return Object.fromEntries(m)
}

/**
 * What changed from `before` to `after`: keys added or re-assigned (`set`)
 * and keys removed (`unset`).
 */
export function diffEnv(before: Record<string, string>, after: Record<string, string>): EnvChanges {
  const set = Object.fromEntries(
    Object.entries(after).filter(([k, v]) => !Object.hasOwn(before, k) || before[k] !== v),
  )
  const unset = Object.keys(before).filter((k) => !Object.hasOwn(after, k))
  return { set, unset }
}

/**
 * `path` (a PATH value, entries separated by `delimiter`) with each of
 * `entries` it doesn't have added to its end, in order, and the entries that
 * were added. Entries already on it keep their place, so the tools a PATH
 * finds stay the ones it found.
 */
export function appendPathEntries(
  path: string,
  entries: readonly string[],
  delimiter: string,
): { path: string; added: string[] } {
  const present = new Set(path.split(delimiter))
  const added: string[] = []
  for (const entry of entries) {
    if (entry === "" || present.has(entry)) continue
    present.add(entry)
    added.push(entry)
  }
  return { path: [path, ...added].filter((part) => part !== "").join(delimiter), added }
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

export class SessionManager {
  private session: Session | null = null
  private protectedEnvVars: string[] = []
  /** Bumped by every createSession and resumeSession, so a snapshot can tell its session was replaced. */
  private generation = 0
  private changeListener: ((state: SessionState) => void) | undefined

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  /**
   * Configure environment variables that should be stripped from the session at
   * creation time (e.g. AWS credentials that require explicit auth).
   * Must be called before every `createSession` — including with `[]` — so a
   * previous runbook's list never applies to the next one.
   */
  setProtectedEnvVars(vars: string[]): void {
    this.protectedEnvVars = vars
  }

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  /**
   * Create a new session, replacing any existing one. The environment is
   * captured from the running process via the Environment service, with
   * protected vars stripped. The change listener is dropped: it belonged to
   * the session this one replaces.
   */
  createSession(workingDir: string, runbookPath: string = "") {
    return Effect.gen({ self: this }, function* () {
      const env = yield* this.startingEnv()
      const now = new Date()

      this.replaceSession({
        env,
        initialEnv: copyEnvMap(env),
        workingDir,
        executionCount: 0,
        createdAt: now,
        lastActivity: now,
        registeredWorkTreePaths: [],
        activeWorkTreePath: "",
        runbookPath,
      })
    })
  }

  /**
   * Replace any existing session with one a previous run of the app saved.
   * Like createSession it starts from the running process's environment, so
   * a PATH edited since then is picked up, and then re-applies `state.env`,
   * the changes the saved session had made to its own starting env. Resetting
   * the session goes back to the process's environment, without them.
   */
  resumeSession(saved: {
    workingDir: string
    runbookPath: string
    createdAt: Date
    state: SessionState
  }) {
    return Effect.gen({ self: this }, function* () {
      const initialEnv = yield* this.startingEnv()
      const env = copyEnvMap(initialEnv)
      for (const [key, value] of Object.entries(saved.state.env.set)) {
        env.set(key, value)
      }
      for (const key of saved.state.env.unset) {
        env.delete(key)
      }

      this.replaceSession({
        env,
        initialEnv,
        workingDir: saved.workingDir,
        executionCount: saved.state.executionCount,
        createdAt: saved.createdAt,
        lastActivity: saved.state.lastActivity,
        registeredWorkTreePaths: [...saved.state.worktrees],
        activeWorkTreePath: saved.state.activeWorktree,
        runbookPath: saved.runbookPath,
      })
    })
  }

  /**
   * Call `listener` with the session's state after every change to it, until
   * the session is replaced. Changes that were dropped because their
   * generation is stale are not reported.
   */
  setChangeListener(listener: (state: SessionState) => void): void {
    this.changeListener = listener
  }

  /** The running process's environment without the protected vars. */
  private startingEnv() {
    return Effect.gen({ self: this }, function* () {
      const envService = yield* Environment
      const env = recordToMap(yield* envService.getAll())
      for (const key of this.protectedEnvVars) {
        env.delete(key)
      }
      return env
    })
  }

  private replaceSession(session: Session): void {
    this.session = session
    this.generation++
    this.changeListener = undefined
  }

  private notifyChange(session: Session): void {
    this.changeListener?.({
      env: diffEnv(mapToRecord(session.initialEnv), mapToRecord(session.env)),
      worktrees: [...session.registeredWorkTreePaths],
      activeWorktree: session.activeWorkTreePath,
      executionCount: session.executionCount,
      lastActivity: session.lastActivity,
    })
  }

  /**
   * Return the internal session if it exists.
   * Returns an Effect that succeeds with the session or fails with
   * SessionNotFoundError.
   */
  getSession() {
    return Effect.gen({ self: this }, function* () {
      if (this.session === null) {
        return yield* new SessionNotFoundError()
      }
      return this.session
    })
  }

  /**
   * The current session's generation, bumped by every `createSession`.
   *
   * An operation that writes to the session after an await (an auth handler
   * validating a token, an OAuth poll, a clone) captures this before its
   * first await and passes it to the write. If a different runbook opened in
   * the meantime, the write is dropped instead of landing in that runbook's
   * fresh session: one runbook's credentials or checkout must never become
   * the next one's.
   */
  getGeneration(): number {
    return this.generation
  }

  /** Whether `generation` still names the live session. */
  isCurrentGeneration(generation: number): boolean {
    return this.session !== null && generation === this.generation
  }

  /** A write scoped to `generation` whose session has since been replaced. */
  private isStale(generation: number | undefined): boolean {
    return generation !== undefined && generation !== this.generation
  }

  /**
   * The runbook the current session belongs to, or null if no session exists.
   * Callers use this to detect when a load targets a different runbook than
   * the one the session was created for.
   */
  getRunbookPath(): string | null {
    return this.session?.runbookPath ?? null
  }

  /** Reset the session to the environment it started with. */
  resetSession() {
    return Effect.gen({ self: this }, function* () {
      if (this.session === null) {
        return yield* new SessionNotFoundError()
      }

      this.session.env = copyEnvMap(this.session.initialEnv)
      this.session.lastActivity = new Date()
      this.notifyChange(this.session)
    })
  }

  /**
   * Drop the session, leaving none. The app never does this (opening a
   * runbook replaces the session); tests use it to put the process-wide
   * manager back to its no-session state between cases.
   */
  deleteSession(): void {
    this.session = null
  }

  // -------------------------------------------------------------------------
  // Execution context
  // -------------------------------------------------------------------------

  /**
   * Return a snapshot of the session's env and working directory for a script
   * run. The env is a plain-record copy, safe to use after this call.
   */
  getExecContext(): Effect.Effect<SessionExecSnapshot, SessionNotFoundError, never> {
    return Effect.gen({ self: this }, function* () {
      if (this.session === null) {
        return yield* new SessionNotFoundError()
      }
      return {
        env: mapToRecord(this.session.env),
        workDir: this.session.workingDir,
        generation: this.generation,
      }
    })
  }

  // -------------------------------------------------------------------------
  // Environment management
  // -------------------------------------------------------------------------

  /**
   * Record a script run that ended in success or warn: set the variables it
   * wrote to RUNBOOK_ENV and count the run.
   *
   * No-op when `generation` no longer names the live session (a different
   * runbook opened while the script ran), so one runbook's env can't leak
   * into the next.
   */
  applyScriptEnv(params: { env: Record<string, string>; generation: number }): Effect.Effect<void> {
    return Effect.sync(() => {
      if (this.session === null || !this.isCurrentGeneration(params.generation)) {
        return
      }

      for (const [key, value] of Object.entries(params.env)) {
        this.session.env.set(key, value)
      }
      this.session.executionCount++
      this.session.lastActivity = new Date()
      this.notifyChange(this.session)
    })
  }

  /**
   * Merge additional environment variables into the session without replacing
   * the whole environment. Used by UI components (e.g. AwsAuth) to inject
   * credentials after user confirmation.
   *
   * `generation` (from `getGeneration`, captured before the caller's first
   * await) makes this a no-op once the session it names has been replaced.
   * Omit it only when the write happens in the same tick the request arrived.
   */
  appendToEnv(env: Record<string, string>, generation?: number) {
    return Effect.gen({ self: this }, function* () {
      if (this.session === null) {
        return yield* new SessionError({ message: "no active session" })
      }
      if (this.isStale(generation)) return

      for (const [key, value] of Object.entries(env)) {
        this.session.env.set(key, value)
      }
      this.session.lastActivity = new Date()
      this.notifyChange(this.session)
    })
  }

  /**
   * Remove specific keys from the session env without touching anything else.
   * `appendToEnv` can only ever set a key to SOME value — it cannot express
   * "this credential no longer carries this var." A bridging var like
   * `CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE` needs a real delete: a blank
   * value is not "absent" to every downstream CLI, and leaving the previous
   * value standing after a credential that no longer has one authenticates
   * is exactly the stale-env bug this exists to prevent.
   *
   * `generation` works as for `appendToEnv`.
   */
  removeFromEnv(keys: string[], generation?: number) {
    return Effect.gen({ self: this }, function* () {
      if (this.session === null) {
        return yield* new SessionError({ message: "no active session" })
      }
      if (this.isStale(generation)) return

      for (const key of keys) {
        this.session.env.delete(key)
      }
      this.session.lastActivity = new Date()
      this.notifyChange(this.session)
    })
  }

  /**
   * Add `entries` (directories, such as those on the user's login-shell PATH)
   * to the end of the session's PATH, skipping those already on it. Returns
   * the entries added to the PATH scripts run with.
   *
   * The entries go on the PATH the session started with too. The session is
   * saved as its changes to that env (diffEnv), so adding them to the live
   * PATH alone would save PATH as a change, and resuming the session would
   * keep that PATH instead of the next launch's. Added to both, PATH is saved
   * as a change only if a script changed it.
   *
   * `generation` works as for `appendToEnv`.
   */
  appendToPath(entries: readonly string[], delimiter: string, generation?: number) {
    return Effect.gen({ self: this }, function* () {
      if (this.session === null) {
        return yield* new SessionError({ message: "no active session" })
      }
      if (this.isStale(generation)) return []

      const { initialEnv, env } = this.session
      initialEnv.set(
        "PATH",
        appendPathEntries(initialEnv.get("PATH") ?? "", entries, delimiter).path,
      )
      const { path, added } = appendPathEntries(env.get("PATH") ?? "", entries, delimiter)
      env.set("PATH", path)
      this.session.lastActivity = new Date()
      this.notifyChange(this.session)
      return added
    })
  }

  /**
   * Set `vars` (undefined: unset) as if the session had started with them:
   * in the env it started from, and in its live env wherever a script hasn't
   * changed them. For a setting the app hands to every process it runs, such
   * as the custom CA's bundle vars, changed mid-session. As for appendToPath,
   * changing the starting env too keeps them out of the session's saved
   * changes; a value a script set stays.
   */
  setStartingEnv(vars: Readonly<Record<string, string | undefined>>) {
    return Effect.gen({ self: this }, function* () {
      if (this.session === null) {
        return yield* new SessionError({ message: "no active session" })
      }

      const { initialEnv, env } = this.session
      const put = (map: Map<string, string>, key: string, value: string | undefined) => {
        if (value === undefined) map.delete(key)
        else map.set(key, value)
      }
      for (const [key, value] of Object.entries(vars)) {
        const scriptChanged = env.get(key) !== initialEnv.get(key)
        put(initialEnv, key, value)
        if (!scriptChanged) put(env, key, value)
      }
      this.notifyChange(this.session)
    })
  }

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------

  /**
   * Return the public-safe metadata for the current session.
   */
  getMetadata() {
    return Effect.gen({ self: this }, function* () {
      if (this.session === null) {
        return yield* new SessionNotFoundError()
      }

      const meta: SessionMetadata = {
        workingDir: this.session.workingDir,
        executionCount: this.session.executionCount,
        createdAt: this.session.createdAt.toISOString(),
        lastActivity: this.session.lastActivity.toISOString(),
      }

      return meta
    })
  }

  // -------------------------------------------------------------------------
  // Worktree management
  // -------------------------------------------------------------------------

  /**
   * Register a git worktree path. No-op if already registered, or if
   * `generation` (as for `appendToEnv`) names a replaced session.
   */
  registerWorkTreePath(path: string, generation?: number): void {
    if (this.session === null || this.isStale(generation)) return

    if (!this.session.registeredWorkTreePaths.includes(path)) {
      this.session.registeredWorkTreePaths.push(path)
      this.notifyChange(this.session)
    }
  }

  /**
   * Set the explicitly selected active worktree path (user switches in UI).
   * No-op if `generation` (as for `appendToEnv`) names a replaced session.
   */
  setActiveWorkTreePath(path: string, generation?: number): void {
    if (this.session === null || this.isStale(generation)) return
    this.session.activeWorkTreePath = path
    this.notifyChange(this.session)
  }

  /**
   * Return the active worktree path for REPO_FILES injection and
   * target="worktree" template writes. Prefers the explicitly selected
   * worktree, falling back to the last registered one.
   * Returns empty string if no worktrees are registered.
   */
  getActiveWorkTreePath(): string {
    if (this.session === null || this.session.registeredWorkTreePaths.length === 0) {
      return ""
    }

    if (this.session.activeWorkTreePath !== "") {
      return this.session.activeWorkTreePath
    }

    return this.session.registeredWorkTreePaths.at(-1)!
  }
}
