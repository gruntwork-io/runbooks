/**
 * Starts the session for a runbook load and keeps it saved.
 *
 * Every session has a row in the sessions database (store.ts) and a directory
 * of its own under `dirsRoot`. That directory is where the session's scripts
 * start, where GitClone blocks clone to, and where generated files are
 * written. Opening a runbook resumes its most recently launched session, or
 * creates one when it has none.
 */
import { randomUUIDv7 } from "node:crypto"
import path from "node:path"
import { Cause, Effect } from "effect"
import { SessionDeleteError, SessionNameError, SessionNotFoundError } from "../../errors/index.ts"
import { FileSystem } from "../../services/FileSystem.ts"
import {
  isSessionEventKind,
  parseSessionEvent,
  replacesPreviousEvent,
  type SavedBlockState,
  type SessionEventRequest,
} from "./history.ts"
import type { SessionManager, EnvChanges, SessionState } from "./manager.ts"
import { sessionNameCandidates, sessionNameProblem } from "./names.ts"
import type {
  ListedSession,
  RunbookSource,
  SessionRecord,
  SessionStore,
  VcsBindings,
} from "./store.ts"

/** The most sessions listSessions returns: the most recently used ones. */
const MAX_LISTED_SESSIONS = 500

/**
 * Encrypts the session env and the payloads of the session's history for the
 * database. The env holds whatever the session's auth blocks and scripts
 * exported, including cloud credentials, and the history holds what the user
 * typed into forms and what scripts printed.
 */
export interface SessionCipher {
  /** Undefined when the OS offers no encryption; the plaintext is then not saved. */
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
  /** The git host bindings of the session's credentials, as saved with it */
  vcsBindings: VcsBindings
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

  /** The saved session with this id, or undefined when there is none. */
  findSession(id: string) {
    return this.options.store.get(id)
  }

  /** The most recently used saved sessions, at most MAX_LISTED_SESSIONS, most recent first. */
  listSessions() {
    return Effect.gen(this, function* () {
      const fs = yield* FileSystem
      const listed: ListedSession[] = []
      for (const session of yield* this.options.store.list(MAX_LISTED_SESSIONS)) {
        listed.push({
          ...session,
          isCurrent: session.id === this.current?.id,
          runbookMissing: session.remoteSource === undefined && !(yield* fs.exists(session.path)),
        })
      }
      return listed
    })
  }

  /**
   * Delete a saved session: its row, its history, and its directory with the
   * files its blocks wrote and the repositories they cloned. A directory that
   * is not the session's own one under `dirsRoot` is left alone. Deleting a
   * session that does not exist does nothing.
   *
   * Fails with a SessionDeleteError for the current session, whose scripts may
   * be running in that directory.
   */
  deleteSession(id: string) {
    return Effect.gen(this, function* () {
      if (id === this.current?.id) {
        return yield* new SessionDeleteError({
          message: "This session is open. Switch to another session before deleting it.",
        })
      }
      const saved = yield* this.options.store.get(id)
      if (saved === undefined) return
      yield* this.options.store.delete(id)
      const fs = yield* FileSystem
      const root = yield* fs.realpath(this.options.dirsRoot).pipe(Effect.option)
      // The path comes from the database: remove it only where a session's
      // directory would be.
      if (root._tag === "None" || saved.dir !== path.join(root.value, saved.id)) return
      yield* fs.rm(saved.dir, { recursive: true, force: true })
    })
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
        // A version 7 UUID starts with its creation time, so session
        // directories, which are named after their ids, sort by age.
        const id = randomUUIDv7()
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
          vcsBindings: {},
        })
        yield* manager.createSession(dir, request.runbook.path)
        opened = { id, name, dir, vcsBindings: {} }
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
        opened = { id: saved.id, name: saved.name, dir, vcsBindings: saved.vcsBindings }
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
   * Rename the current session and return its new name, which is `requested`
   * without the whitespace around it.
   *
   * Fails with a SessionNameError when the name breaks the rules of
   * sessionNameProblem or another session has it, and with a
   * SessionNotFoundError when no session is open.
   */
  renameCurrent(requested: string) {
    return Effect.gen(this, function* () {
      const current = this.current
      if (current === undefined) return yield* new SessionNotFoundError()

      const name = requested.trim()
      if (name === current.name) return name
      const problem = sessionNameProblem(name)
      if (problem !== undefined) return yield* new SessionNameError({ message: problem })
      if (yield* this.options.store.isNameTaken(name)) {
        return yield* new SessionNameError({
          message: `Another session is already named ${name}.`,
        })
      }

      yield* this.options.store.rename(current.id, name)
      this.current = { ...current, name }
      return name
    })
  }

  /**
   * Save the git host bindings of the current session's credentials, so a
   * resumed session releases each credential only to its host again. Never
   * throws: a failed save is reported to `onSaveError` (see save).
   */
  saveVcsBindings(bindings: VcsBindings): void {
    const current = this.current
    if (current === undefined) return
    this.current = { ...current, vcsBindings: bindings }
    Effect.runSync(
      this.options.store
        .saveVcsBindings(current.id, bindings)
        .pipe(
          Effect.catchAllCause((cause) =>
            Effect.sync(() => this.options.onSaveError(Cause.squash(cause))),
          ),
        ),
    )
  }

  /**
   * Add what the user did to a block to the history of session `sessionId`.
   *
   * The event is dropped when that session is not the current one (a block
   * of a session that has since been replaced reported it) or when the
   * payload can't be encrypted: it holds what the user typed and what scripts
   * printed, either of which can be a credential. A failed save is reported
   * to `onSaveError` and does not fail the block (see save).
   *
   * Fails with a SessionEventError when `request` is not an event
   * (parseSessionEvent).
   */
  recordEvent(sessionId: string, request: SessionEventRequest) {
    return Effect.gen(this, function* () {
      const event = yield* parseSessionEvent(request)
      if (this.current?.id !== sessionId) return
      const { store, cipher, onSaveError } = this.options

      const saved = Effect.suspend(() => {
        const payload = cipher.encrypt(event.payload)
        if (payload === undefined) return Effect.void
        return store.appendEvent(
          {
            sessionId,
            at: new Date().toISOString(),
            blockId: event.blockId,
            kind: event.kind,
            payload,
          },
          { replacePrevious: replacesPreviousEvent(event.kind) },
        )
      })
      yield* saved.pipe(
        Effect.catchAllCause((cause) => Effect.sync(() => onSaveError(Cause.squash(cause)))),
      )
    })
  }

  /**
   * What each block of the current session was left as: the payload of its
   * latest event of each kind. An event that can't be decrypted or parsed is
   * left out, and its block starts over.
   */
  blockStates() {
    return Effect.gen(this, function* () {
      const states: SavedBlockState[] = []
      if (this.current === undefined) return states
      for (const event of yield* this.options.store.latestEvents(this.current.id)) {
        // A newer version of the app wrote a kind this one doesn't know.
        if (!isSessionEventKind(event.kind)) continue
        const payload = this.decryptJson(event.payload)
        if (payload === undefined) continue
        states.push({ blockId: event.blockId, kind: event.kind, payload })
      }
      return states
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
    const parsed = this.decryptJson(encrypted)
    return isEnvChanges(parsed) ? parsed : none
  }

  /** The JSON value `encrypted` holds, or undefined when it can't be decrypted or parsed. */
  private decryptJson(encrypted: Uint8Array): unknown {
    const plaintext = this.options.cipher.decrypt(encrypted)
    if (plaintext === undefined) return undefined
    try {
      return JSON.parse(plaintext)
    } catch {
      return undefined
    }
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
