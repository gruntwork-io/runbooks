/**
 * Per-BLOCK Google credential bookkeeping for electron/main/ipc/google.ts.
 *
 * None of this crosses IPC. It exists because three channels (`google:projects`,
 * `google:set-project`, `google:check-project`) operate on "the credential this
 * block authenticated with" — which, per D4, the renderer is never allowed to
 * hold and therefore cannot pass back in.
 *
 * Split out of the IPC module so the multi-block rules it encodes can be
 * exercised without an Electron `ipcMain`. Those rules are:
 *
 *  1. A block NEVER borrows another block's credential. The documented
 *     multi-project pattern puts `<GoogleAuth id="source"/>` next to
 *     `<GoogleAuth id="target"/>`; a single global "most recent" credential
 *     means "Change project" on one lists the projects of the other.
 *  2. A block's materialised credentials file is released only by that block
 *     re-authenticating. Two blocks handed the SAME key and project produce a
 *     byte-identical identity, so keying on identity alone would have the
 *     second block zero and delete the file the first already published as its
 *     `GOOGLE_APPLICATION_CREDENTIALS` output.
 */
import type { GoogleCredentialRef, GoogleIdentity } from "../../../src/services/GoogleClient.ts"
import type { GoogleCredentialTypeIpc } from "../../shared/channels.ts"
import { materializeCredentialFile, releaseCredentialFile } from "./google-credentials.ts"

/** The credential one GoogleAuth block's most recent authentication established. */
export interface ActiveGoogleCredential {
  readonly ref: GoogleCredentialRef
  /** Absolute path backing the session credential. A path, never contents (D12). */
  readonly credentialsPath?: string
  readonly principal: string
  readonly credentialType: GoogleCredentialTypeIpc
  projectId?: string
  region?: string
  zone?: string
  readonly configuration?: string
}

/** blockId -> the credential that block authenticated with. */
const activeCredentials = new Map<string, ActiveGoogleCredential>()

/**
 * The block that authenticated most recently. Only consulted when a caller
 * supplies NO blockId — a caller that names a block gets that block's
 * credential or nothing, never a neighbour's.
 */
let lastActiveKey: string | null = null

/**
 * Key under which a blockless caller's credential is filed. Nothing in-tree
 * does this today (the field is optional on the channel types), but sharing one
 * reserved slot beats silently colliding with a real block's id.
 */
const BLOCKLESS_KEY = " blockless"

export const credentialKeyFor = (blockId: string | undefined): string => blockId || BLOCKLESS_KEY

/**
 * Absolute path of the file materialised for a given
 * `<blockId>:<type>:<principal>:<project>`.
 */
const materializedByIdentity = new Map<string, string>()

export const identityKeyFor = (
  blockId: string | undefined,
  identity: Pick<GoogleIdentity, "credentialType" | "email">,
  projectId?: string,
): string =>
  `${credentialKeyFor(blockId)}:${identity.credentialType}:${identity.email}:${projectId ?? ""}`

/**
 * Materialise a credentials document for one block's identity, releasing the
 * file THAT block's same identity used before — a rotated service-account key
 * or a re-run OAuth login should not leave stale key material on disk. The new
 * file is written FIRST so a failed write never destroys a credential that is
 * still working.
 */
export function materializeForIdentity(identityKey: string, json: string): string {
  const previous = materializedByIdentity.get(identityKey)
  const filePath = materializeCredentialFile(json)
  materializedByIdentity.set(identityKey, filePath)
  if (previous && previous !== filePath) {
    releaseCredentialFile(previous)
  }
  return filePath
}

/** File a block's credential, and remember it as the newest. */
export function setActiveCredential(
  blockId: string | undefined,
  credential: ActiveGoogleCredential,
): void {
  const key = credentialKeyFor(blockId)
  activeCredentials.set(key, credential)
  lastActiveKey = key
}

/**
 * The credential registered for a block. A block that has not authenticated
 * does NOT borrow a neighbour's — the caller falls through to the session env,
 * which is the only credential it can honestly claim.
 */
export function activeCredentialFor(
  blockId: string | undefined,
): ActiveGoogleCredential | undefined {
  if (blockId) return activeCredentials.get(blockId)
  return lastActiveKey ? activeCredentials.get(lastActiveKey) : undefined
}

/** Test seam only: drop all bookkeeping (the files themselves are not touched). */
export function resetGoogleCredentialRegistry(): void {
  activeCredentials.clear()
  materializedByIdentity.clear()
  lastActiveKey = null
}
