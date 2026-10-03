import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { openSqliteDatabase } from "../../src/layers/NodeSqlite.ts"
import { SessionStore, type SessionRecord } from "../../src/domain/session/store.ts"

// The sessions store over Node's `node:sqlite`, the binding Electron ships.
//
// Node-only (vitest, environment: node): the store's own tests
// (src/domain/session/store.test.ts) run under `bun test`, where `node:sqlite`
// is Bun's implementation of the same API. This suite covers what could differ
// between the two: the types each column comes back as, and how a failed
// statement is reported.

const session: SessionRecord = {
  id: "s1",
  name: "elegant-elephant",
  path: "/repo/runbook.mdx",
  remoteSource: "https://github.com/acme/runbooks//deploy",
  dir: "/sessions/dirs/s1",
  workingDir: "/sessions/dirs/s1/repo",
  launchDir: "/home/me/project",
  env: new Uint8Array([0, 1, 2, 255]),
  worktrees: ["/sessions/dirs/s1/repo"],
  activeWorktree: "/sessions/dirs/s1/repo",
  executionCount: 3,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastLaunchedAt: "2026-01-02T00:00:00.000Z",
  lastActivityAt: "2026-01-03T00:00:00.000Z",
  vcsBindings: { github: { host: "ghe.example.com", source: "oauth" } },
  finishedAt: "2026-01-03T12:00:00.000Z",
}

describe("SessionStore over node:sqlite", () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-session-sqlite-"))
    file = path.join(dir, "sessions.db")
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("returns a session as it was inserted, after the file is closed and reopened", () => {
    const first = Effect.runSync(SessionStore.open(openSqliteDatabase(file)))
    Effect.runSync(first.insert(session))
    Effect.runSync(first.close())

    const second = Effect.runSync(SessionStore.open(openSqliteDatabase(file)))
    const found = Effect.runSync(second.get("s1"))
    Effect.runSync(second.close())

    expect(found).toEqual(session)
    expect(typeof found?.executionCount).toBe("number")
  })

  it("returns undefined for a session and for optional columns that are absent", () => {
    const store = Effect.runSync(SessionStore.open(openSqliteDatabase(file)))
    Effect.runSync(
      store.insert({ ...session, remoteSource: undefined, launchDir: undefined, env: undefined }),
    )

    expect(Effect.runSync(store.get("missing"))).toBeUndefined()
    expect(Effect.runSync(store.get("s1"))).toMatchObject({
      remoteSource: undefined,
      launchDir: undefined,
      env: undefined,
    })
    Effect.runSync(store.close())
  })

  it("saves state changes and finds the latest session by runbook and launch directory", () => {
    const store = Effect.runSync(SessionStore.open(openSqliteDatabase(file)))
    Effect.runSync(store.insert(session))
    Effect.runSync(
      store.insert({
        ...session,
        id: "s2",
        name: "brave-otter",
        lastLaunchedAt: "2026-01-05T00:00:00.000Z",
      }),
    )

    Effect.runSync(
      store.saveState("s2", {
        workingDir: "/sessions/dirs/s2",
        env: new Uint8Array([7]),
        worktrees: [],
        activeWorktree: "",
        executionCount: 9,
        lastActivityAt: "2026-01-06T00:00:00.000Z",
      }),
    )

    const byRunbook = Effect.runSync(
      store.latestForRunbook({
        path: "/elsewhere/runbook.mdx",
        remoteSource: session.remoteSource,
      }),
    )
    expect(byRunbook).toMatchObject({ id: "s2", executionCount: 9, worktrees: [] })
    expect(byRunbook?.env).toEqual(new Uint8Array([7]))
    expect(Effect.runSync(store.latestForLaunchDir("/home/me/project"))?.id).toBe("s2")
    expect(Effect.runSync(store.latest())?.id).toBe("s2")
    Effect.runSync(store.close())
  })

  it("rolls back an insert that fails, and reports it as a SessionStoreError", () => {
    const store = Effect.runSync(SessionStore.open(openSqliteDatabase(file)))
    Effect.runSync(store.insert(session))

    const duplicate = Effect.runSync(
      Effect.either(store.insert({ ...session, worktrees: ["/other"] })),
    )

    expect(duplicate).toMatchObject({ _tag: "Left", left: { _tag: "SessionStoreError" } })
    expect(Effect.runSync(store.get("s1"))?.worktrees).toEqual(session.worktrees)
    Effect.runSync(store.close())
  })

  it("deletes a session's history and worktrees with it, and lists what is left", () => {
    const store = Effect.runSync(SessionStore.open(openSqliteDatabase(file)))
    Effect.runSync(store.insert(session))
    Effect.runSync(store.insert({ ...session, id: "s2", name: "brave-otter", worktrees: [] }))
    Effect.runSync(
      store.appendEvent(
        {
          sessionId: "s1",
          at: "2026-01-04T00:00:00.000Z",
          blockId: "b",
          kind: "inputs",
          payload: new Uint8Array([1]),
        },
        { replacePrevious: false },
      ),
    )

    Effect.runSync(store.delete("s1"))

    expect(Effect.runSync(store.list(10)).map((s) => s.id)).toEqual(["s2"])
    Effect.runSync(store.close())
    const db = openSqliteDatabase(file)
    const count = (table: string) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
    expect([count("session_events"), count("session_worktrees")]).toEqual([0, 0])
    db.close()
  })
})
