/**
 * A SessionManager manages a single session with multiple tokens (max 20) for
 * concurrent browser tabs. Environment changes made by scripts persist across
 * block executions. All browser tabs share the same session ("one runbook = one
 * environment"), each identified by its own token.
 */

import { Effect } from "effect"

import { Environment } from "../../services/Environment.js"
import { SessionError, SessionNotFoundError } from "../../errors/index.js"
import {
  type SessionMetadata,
  type SessionExecContext,
  MAX_TOKENS_PER_SESSION,
} from "../../types.js"

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
  validTokens: Map<string, Date>
  env: Map<string, string>
  initialEnv: Map<string, string>
  initialWorkDir: string
  workingDir: string
  executionCount: number
  createdAt: Date
  lastActivity: Date
  registeredWorkTreePaths: string[]
  activeWorkTreePath: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a cryptographically-secure token via the Web Crypto global. */
function generateSecretToken(): string {
  return crypto.randomUUID()
}

function copyEnvMap(src: Map<string, string>): Map<string, string> {
  return new Map(src)
}

function recordToMap(rec: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(rec))
}

function mapToRecord(m: Map<string, string>): Record<string, string> {
  const rec: Record<string, string> = {}
  for (const [k, v] of m) {
    rec[k] = v
  }
  return rec
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
   * Create a new session, replacing any existing one (all previous tokens are
   * invalidated). The environment is captured from the running process via the
   * Environment service, with protected vars stripped.
   */
  createSession(initialWorkingDir: string) {
    return Effect.gen(this, function* () {
      const envService = yield* Environment

      const envRecord = yield* envService.getAll()
      const env = recordToMap(envRecord)

      // Strip protected env vars
      for (const key of this.protectedEnvVars) {
        env.delete(key)
      }

      const token = generateSecretToken()
      const now = new Date()

      const session: Session = {
        validTokens: new Map([[token, now]]),
        env,
        initialEnv: copyEnvMap(env),
        initialWorkDir: initialWorkingDir,
        workingDir: initialWorkingDir,
        executionCount: 0,
        createdAt: now,
        lastActivity: now,
        registeredWorkTreePaths: [],
        activeWorkTreePath: "",
      }

      this.session = session

      return { token }
    })
  }

  /**
   * Create a new token for an existing session (new browser tab joining).
   * Preserves the session's current environment state.
   */
  joinSession() {
    return Effect.gen(this, function* () {
      if (this.session === null) {
        return yield* new SessionNotFoundError()
      }

      const token = generateSecretToken()

      // Prune oldest token if at capacity
      if (this.session.validTokens.size >= MAX_TOKENS_PER_SESSION) {
        this.pruneOldestToken()
      }

      const now = new Date()
      this.session.validTokens.set(token, now)
      this.session.lastActivity = now

      return { token }
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

  /** Returns whether a session currently exists. */
  hasSession(): boolean {
    return this.session !== null
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

  /**
   * Delete the session, invalidating all tokens.
   */
  deleteSession(): void {
    this.session = null
  }

  // -------------------------------------------------------------------------
  // Token management
  // -------------------------------------------------------------------------

  /**
   * Validate a token and return an immutable execution context snapshot.
   * Returns `null` if the token is invalid or no session exists.
   */
  validateToken(
    token: string,
  ): Effect.Effect<SessionExecContext | null, never, never> {
    return Effect.sync(() => {
      if (this.session === null) {
        return null
      }

      if (!this.session.validTokens.has(token)) {
        return null
      }

      // Return a snapshot — env as a plain record, safe to use after this call
      return {
        env: mapToRecord(this.session.env),
        workDir: this.session.workingDir,
      }
    })
  }

  /**
   * Get the current execution context without token validation.
   * Used by IPC handlers where authentication is unnecessary (process-local).
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

  /**
   * Remove a specific token from the session (tab close cleanup).
   * Returns true if the token was found and removed.
   */
  revokeToken(token: string): boolean {
    if (this.session === null) {
      return false
    }

    if (this.session.validTokens.has(token)) {
      this.session.validTokens.delete(token)
      return true
    }

    return false
  }

  /** Number of active tokens (browser tabs). */
  tokenCount(): number {
    return this.session?.validTokens.size ?? 0
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
        activeTabs: this.session.validTokens.size,
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

    // Fall back to last registered
    return this.session.registeredWorkTreePaths[
      this.session.registeredWorkTreePaths.length - 1
    ]
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Remove the oldest token to make room for a new one. */
  private pruneOldestToken(): void {
    if (this.session === null) return

    let oldestToken: string | null = null
    let oldestTime: Date | null = null

    for (const [token, created] of this.session.validTokens) {
      if (oldestTime === null || created < oldestTime) {
        oldestToken = token
        oldestTime = created
      }
    }

    if (oldestToken !== null) {
      this.session.validTokens.delete(oldestToken)
    }
  }
}
