import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect } from "effect"
import { sessionToResume } from "./launch-session.ts"
import { SessionManager } from "../../src/domain/session/manager.ts"
import { SessionPersistence } from "../../src/domain/session/persistence.ts"
import { SessionStore, type SessionRecord } from "../../src/domain/session/store.ts"
import { openSqliteDatabase } from "../../src/layers/NodeSqlite.ts"

describe("sessionToResume", () => {
  let tmp: string
  let store: SessionStore
  let persistence: SessionPersistence

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-launch-session-"))
    store = Effect.runSync(SessionStore.open(openSqliteDatabase(":memory:")))
    persistence = new SessionPersistence({
      store,
      manager: new SessionManager(),
      dirsRoot: path.join(tmp, "dirs"),
      cipher: { encrypt: () => undefined, decrypt: () => undefined },
      ephemeralFileEnvVars: [],
      random: () => Math.random(),
      onSaveError: () => {},
    })
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  /** Save a session for a runbook file that exists unless `path` says otherwise. */
  function saveSession(overrides: Partial<SessionRecord> & { id: string }): SessionRecord {
    const runbook = path.join(tmp, `${overrides.id}.mdx`)
    fs.writeFileSync(runbook, "# Runbook\n")
    const session: SessionRecord = {
      name: `name-of-${overrides.id}`,
      path: runbook,
      remoteSource: undefined,
      dir: path.join(tmp, "dirs", overrides.id),
      workingDir: path.join(tmp, "dirs", overrides.id),
      launchDir: undefined,
      env: undefined,
      worktrees: [],
      activeWorktree: "",
      executionCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastLaunchedAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: "2026-01-01T00:00:00.000Z",
      vcsBindings: {},
      ...overrides,
    }
    Effect.runSync(store.insert(session))
    return session
  }

  it("is undefined when no session was ever saved", () => {
    expect(sessionToResume(persistence, undefined)).toBeUndefined()
    expect(sessionToResume(persistence, "/home/me/project")).toBeUndefined()
  })

  it("is the session last launched from the directory, even when another is more recent", () => {
    saveSession({ id: "here", launchDir: "/home/me/project" })
    saveSession({
      id: "elsewhere",
      launchDir: "/other",
      lastLaunchedAt: "2026-02-01T00:00:00.000Z",
    })

    expect(sessionToResume(persistence, "/home/me/project")?.id).toBe("here")
  })

  it("is undefined for a directory no session was launched from", () => {
    saveSession({ id: "elsewhere", launchDir: "/other" })

    expect(sessionToResume(persistence, "/home/me/project")).toBeUndefined()
  })

  it("is the most recent session of all for a launch with no directory", () => {
    saveSession({ id: "older", launchDir: "/a" })
    saveSession({ id: "newer", launchDir: "/b", lastLaunchedAt: "2026-02-01T00:00:00.000Z" })

    expect(sessionToResume(persistence, undefined)?.id).toBe("newer")
  })

  it("is undefined when the session's runbook file was deleted", () => {
    saveSession({ id: "gone", path: path.join(tmp, "deleted", "runbook.mdx") })

    expect(sessionToResume(persistence, undefined)).toBeUndefined()
  })

  it("is a remote runbook's session although its last clone is gone", () => {
    saveSession({
      id: "remote",
      path: path.join(tmp, "deleted-clone", "runbook.mdx"),
      remoteSource: "https://github.com/acme/runbooks//deploy",
    })

    expect(sessionToResume(persistence, undefined)?.id).toBe("remote")
  })

  it("is undefined when the database can't be read", () => {
    saveSession({ id: "s1" })
    Effect.runSync(store.close())

    expect(sessionToResume(persistence, undefined)).toBeUndefined()
  })
})
