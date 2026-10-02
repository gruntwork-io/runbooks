/**
 * Starts the session for a runbook load and keeps it saved.
 *
 * Every session has a row in the sessions database (store.ts) and a directory
 * of its own under `dirsRoot`. That directory is where the session's scripts
 * start, where GitClone blocks clone to, and where generated files are
 * written. Opening a runbook resumes its most recently launched session, or
 * creates one when it has none.
 */
import path from "node:path"
import { Cause, Effect } from "effect"
import { FileSystem } from "../../services/FileSystem.ts"
import type { SessionManager, EnvChanges, SessionState } from "./manager.ts"
import { sessionNameCandidates } from "./names.ts"
import type { RunbookSource, SessionRecord, SessionStore } from "./store.ts"

/**
 * Encrypts the session env for the database. The env holds whatever the
 * session's auth blocks and scripts exported, including cloud credentials.
 */
export interface SessionCipher {
  /** Undefined when the OS offers no encryption; the env is then not saved. */
  encrypt(plaintext: string): Uint8Array | undefined
  /** Undefined when `ciphertext` can't be decrypted, e.g. the OS key changed. */
  decrypt(ciphertext: Uint8Array): string | undefined
}

export interface SessionPersistenceOptions {
  store: SessionStore
  manager: SessionManager
  /** The directory that has one subdirectory per session. */
  dirsRoot: string
  cipher: SessionCipher
  /**
   * Env vars that name a file the app deletes when it quits (a Google
   * credential file). A resumed session drops the ones whose file is gone:
   * Google client libraries fail on a credentials path that doesn't exist.
   */
  ephemeralFileEnvVars: readonly string[]
  /** Reports a failed save. The session keeps running without it. */
  onSaveError: (err: unknown) => void
  /** Picks the words of a new session's name. Returns a number in [0, 1), like Math.random. */
  random: () => number
}

export interface OpenSessionRequest {
  runbook: RunbookSource
  /** The directory `runbooks` was run from, when this load came from the command line. */
  launchDir: string | undefined
  /** Resume this session instead of the runbook's most recent one. */
  sessionId: string | undefined
  /** Start a new session even if the runbook already has one. */
  startNew: boolean
}

export interface OpenedSession {
  id: string
  /** What the app shows the session as, e.g. `elegant-elephant`. */
  name: string
  dir: string
}

export class SessionPersistence {
  private current: OpenedSession | undefined

  constructor(private readonly options: SessionPersistenceOptions) {}

  /** The session `open` last started. */
  currentSession(): OpenedSession | undefined {
    return this.current
  }

  /**
   * The session a launch that names no runbook should resume: the one most
   * recently launched from `launchDir`, or the most recent of all when the
   * launch has no directory (the dock, a file manager).
   */
  findForLaunch(launchDir: string | undefined) {
    return launchDir === undefined
      ? this.options.store.latest()
      : this.options.store.latestForLaunchDir(launchDir)
  }

  /**
   * Replace the manager's session with the one `request` asks for, resumed
   * from the database or newly created, and save every later change to it.
   */
  open(request: OpenSessionRequest) {
    return Effect.gen(this, function* () {
      const { store, manager } = this.options
      const saved = yield* this.findSaved(request)
      const now = new Date()

      let opened: OpenedSession
      if (saved === undefined) {
        // A new session started from the menu was not launched from anywhere:
        // it takes over the launch directory of the session it replaces, so
        // `runbooks` run there resumes it.
        const replaced =
          request.launchDir === undefined && this.current !== undefined
            ? yield* store.get(this.current.id)
            : undefined
        const id = newSessionId()
        const dir = yield* this.ensureDir(path.join(this.options.dirsRoot, id))
        const name = yield* this.newName(id)
        yield* store.insert({
          id,
          name,
          path: request.runbook.path,
          remoteSource: request.runbook.remoteSource,
          dir,
          workingDir: dir,
          launchDir: request.launchDir ?? replaced?.launchDir,
          env: undefined,
          worktrees: [],
          activeWorktree: "",
          executionCount: 0,
          createdAt: now.toISOString(),
          lastLaunchedAt: now.toISOString(),
          lastActivityAt: now.toISOString(),
        })
        yield* manager.createSession(dir, request.runbook.path)
        opened = { id, name, dir }
      } else {
        const dir = yield* this.ensureDir(saved.dir)
        yield* manager.resumeSession({
          initialWorkingDir: dir,
          runbookPath: request.runbook.path,
          createdAt: new Date(saved.createdAt),
          state: yield* this.restoreState(saved, dir),
        })
        yield* store.markLaunched(saved.id, {
          at: now.toISOString(),
          runbookPath: request.runbook.path,
          launchDir: request.launchDir,
        })
        opened = { id: saved.id, name: saved.name, dir }
      }

      this.current = opened
      manager.setChangeListener((state) => {
        this.save(opened.id, state)
      })
      return opened
    })
  }

  /**
   * Record that the current session's runbook was launched again while it
   * was open. An undefined `launchDir` keeps the one already recorded.
   */
  recordLaunch(runbookPath: string, launchDir: string | undefined) {
    if (this.current === undefined) return Effect.void
    return this.options.store.markLaunched(this.current.id, {
      at: new Date().toISOString(),
      runbookPath,
      launchDir,
    })
  }

  /**
   * A name no other session has: the first free one of sessionNameCandidates.
   * Its last candidate ends in `id`, which is this session's alone, so the
   * list never runs out.
   */
  private newName(id: string) {
    return Effect.gen(this, function* () {
      const candidates = sessionNameCandidates(this.options.random, id)
      for (const candidate of candidates) {
        if (!(yield* this.options.store.isNameTaken(candidate))) return candidate
      }
      return candidates.at(-1)!
    })
  }

  private findSaved(request: OpenSessionRequest) {
    return Effect.gen(this, function* () {
      if (request.startNew) return undefined
      if (request.sessionId !== undefined) {
        const session = yield* this.options.store.get(request.sessionId)
        if (session !== undefined) return session
      }
      return yield* this.options.store.latestForRunbook(request.runbook)
    })
  }

  /**
   * The saved state with everything that has since disappeared from disk
   * removed: a deleted working directory falls back to the session's
   * directory, and deleted worktrees are dropped.
   */
  private restoreState(saved: SessionRecord, dir: string) {
    return Effect.gen(this, function* () {
      const worktrees: string[] = []
      for (const worktree of saved.worktrees) {
        if (yield* isDirectory(worktree)) worktrees.push(worktree)
      }
      const state: SessionState = {
        workingDir: (yield* isDirectory(saved.workingDir)) ? saved.workingDir : dir,
        env: yield* this.restoreEnv(saved.env),
        worktrees,
        activeWorktree: worktrees.includes(saved.activeWorktree) ? saved.activeWorktree : "",
        executionCount: saved.executionCount,
        lastActivity: new Date(saved.lastActivityAt),
      }
      return state
    })
  }

  private restoreEnv(encrypted: Uint8Array | undefined) {
    return Effect.gen(this, function* () {
      const env = this.decryptEnv(encrypted)
      const fs = yield* FileSystem
      for (const name of this.options.ephemeralFileEnvVars) {
        const file = env.set[name]
        if (file !== undefined && !(yield* fs.exists(file))) {
          delete env.set[name]
        }
      }
      return env
    })
  }

  /** The saved env changes, or none when they are missing or unreadable. */
  private decryptEnv(encrypted: Uint8Array | undefined): EnvChanges {
    const none: EnvChanges = { set: {}, unset: [] }
    if (encrypted === undefined) return none
    const plaintext = this.options.cipher.decrypt(encrypted)
    if (plaintext === undefined) return none
    let parsed: unknown
    try {
      parsed = JSON.parse(plaintext)
    } catch {
      return none
    }
    return isEnvChanges(parsed) ? parsed : none
  }

  /**
   * Write `state` to the database. Never throws: the caller is the block or
   * script that changed the session, and it must not fail because the change
   * could not be saved (a full disk, a denied Keychain prompt).
   */
  private save(id: string, state: SessionState): void {
    const { store, cipher, onSaveError } = this.options
    const saved = Effect.suspend(() =>
      store.saveState(id, {
        workingDir: state.workingDir,
        env: cipher.encrypt(JSON.stringify(state.env)),
        worktrees: state.worktrees,
        activeWorktree: state.activeWorktree,
        executionCount: state.executionCount,
        lastActivityAt: state.lastActivity.toISOString(),
      }),
    )
    Effect.runSync(
      saved.pipe(
        Effect.catchAllCause((cause) => Effect.sync(() => onSaveError(Cause.squash(cause)))),
      ),
    )
  }

  /**
   * Create `dir` if it is missing (a new session, or a saved one whose
   * directory was deleted) and return its real path, which is what the
   * containment checks on session paths compare against.
   */
  private ensureDir(dir: string) {
    return Effect.gen(function* () {
      const fs = yield* FileSystem
      yield* fs.mkdir(dir, { recursive: true })
      return yield* fs.realpath(dir)
    })
  }
}

// 64 random bits. The id is a directory name under every path a session's
// scripts see, and Windows caps paths at 260 characters.
function newSessionId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 16)
}

function isDirectory(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem
    return yield* fs.stat(dir).pipe(
      Effect.map((stat) => stat.isDirectory),
      Effect.catchAll(() => Effect.succeed(false)),
    )
  })
}

function isEnvChanges(value: unknown): value is EnvChanges {
  if (typeof value !== "object" || value === null) return false
  const { set, unset } = value as { set?: unknown; unset?: unknown }
  return (
    typeof set === "object" &&
    set !== null &&
    Object.values(set).every((v) => typeof v === "string") &&
    Array.isArray(unset) &&
    unset.every((key) => typeof key === "string")
  )
}
