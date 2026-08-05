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
 *  3. That release happens when the RENDERER commits the replacement, not when
 *     main writes it. Main materialises during the IPC call; the renderer keeps
 *     publishing the old path until `completeAuthentication` runs, which can be
 *     several user interactions later. See `pendingReleaseByBlock`.
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

/**
 * Superseded files a block materialised that the RENDERER has not yet stopped
 * publishing, keyed by `credentialKeyFor(blockId)`.
 *
 * A file cannot be released the moment its replacement is written. Main and the
 * renderer learn about a new credential at different times: main materialises
 * during the IPC call, but the block's `GOOGLE_APPLICATION_CREDENTIALS` output —
 * the only value a `<Command googleAuthId>` actually injects — is not rewritten
 * until `completeAuthentication` runs, which on the OAuth tab in a multi-project
 * org waits for the user to pick a project. Releasing eagerly deleted the file
 * the renderer was still handing to steps, and gcloud reported it as an opaque
 * "Failed to load credential file" naming a temp dir the user never created.
 */
const pendingReleaseByBlock = new Map<string, Set<string>>()

export const identityKeyFor = (
  blockId: string | undefined,
  identity: Pick<GoogleIdentity, "credentialType" | "email">,
  projectId?: string,
): string =>
  `${credentialKeyFor(blockId)}:${identity.credentialType}:${identity.email}:${projectId ?? ""}`

/**
 * Materialise a credentials document for one block's identity. The file THAT
 * block's same identity used before is QUEUED for release — a rotated
 * service-account key or a re-run OAuth login should not leave stale key
 * material on disk, but it also must not be deleted while the renderer is still
 * publishing its path. `commitCredential` is what finally zeroes it.
 *
 * The new file is written FIRST so a failed write never destroys a credential
 * that is still working.
 */
export function materializeForIdentity(
  blockId: string | undefined,
  identityKey: string,
  json: string,
): string {
  const previous = materializedByIdentity.get(identityKey)
  const filePath = materializeCredentialFile(json)
  materializedByIdentity.set(identityKey, filePath)
  if (previous && previous !== filePath) {
    const key = credentialKeyFor(blockId)
    const pending = pendingReleaseByBlock.get(key) ?? new Set<string>()
    pending.add(previous)
    pendingReleaseByBlock.set(key, pending)
  }
  return filePath
}

/**
 * The renderer has published `committedPath` as this block's credential, so
 * every OLDER file the block materialised is now unreachable and can be zeroed.
 *
 * Deliberately keyed on the block, not the identity: a single re-authentication
 * can materialise under several identity keys (the project id is part of the
 * key, and the project is often resolved only after the credential exists), and
 * all of them are superseded by whatever the block finally publishes.
 *
 * An abandoned flow — user re-authenticates, then closes the app without
 * finishing the project picker — never commits, so its superseded files survive
 * until the `will-quit` sweep in `cleanupGoogleCredentialFiles`. Leaking a 0600
 * file until quit is the right trade against deleting one a running step needs.
 */
export function commitCredential(
  blockId: string | undefined,
  committedPath?: string,
): void {
  const key = credentialKeyFor(blockId)
  const pending = pendingReleaseByBlock.get(key)
  if (!pending) return

  for (const filePath of pending) {
    if (filePath === committedPath) continue
    releaseCredentialFile(filePath)
  }

  // A committed path that was itself queued stays queued rather than being
  // dropped from bookkeeping: the renderer is publishing it right now, and the
  // NEXT commit naming something else is what makes it releasable. Forgetting
  // it here would leak it until quit.
  if (committedPath && pending.has(committedPath)) {
    pendingReleaseByBlock.set(key, new Set([committedPath]))
  } else {
    pendingReleaseByBlock.delete(key)
  }
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
  pendingReleaseByBlock.clear()
  lastActiveKey = null
}
