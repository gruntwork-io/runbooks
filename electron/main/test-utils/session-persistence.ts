/**
 * Session persistence for a bun test file that calls runbook:get, which
 * refuses to load a runbook before index.ts has set it up.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect } from "effect"
import { SessionPersistence } from "../../../src/domain/session/persistence.ts"
import { SessionStore } from "../../../src/domain/session/store.ts"
import { openSqliteDatabase } from "../../../src/layers/NodeSqlite.ts"
import { sessionManager, setSessionPersistence } from "../ipc/runtime.ts"

export interface TestSessionPersistence {
  persistence: SessionPersistence
  store: SessionStore
  /** The directory that gets one subdirectory per session. */
  dirsRoot: string
  /** Delete the session directories. */
  cleanup(): void
}

/**
 * Give the IPC handlers a session persistence over an in-memory database and
 * a temp directory, without encryption: the env is stored as plain JSON.
 */
export function installTestSessionPersistence(): TestSessionPersistence {
  // realpath: os.tmpdir() is a symlink on macOS, and session dirs are real paths.
  const dirsRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-sessions-")))
  const store = Effect.runSync(SessionStore.open(openSqliteDatabase(":memory:")))
  const persistence = new SessionPersistence({
    store,
    manager: sessionManager,
    dirsRoot,
    cipher: {
      encrypt: (plaintext) => new TextEncoder().encode(plaintext),
      decrypt: (ciphertext) => new TextDecoder().decode(ciphertext),
    },
    // Stands in for the OS trash, which a test must not fill.
    moveToTrash: (dir) => fs.promises.rm(dir, { recursive: true }),
    ephemeralFileEnvVars: [],
    random: () => Math.random(),
    onSaveError: (err) => {
      throw err
    },
  })
  setSessionPersistence(persistence)
  return {
    persistence,
    store,
    dirsRoot,
    cleanup: () => {
      fs.rmSync(dirsRoot, { recursive: true, force: true })
    },
  }
}
