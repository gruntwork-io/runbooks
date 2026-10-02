import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect } from "effect"
import { SessionStore, type SessionRecord } from "./store.ts"
import { openSqliteDatabase } from "../../layers/NodeSqlite.ts"

const run = Effect.runSync

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s1",
    path: "/repo/runbook.mdx",
    remoteSource: undefined,
    dir: "/sessions/dirs/s1",
    workingDir: "/sessions/dirs/s1",
    launchDir: undefined,
    env: undefined,
    worktrees: [],
    activeWorktree: "",
    executionCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastLaunchedAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

describe("SessionStore", () => {
  let store: SessionStore

  beforeEach(() => {
    store = run(SessionStore.open(openSqliteDatabase(":memory:")))
  })

  it("returns a session as it was inserted", () => {
    const session = record({
      remoteSource: "https://github.com/acme/runbooks//deploy",
      launchDir: "/home/me/project",
      env: new Uint8Array([1, 2, 3]),
      worktrees: ["/sessions/dirs/s1/b", "/sessions/dirs/s1/a"],
      activeWorktree: "/sessions/dirs/s1/a",
      executionCount: 4,
    })

    run(store.insert(session))

    expect(run(store.get("s1"))).toEqual(session)
  })

  it("returns undefined for an unknown id", () => {
    expect(run(store.get("missing"))).toBeUndefined()
  })

  it("fails to insert a second session with the same id, leaving the first intact", () => {
    run(store.insert(record({ worktrees: ["/a"] })))

    expect(() => run(store.insert(record({ worktrees: ["/b"] })))).toThrow(
      /failed to save a new session/,
    )
    expect(run(store.get("s1"))?.worktrees).toEqual(["/a"])
  })

  describe("saveState", () => {
    it("replaces the changing state and leaves the rest of the session alone", () => {
      run(store.insert(record({ launchDir: "/home/me", worktrees: ["/a", "/b"] })))

      run(
        store.saveState("s1", {
          workingDir: "/sessions/dirs/s1/repo",
          env: new Uint8Array([9]),
          worktrees: ["/b"],
          activeWorktree: "/b",
          executionCount: 2,
          lastActivityAt: "2026-02-01T00:00:00.000Z",
        }),
      )

      expect(run(store.get("s1"))).toEqual(
        record({
          launchDir: "/home/me",
          workingDir: "/sessions/dirs/s1/repo",
          env: new Uint8Array([9]),
          worktrees: ["/b"],
          activeWorktree: "/b",
          executionCount: 2,
          lastActivityAt: "2026-02-01T00:00:00.000Z",
        }),
      )
    })

    it("clears a saved env when the new state has none", () => {
      run(store.insert(record({ env: new Uint8Array([1]) })))

      run(
        store.saveState("s1", {
          workingDir: "/w",
          env: undefined,
          worktrees: [],
          activeWorktree: "",
          executionCount: 0,
          lastActivityAt: "2026-01-01T00:00:00.000Z",
        }),
      )

      expect(run(store.get("s1"))?.env).toBeUndefined()
    })
  })

  describe("latestForRunbook", () => {
    it("returns the most recently launched session of a local runbook", () => {
      run(store.insert(record({ id: "old", lastLaunchedAt: "2026-01-01T00:00:00.000Z" })))
      run(store.insert(record({ id: "new", lastLaunchedAt: "2026-01-03T00:00:00.000Z" })))
      run(
        store.insert(
          record({
            id: "other",
            path: "/other/runbook.mdx",
            lastLaunchedAt: "2026-01-09T00:00:00.000Z",
          }),
        ),
      )

      const found = run(
        store.latestForRunbook({ path: "/repo/runbook.mdx", remoteSource: undefined }),
      )

      expect(found?.id).toBe("new")
    })

    it("finds a remote runbook by its URL, wherever its clone landed", () => {
      const url = "https://github.com/acme/runbooks//deploy"
      run(
        store.insert(record({ id: "remote", path: "/tmp/clone-1/runbook.mdx", remoteSource: url })),
      )

      const found = run(
        store.latestForRunbook({ path: "/tmp/clone-2/runbook.mdx", remoteSource: url }),
      )

      expect(found?.id).toBe("remote")
    })

    it("keeps a local runbook's sessions apart from a remote one cloned to the same path", () => {
      run(store.insert(record({ id: "remote", remoteSource: "https://example.com/r" })))

      expect(
        run(store.latestForRunbook({ path: "/repo/runbook.mdx", remoteSource: undefined })),
      ).toBeUndefined()
    })

    it("prefers the session created later when two were launched at the same instant", () => {
      run(store.insert(record({ id: "first" })))
      run(store.insert(record({ id: "second" })))

      expect(
        run(store.latestForRunbook({ path: "/repo/runbook.mdx", remoteSource: undefined }))?.id,
      ).toBe("second")
    })
  })

  describe("latestForLaunchDir", () => {
    it("returns the session most recently launched from that directory", () => {
      run(
        store.insert(
          record({ id: "a1", launchDir: "/a", lastLaunchedAt: "2026-01-01T00:00:00.000Z" }),
        ),
      )
      run(
        store.insert(
          record({ id: "a2", launchDir: "/a", lastLaunchedAt: "2026-01-02T00:00:00.000Z" }),
        ),
      )
      run(
        store.insert(
          record({ id: "b", launchDir: "/b", lastLaunchedAt: "2026-01-05T00:00:00.000Z" }),
        ),
      )
      run(store.insert(record({ id: "none", lastLaunchedAt: "2026-01-09T00:00:00.000Z" })))

      expect(run(store.latestForLaunchDir("/a"))?.id).toBe("a2")
      expect(run(store.latestForLaunchDir("/c"))).toBeUndefined()
    })
  })

  describe("latest", () => {
    it("returns the most recently launched session of all", () => {
      expect(run(store.latest())).toBeUndefined()

      run(
        store.insert(
          record({ id: "a", launchDir: "/a", lastLaunchedAt: "2026-01-02T00:00:00.000Z" }),
        ),
      )
      run(store.insert(record({ id: "b", lastLaunchedAt: "2026-01-05T00:00:00.000Z" })))

      expect(run(store.latest())?.id).toBe("b")
    })
  })

  describe("markLaunched", () => {
    it("makes the session the latest and records where it was launched from", () => {
      run(store.insert(record({ id: "a", lastLaunchedAt: "2026-01-01T00:00:00.000Z" })))
      run(store.insert(record({ id: "b", lastLaunchedAt: "2026-01-02T00:00:00.000Z" })))

      run(
        store.markLaunched("a", {
          at: "2026-01-03T00:00:00.000Z",
          runbookPath: "/tmp/clone-2/runbook.mdx",
          launchDir: "/home/me/project",
        }),
      )

      expect(run(store.latest())).toMatchObject({
        id: "a",
        path: "/tmp/clone-2/runbook.mdx",
        launchDir: "/home/me/project",
        lastLaunchedAt: "2026-01-03T00:00:00.000Z",
      })
    })

    it("keeps the recorded launch directory when the new launch has none", () => {
      run(store.insert(record({ launchDir: "/home/me/project" })))

      run(
        store.markLaunched("s1", {
          at: "2026-01-03T00:00:00.000Z",
          runbookPath: "/repo/runbook.mdx",
          launchDir: undefined,
        }),
      )

      expect(run(store.get("s1"))?.launchDir).toBe("/home/me/project")
    })
  })

  describe("a database file", () => {
    let dir: string

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-session-store-"))
    })

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true })
    })

    it("keeps sessions after the database is closed and reopened", () => {
      const file = path.join(dir, "sessions.db")
      const first = run(SessionStore.open(openSqliteDatabase(file)))
      run(first.insert(record({ worktrees: ["/a"] })))
      run(first.close())

      const second = run(SessionStore.open(openSqliteDatabase(file)))

      expect(run(second.get("s1"))).toEqual(record({ worktrees: ["/a"] }))
      run(second.close())
    })

    it("refuses a database written by a newer schema version", () => {
      const file = path.join(dir, "sessions.db")
      const db = openSqliteDatabase(file)
      db.exec("PRAGMA user_version = 99")
      db.close()

      expect(() => run(SessionStore.open(openSqliteDatabase(file)))).toThrow(/schema version 99/)
    })
  })
})
