/**
 * Where sessions are kept on disk, under Electron's userData directory:
 *
 *   v0/sessions/db/sessions.db   the sessions database (src/domain/session/store.ts)
 *   v0/sessions/dirs/<id>/       each session's own directory
 *
 * `v0` versions the layout: a layout that can't be migrated in place gets a
 * new top-level directory.
 */
import { safeStorage, shell } from "electron"
import * as fs from "node:fs"
import * as path from "node:path"
import { Effect } from "effect"
import { SessionPersistence, type SessionCipher } from "../../src/domain/session/persistence.ts"
import { SessionStore } from "../../src/domain/session/store.ts"
import { sessionManager } from "./ipc/runtime.ts"
import { GOOGLE_CREDENTIAL_FILE_ENV_VARS } from "./ipc/google-session-env.ts"
import { openSqliteDatabase } from "../../src/layers/NodeSqlite.ts"
import { makeLogger } from "./logger.ts"

const log = makeLogger("sessions")

export interface SessionStorage {
  persistence: SessionPersistence
  /** Close the database. Call once, when the app quits. */
  close(): void
}

/**
 * Open the sessions database under `userDataDir`, creating the layout above
 * if it is missing. When the database file can't be opened (a read-only or
 * corrupt profile), sessions are kept in memory for this run and forgotten
 * at quit, so runbooks still open.
 */
export function openSessionStorage(userDataDir: string): SessionStorage {
  const root = path.join(userDataDir, "v0", "sessions")
  const dbFile = path.join(root, "db", "sessions.db")
  const dirsRoot = path.join(root, "dirs")

  let store: SessionStore
  try {
    // Session directories hold clones and generated files, and the database
    // names every runbook the user opened: keep both to this user.
    fs.mkdirSync(path.dirname(dbFile), { recursive: true, mode: 0o700 })
    fs.mkdirSync(dirsRoot, { recursive: true, mode: 0o700 })
    store = Effect.runSync(SessionStore.open(openSqliteDatabase(dbFile)))
  } catch (err) {
    log.error(
      `Can't open the sessions database at ${dbFile}; sessions won't be remembered after this run:`,
      err,
    )
    store = Effect.runSync(SessionStore.open(openSqliteDatabase(":memory:")))
  }

  return {
    persistence: new SessionPersistence({
      store,
      manager: sessionManager,
      dirsRoot,
      cipher: safeStorageCipher(),
      moveToTrash: trash(),
      ephemeralFileEnvVars: GOOGLE_CREDENTIAL_FILE_ENV_VARS,
      random: () => Math.random(),
      onSaveError: (err) => {
        log.error("Failed to save the session:", err)
      },
    }),
    close: () => {
      Effect.runSync(
        store.close().pipe(
          Effect.catchAll((err) =>
            Effect.sync(() => {
              log.error("Failed to close the sessions database:", err)
            }),
          ),
        ),
      )
    },
  }
}

/**
 * Moves a directory to the OS trash. e2e tests set RUNBOOKS_TEST_TRASH_DIR to
 * a directory of their own to move it into instead, so a test run leaves
 * nothing in the user's trash, and runs where the OS has none.
 */
function trash(): (dir: string) => Promise<void> {
  const testTrashDir = process.env.RUNBOOKS_TEST_TRASH_DIR
  if (testTrashDir) {
    return (dir) => fs.promises.rename(dir, path.join(testTrashDir, path.basename(dir)))
  }
  return (dir) => shell.trashItem(dir)
}

/**
 * Encrypts with the OS credential store through Electron's safeStorage:
 * Keychain on macOS, DPAPI on Windows, a secret service on Linux.
 *
 * On Linux without a secret service, safeStorage falls back to a key
 * hardcoded in Chromium ("basic_text"). That is no protection for
 * credentials, so the env is not saved there.
 *
 * e2e tests set RUNBOOKS_TEST_INSECURE_SESSION_KEY=1 to save with that key
 * anyway. Playwright starts Electron with `--password-store=basic`, so on
 * Linux a test launch gets the hardcoded key whatever keyring the machine has.
 */
function safeStorageCipher(): SessionCipher {
  const hardcodedKeyAllowed = process.env.RUNBOOKS_TEST_INSECURE_SESSION_KEY === "1"
  // safeStorage reports no encryption on basic_text until it is told to use
  // the hardcoded key. The call does nothing on macOS and Windows.
  if (hardcodedKeyAllowed) safeStorage.setUsePlainTextEncryption(true)

  let warned = false
  const available = (): boolean => {
    const ok =
      safeStorage.isEncryptionAvailable() &&
      (process.platform !== "linux" ||
        hardcodedKeyAllowed ||
        safeStorage.getSelectedStorageBackend() !== "basic_text")
    if (!ok && !warned) {
      warned = true
      log.warn(
        "No OS credential store is available to encrypt the session environment; " +
          "a resumed session won't have the environment variables it had.",
      )
    }
    return ok
  }

  return {
    encrypt: (plaintext) => {
      if (!available()) return undefined
      try {
        return new Uint8Array(safeStorage.encryptString(plaintext))
      } catch (err) {
        // A denied Keychain prompt, for one. The rest of the session still saves.
        log.warn("Can't encrypt the session environment; saving the session without it:", err)
        return undefined
      }
    },
    decrypt: (ciphertext) => {
      if (!available()) return undefined
      try {
        return safeStorage.decryptString(Buffer.from(ciphertext))
      } catch (err) {
        log.warn("Can't decrypt the saved session environment; resuming without it:", err)
        return undefined
      }
    },
  }
}
