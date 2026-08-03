/**
 * Custody of the credential files main materialises for Google Cloud auth.
 *
 * Mirrors the `tempCloneDirs` / `cleanupTempClones` pattern in
 * electron/main/remote.ts: a module-level registry of everything this process
 * wrote, plus a quit-time sweep.
 *
 * The renderer never sees a credential file's CONTENTS; it does see the PATH,
 * which is what `GOOGLE_APPLICATION_CREDENTIALS` and the block's outputs carry.
 * Only inline credential documents are materialised — the gcloud tab points at
 * the user's own `application_default_credentials.json` and writes nothing.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

/** Directories this process created to hold credential files. */
const materializedDirs = new Set<string>()

/** The file name inside each private directory. */
const CREDENTIAL_FILE_NAME = "adc.json"

/**
 * Write a credentials JSON to a private temp file and return its absolute
 * path.
 *
 * Each document gets its own `mkdtemp` directory: the directory's 0700 mode is
 * the protection that actually holds on every platform, and it means two
 * blocks authenticating concurrently can never race on one file name.
 *
 * mode 0600 at create time AND an explicit chmod, because the process umask
 * can only widen a create mode. `flag: "wx"` so an existing file is never
 * clobbered.
 */
export function materializeCredentialFile(json: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-gcp-"))
  const file = path.join(dir, CREDENTIAL_FILE_NAME)
  fs.writeFileSync(file, json, { mode: 0o600, flag: "wx" })
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    // chmod is a no-op on Windows; the per-user temp root's ACL is what
    // restricts access there.
  }
  materializedDirs.add(dir)
  return file
}

/**
 * Overwrite with zeros, unlink, then drop the containing directory.
 *
 * Called when the same identity re-authenticates, so a rotated key does not
 * linger on disk. Best-effort throughout: a file that is already gone is the
 * outcome we wanted.
 */
export function releaseCredentialFile(filePath: string): void {
  const dir = path.dirname(filePath)
  if (!materializedDirs.has(dir)) {
    // Not ours to delete — the gcloud tab hands back the user's own ADC path.
    return
  }

  try {
    const size = fs.statSync(filePath).size
    if (size > 0) fs.writeFileSync(filePath, Buffer.alloc(size, 0))
  } catch {
    // Already gone, or unreadable — the unlink below is what matters.
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // Best-effort cleanup
  }
  materializedDirs.delete(dir)
}

/**
 * Remove every credential file this process materialised. Called from
 * `app.on("will-quit")`, next to `cleanupTempClones()`. Tolerates
 * already-deleted directories without throwing.
 */
export function cleanupGoogleCredentialFiles(): void {
  for (const dir of materializedDirs) {
    try {
      const file = path.join(dir, CREDENTIAL_FILE_NAME)
      const size = fs.statSync(file).size
      if (size > 0) fs.writeFileSync(file, Buffer.alloc(size, 0))
    } catch {
      // File may already be gone
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup
    }
  }
  materializedDirs.clear()
}
