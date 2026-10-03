import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect } from "effect"
import { planSecondLaunch, planStartupLaunch, sessionToResume } from "./launch-session.ts"
import { SessionManager } from "../../src/domain/session/manager.ts"
import { SessionPersistence } from "../../src/domain/session/persistence.ts"
import { SessionStore, type SessionRecord } from "../../src/domain/session/store.ts"
import { openSqliteDatabase } from "../../src/layers/NodeSqlite.ts"

describe("launch-session", () => {
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
      moveToTrash: async () => {},
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
      finishedAt: undefined,
      ...overrides,
    }
    Effect.runSync(store.insert(session))
    return session
  }

  const NO_ARGS = { runbookPath: null, remoteUrl: null }
  const URL = "https://github.com/acme/runbooks//deploy"

  describe("sessionToResume", () => {
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
        remoteSource: URL,
      })

      expect(sessionToResume(persistence, undefined)?.id).toBe("remote")
    })

    it("is undefined when the database can't be read", () => {
      saveSession({ id: "s1" })
      Effect.runSync(store.close())

      expect(sessionToResume(persistence, undefined)).toBeUndefined()
    })
  })

  describe("planStartupLaunch", () => {
    it("opens the runbook the command line names, as a new launch of it", () => {
      saveSession({ id: "saved", launchDir: "/home/me/project" })

      expect(
        planStartupLaunch(
          persistence,
          { runbookPath: "/repo/runbook.mdx", remoteUrl: null },
          "/home/me/project",
          null,
        ),
      ).toEqual({
        launch: {
          source: "/repo/runbook.mdx",
          launchDir: "/home/me/project",
          sessionId: undefined,
        },
        open: { path: "/repo/runbook.mdx" },
      })
    })

    it("opens the remote runbook the command line names", () => {
      expect(
        planStartupLaunch(persistence, { runbookPath: null, remoteUrl: URL }, undefined, null),
      ).toEqual({
        launch: { source: URL, launchDir: undefined, sessionId: undefined },
        open: { remoteUrl: URL },
      })
    })

    it("resumes the session last launched from the directory when the command line names none", () => {
      const saved = saveSession({ id: "here", launchDir: "/home/me/project" })

      expect(planStartupLaunch(persistence, NO_ARGS, "/home/me/project", null)).toEqual({
        launch: { source: saved.path, launchDir: "/home/me/project", sessionId: "here" },
        open: { path: saved.path },
      })
    })

    it("resumes the most recent session of all for a launch from the dock", () => {
      const saved = saveSession({ id: "latest", launchDir: "/a" })

      expect(planStartupLaunch(persistence, NO_ARGS, undefined, null)).toEqual({
        launch: { source: saved.path, launchDir: undefined, sessionId: "latest" },
        open: { path: saved.path },
      })
    })

    it("clones a resumed remote runbook again, by its URL", () => {
      saveSession({ id: "remote", remoteSource: URL, launchDir: "/a" })

      expect(planStartupLaunch(persistence, NO_ARGS, "/a", null)).toEqual({
        launch: { source: URL, launchDir: "/a", sessionId: "remote" },
        open: { remoteUrl: URL },
      })
    })

    it("opens the runbook double-clicked in a file manager instead of resuming", () => {
      saveSession({ id: "latest" })

      expect(planStartupLaunch(persistence, NO_ARGS, undefined, "/Users/me/x.mdx")).toBeUndefined()
    })

    it("opens nothing when there is no session to resume", () => {
      expect(planStartupLaunch(persistence, NO_ARGS, "/home/me/project", null)).toBeUndefined()
    })

    it("opens a finished session's runbook without naming the session, so it gets a new one", () => {
      const saved = saveSession({
        id: "done",
        launchDir: "/home/me/project",
        finishedAt: "2026-01-02T00:00:00.000Z",
      })

      expect(planStartupLaunch(persistence, NO_ARGS, "/home/me/project", null)).toEqual({
        launch: { source: saved.path, launchDir: "/home/me/project", sessionId: undefined },
        open: { path: saved.path },
      })
    })
  })

  describe("planSecondLaunch", () => {
    const nothingOpen = () => false

    it("opens the runbook the command line names, whatever is open", () => {
      expect(
        planSecondLaunch(
          persistence,
          { runbookPath: "/repo/runbook.mdx", remoteUrl: null },
          "/home/me/project",
          () => true,
        ),
      ).toEqual({
        launch: {
          source: "/repo/runbook.mdx",
          launchDir: "/home/me/project",
          sessionId: undefined,
        },
        open: { path: "/repo/runbook.mdx" },
      })
      expect(
        planSecondLaunch(
          persistence,
          { runbookPath: null, remoteUrl: URL },
          undefined,
          nothingOpen,
        ),
      ).toEqual({
        launch: { source: URL, launchDir: undefined, sessionId: undefined },
        open: { remoteUrl: URL },
      })
    })

    it("brings up the session last launched from the directory", () => {
      const saved = saveSession({ id: "here", launchDir: "/home/me/project" })

      expect(planSecondLaunch(persistence, NO_ARGS, "/home/me/project", nothingOpen)).toEqual({
        launch: { source: saved.path, launchDir: "/home/me/project", sessionId: "here" },
        open: { path: saved.path },
      })
    })

    it("brings up a remote runbook's session by cloning it again", () => {
      saveSession({ id: "remote", remoteSource: URL, launchDir: "/a" })

      expect(planSecondLaunch(persistence, NO_ARGS, "/a", nothingOpen)?.open).toEqual({
        remoteUrl: URL,
      })
    })

    it("leaves the window as it is for a launch with no directory", () => {
      saveSession({ id: "latest", launchDir: "/a" })

      expect(planSecondLaunch(persistence, NO_ARGS, undefined, nothingOpen)).toBeUndefined()
    })

    it("leaves the window as it is when the directory's session is the open one", () => {
      saveSession({ id: "here", launchDir: "/home/me/project" })
      const asked: string[] = []

      const plan = planSecondLaunch(persistence, NO_ARGS, "/home/me/project", (id) => {
        asked.push(id)
        return true
      })

      expect(plan).toBeUndefined()
      expect(asked).toEqual(["here"])
    })

    it("leaves the window as it is for a directory no session was launched from", () => {
      saveSession({ id: "elsewhere", launchDir: "/other" })

      expect(
        planSecondLaunch(persistence, NO_ARGS, "/home/me/project", nothingOpen),
      ).toBeUndefined()
    })
  })
})
