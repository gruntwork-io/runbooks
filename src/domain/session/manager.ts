/**
 * A SessionManager holds the single, process-local session for the open
 * runbook ("one runbook = one environment"). Environment and working-directory
 * changes made by scripts persist across block executions.
 */

import { Effect } from "effect"

import { Environment } from "../../services/Environment.js"
import { SessionError, SessionNotFoundError } from "../../errors/index.js"
import type { SessionMetadata, SessionExecContext } from "../../types.js"

// ---------------------------------------------------------------------------
// Excluded env vars — shell internals that should never be captured
// ---------------------------------------------------------------------------

const EXCLUDED_ENV_VARS = new Set<string>([
  "_",
  "SHLVL",
  "RUNBOOK_OUTPUT",
  "GENERATED_FILES",
  "REPO_FILES",
  "OLDPWD",
  "FUNCNAME",
  "LINENO",
  "RANDOM",
  "SECONDS",
  "EPOCHSECONDS",
  "EPOCHREALTIME",
  "BASHPID",
  "BASH_COMMAND",
  "BASH_SUBSHELL",
  "BASH_EXECUTION_STRING",
  "PPID",
  "BASH_LINENO",
  "BASH_SOURCE",
  "BASH_ARGC",
  "BASH_ARGV",
  "BASH_REMATCH",
  "PIPESTATUS",
  "HISTCMD",
  "SRANDOM",
  // Internal wrapper variables
  "__RUNBOOKS_ENV_CAPTURE_PATH",
  "__RUNBOOKS_PWD_CAPTURE_PATH",
  "__RUNBOOKS_USER_EXIT_HANDLER",
  "__RUNBOOKS_COMBINED_EXIT",
  "_RUNBOOKS_LOGGING_LOADED",
])

// ---------------------------------------------------------------------------
// Internal session state
// ---------------------------------------------------------------------------

interface Session {
  env: Map<string, string>
  initialEnv: Map<string, string>
  initialWorkDir: string
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
 * Filter out shell-internal variables from a captured environment.
 * Mirrors `FilterCapturedEnv` in Go.
 */
export function filterCapturedEnv(
  env: Record<string, string>,
): Record<string, string> {
  const filtered: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (EXCLUDED_ENV_VARS.has(k)) continue
    if (k.startsWith("BASH_")) continue
    filtered[k] = v
  }
  return filtered
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

export class SessionManager {
  private session: Session | null = null
  private protectedEnvVars: string[] = []

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  /**
   * Configure environment variables that should be stripped from the session at
   * creation time (e.g. AWS credentials that require explicit auth).
   * Must be called before `createSession`.
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
   * protected vars stripped.
   */
  createSession(initialWorkingDir: string, runbookPath: string = "") {
    return Effect.gen(this, function* () {
      const envService = yield* Environment

      const envRecord = yield* envService.getAll()
      const env = recordToMap(envRecord)

      // Strip protected env vars
      for (const key of this.protectedEnvVars) {
        env.delete(key)
      }

      const now = new Date()

      const session: Session = {
        env,
        initialEnv: copyEnvMap(env),
        initialWorkDir: initialWorkingDir,
        workingDir: initialWorkingDir,
        executionCount: 0,
        createdAt: now,
        lastActivity: now,
        registeredWorkTreePaths: [],
        activeWorkTreePath: "",
        runbookPath,
      }

      this.session = session
    })
  }

  /**
   * Return the internal session if it exists.
   * Returns an Effect that succeeds with the session or fails with
   * SessionNotFoundError.
   */
  getSession() {
    return Effect.gen(this, function* () {
      if (this.session === null) {
        return yield* new SessionNotFoundError()
      }
      return this.session
    })
  }

  /**
   * The runbook the current session belongs to, or null if no session exists.
   * Callers use this to detect when a load targets a different runbook than
   * the one the session was created for.
   */
  getRunbookPath(): string | null {
    return this.session?.runbookPath ?? null
  }

  /**
   * Update the session's working directory.
   * Called when the runbook loads and we know the actual path.
   */
  setWorkingDir(dir: string): void {
    if (this.session) {
      this.session.workingDir = dir
      this.session.initialWorkDir = dir
    }
  }

  /**
   * Reset the session to its initial environment and working directory.
   */
  resetSession() {
    return Effect.gen(this, function* () {
      if (this.session === null) {
        return yield* new SessionNotFoundError()
      }

      this.session.env = copyEnvMap(this.session.initialEnv)
      this.session.workingDir = this.session.initialWorkDir
      this.session.lastActivity = new Date()
    })
  }

  // -------------------------------------------------------------------------
  // Execution context
  // -------------------------------------------------------------------------

  /**
   * Return a snapshot of the session's env and working directory for a script
   * run. The env is a plain-record copy, safe to use after this call.
   */
  getExecContext(): Effect.Effect<SessionExecContext, SessionNotFoundError, never> {
    return Effect.gen(this, function* () {
      if (this.session === null) {
        return yield* new SessionNotFoundError()
      }
      return {
        env: mapToRecord(this.session.env),
        workDir: this.session.workingDir,
      }
    })
  }

  // -------------------------------------------------------------------------
  // Environment management
  // -------------------------------------------------------------------------

  /**
   * Replace the session's environment and working directory after script
   * execution, incrementing the execution counter.
   */
  updateSessionEnv(env: Record<string, string>, workDir: string) {
    return Effect.gen(this, function* () {
      if (this.session === null) {
        return yield* new SessionError({ message: "no active session" })
      }

      this.session.env = recordToMap(env)
      this.session.workingDir = workDir
      this.session.executionCount++
      this.session.lastActivity = new Date()
    })
  }

  /**
   * Merge additional environment variables into the session without replacing
   * the whole environment. Used by UI components (e.g. AwsAuth) to inject
   * credentials after user confirmation.
   */
  appendToEnv(env: Record<string, string>) {
    return Effect.gen(this, function* () {
      if (this.session === null) {
        return yield* new SessionError({ message: "no active session" })
      }

      for (const [key, value] of Object.entries(env)) {
        this.session.env.set(key, value)
      }
      this.session.lastActivity = new Date()
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
   */
  removeFromEnv(keys: string[]) {
    return Effect.gen(this, function* () {
      if (this.session === null) {
        return yield* new SessionError({ message: "no active session" })
      }

      for (const key of keys) {
        this.session.env.delete(key)
      }
      this.session.lastActivity = new Date()
    })
  }

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------

  /**
   * Return the public-safe metadata for the current session.
   */
  getMetadata() {
    return Effect.gen(this, function* () {
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
   * Register a git worktree path. No-op if already registered.
   */
  registerWorkTreePath(path: string): void {
    if (this.session === null) return

    if (!this.session.registeredWorkTreePaths.includes(path)) {
      this.session.registeredWorkTreePaths.push(path)
    }
  }

  /**
   * Set the explicitly selected active worktree path (user switches in UI).
   */
  setActiveWorkTreePath(path: string): void {
    if (this.session === null) return
    this.session.activeWorkTreePath = path
  }

  /**
   * Return the active worktree path for REPO_FILES injection and
   * target="worktree" template writes. Prefers the explicitly selected
   * worktree, falling back to the last registered one.
   * Returns empty string if no worktrees are registered.
   */
  getActiveWorkTreePath(): string {
    if (
      this.session === null ||
      this.session.registeredWorkTreePaths.length === 0
    ) {
      return ""
    }

    if (this.session.activeWorkTreePath !== "") {
      return this.session.activeWorkTreePath
    }

    return this.session.registeredWorkTreePaths.at(-1)!
  }
}
