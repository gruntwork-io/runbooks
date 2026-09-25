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
 *     re-authenticating with another credentials FILE, whatever identity it is
 *     for: a different project, principal or credential type — or a file that
 *     is not ours at all (the user's own ADC file, a detected
 *     `GOOGLE_APPLICATION_CREDENTIALS` path) — leaves the old file as
 *     unreachable as a rotated key does. A bare access token does not: it
 *     leaves the session env's `GOOGLE_APPLICATION_CREDENTIALS` naming the old
 *     file (see `setActiveCredential`). Two blocks handed the SAME key and
 *     project produce a byte-identical identity, so keying on identity alone
 *     would have the second block zero and delete the file the first already
 *     published as its `GOOGLE_APPLICATION_CREDENTIALS` output.
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
 * `credentialKeyFor(blockId)` -> absolute path of the newest file that block
 * materialised, whatever identity it was for.
 */
const latestMaterializedByBlock = new Map<string, string>()

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

/** Only feeds `materializeForIdentity`'s ignored `_identityKey` parameter. */
export const identityKeyFor = (
  blockId: string | undefined,
  identity: Pick<GoogleIdentity, "credentialType" | "email">,
  projectId?: string,
): string =>
  `${credentialKeyFor(blockId)}:${identity.credentialType}:${identity.email}:${projectId ?? ""}`

/**
 * Materialise a credentials document for one block. The file that block
 * materialised before is QUEUED for release, whatever identity it was for — a
 * rotated service-account key, a re-run OAuth login, another project or another
 * tab should not leave stale key material on disk, but the old file also must
 * not be deleted while the renderer is still publishing its path.
 * `commitCredential` is what finally zeroes it.
 *
 * `_identityKey` is ignored; the predecessor is looked up per block. It stays
 * only until google.ts's call site is updated.
 *
 * The new file is written FIRST so a failed write never destroys a credential
 * that is still working.
 */
export function materializeForIdentity(
  blockId: string | undefined,
  _identityKey: string,
  json: string,
): string {
  const key = credentialKeyFor(blockId)
  const previous = latestMaterializedByBlock.get(key)
  const filePath = materializeCredentialFile(json)
  latestMaterializedByBlock.set(key, filePath)
  if (previous && previous !== filePath) {
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
 * Deliberately keyed on the block, not the identity: successive
 * re-authentications of one block can be for different projects, principals or
 * credential types, and all of them are superseded by whatever the block
 * finally publishes.
 *
 * An abandoned flow — user re-authenticates, then closes the app without
 * finishing the project picker — never commits, so its superseded files survive
 * until the `will-quit` sweep in `cleanupGoogleCredentialFiles`. Leaking a 0600
 * file until quit is the right trade against deleting one a running step needs.
 *
 * The same trade covers a queued file ANOTHER block has registered as its own
 * credential — a block whose detection read this block's
 * `GOOGLE_APPLICATION_CREDENTIALS` output and confirmed it as an existing file.
 * That file is skipped and dropped from the queue, leaving it to the sweep.
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
    if (isActiveForAnotherBlock(key, filePath)) continue
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

/** Whether a block other than `ownKey` has `filePath` as its registered credential. */
function isActiveForAnotherBlock(ownKey: string, filePath: string): boolean {
  for (const [key, active] of activeCredentials) {
    if (key !== ownKey && active.credentialsPath === filePath) return true
  }
  return false
}

/**
 * File a block's credential, and remember it as the newest.
 *
 * Every successful authentication lands here, including the ones that
 * materialise nothing. The gcloud Config tab or a detected
 * `GOOGLE_APPLICATION_CREDENTIALS` path (an existing file, reused as-is)
 * supersedes the block's newest materialised file just as a new
 * materialisation would, so that file is queued for release here and forgotten
 * as the block's newest. `commitCredential` still does the releasing, so it
 * survives until the renderer publishes the replacement.
 *
 * A bare access token (no file at all) queues nothing. google.ts overwrites the
 * session env's `GOOGLE_APPLICATION_CREDENTIALS` only when the new credential
 * is a file, so after a token re-auth the session still names the block's old
 * file, and every later `<Command>` would fail the executor's missing-file
 * check if it were released. It stays the block's newest, so the next
 * file-backed re-authentication queues it; otherwise the will-quit sweep
 * removes it.
 *
 * A path this block itself materialised (its newest, or one already queued) is
 * left alone. A materialising flow normally arrives with its own file as the
 * newest, but it writes the session env between materialising and getting here,
 * so an overlapping flow on the same block can materialise in between. Queueing
 * THAT flow's file would let the earlier flow's commit delete the credential
 * the later one is about to publish.
 */
export function setActiveCredential(
  blockId: string | undefined,
  credential: ActiveGoogleCredential,
): void {
  const key = credentialKeyFor(blockId)
  const latest = latestMaterializedByBlock.get(key)
  const path = credential.credentialsPath
  const pending = pendingReleaseByBlock.get(key)
  const isOwnFile = path !== undefined && (path === latest || pending?.has(path) === true)
  if (latest && path !== undefined && !isOwnFile) {
    const queue = pending ?? new Set<string>()
    queue.add(latest)
    pendingReleaseByBlock.set(key, queue)
    latestMaterializedByBlock.delete(key)
  }
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

/**
 * Drop all bookkeeping. Runs at every runbook switch (runbook.ts) and between
 * tests.
 *
 * The files themselves are deliberately NOT released: a runbook switch does not
 * stop running executions, so a step from the previous runbook may still be
 * reading one. They stay tracked in google-credentials.ts, and the will-quit
 * sweep in `cleanupGoogleCredentialFiles` removes them.
 */
export function resetGoogleCredentialRegistry(): void {
  activeCredentials.clear()
  latestMaterializedByBlock.clear()
  pendingReleaseByBlock.clear()
  lastActiveKey = null
}
