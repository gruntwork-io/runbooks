/**
 * Keeps a GitLab session credential that came from glab's OAuth sign-in in
 * step with glab.
 *
 * GitLab OAuth access tokens live two hours. glab refreshes its own token when
 * a glab command runs near or past expiry, and GitLab revokes the previous
 * access token at that moment (Doorkeeper revokes the whole token record on a
 * refresh grant). The copy the GitAuth block wrote to the session therefore
 * stops working at its expiry, or earlier when any glab command refreshes
 * first. This module re-reads glab's token, lets glab refresh it when it is
 * due, and swaps the fresh token into the session env.
 *
 * Only a session credential recorded with source "cli" for a host glab marks
 * `is_oauth2` is ever replaced. PATs, env tokens and pasted tokens are left as
 * they are.
 */
import { Cause, Effect, Exit } from "effect"
import { runtime, sessionManager, vcsSessionMeta } from "./runtime.ts"
import { appendSessionEnvAndRecord, withTlsOrchestration, withVcs } from "./vcs-tristate.ts"
import type { OrchestratedDetection } from "./vcs-tristate.ts"
import { getMainWindow } from "../window.ts"
import { makeLogger } from "../logger.ts"
import { detectHostMeta, glabAuthStatusForHost } from "../../../src/domain/gitlab/auth.ts"
import type { GlabHostMeta } from "../../../src/domain/gitlab/auth.ts"
import { normalizeGitLabBaseUrl } from "../../../src/domain/git/gitlab-host.ts"
import type { VcsUserInfo } from "../../../src/services/VcsCredentials.ts"
import { GitError, GitLabApiError } from "../../../src/errors/index.ts"
import { registerSecret } from "../../../src/domain/vcs/redact.ts"
import type { VcsTransportErrorKind } from "../../../src/errors/index.ts"

const log = makeLogger("ipc:gitlab-cli-refresh")

/**
 * How close to expiry a glab token is asked to refresh: the window in which the
 * GitAuth block would otherwise warn that the sign-in is expiring.
 */
export const GLAB_REFRESH_WINDOW_MS = 5 * 60_000

export type GlabRefreshResult =
  /** The session credential is not a glab OAuth sign-in for that host. */
  | { readonly outcome: "not-glab" }
  | {
      readonly outcome: "refreshed" | "unchanged"
      readonly host: string
      readonly user: VcsUserInfo
      readonly scopes?: string[] | undefined
      readonly expiresAt?: string | undefined
    }
  | {
      readonly outcome: "unreachable"
      readonly host: string
      readonly errorKind: VcsTransportErrorKind
      readonly error?: string | undefined
    }
  /** glab has no working token for the host, or it belongs to another user. */
  | { readonly outcome: "failed"; readonly host: string; readonly error: string }

/** Sent to the renderer when main swapped a fresher glab token into the session. */
export interface GlabRefreshedEvent {
  readonly host: string
  readonly user: VcsUserInfo
  readonly scopes?: string[] | undefined
  readonly expiresAt?: string | undefined
}

/** The boundaries the refresh needs, injectable so the logic is testable on its own. */
export interface GlabRefreshDeps {
  /** The host and source the session's GitLab credential was recorded with. */
  readonly sessionBinding: () => { host: string; source?: string | undefined } | undefined
  readonly sessionEnv: () => Promise<{ token?: string | undefined; user?: string | undefined }>
  readonly hostMeta: (host: string) => Promise<GlabHostMeta | undefined>
  /** Run a cheap glab command; glab refreshes its OAuth token first when it is due. */
  readonly nudgeGlab: (host: string) => Promise<void>
  /** Re-read glab's token for `host` (bypassing any cache) and validate it. */
  readonly detect: (host: string) => Promise<OrchestratedDetection>
  /** Write the session env; false when nothing was written (a different session is open). */
  readonly writeSession: (host: string, env: Record<string, string>) => Promise<boolean>
  readonly notify: (event: GlabRefreshedEvent) => void
  readonly now: () => number
}

export const glabExpiredMessage = (host: string): string =>
  `glab could not renew your sign-in for ${host}. Run 'glab auth login --hostname ${host}', then select Re-authenticate.`

const NOT_GLAB: GlabRefreshResult = { outcome: "not-glab" }

/**
 * Bring the session's glab credential up to date with glab. `requestedHost`,
 * when given, must be the host the session credential is bound to.
 */
export async function refreshGlabCredential(
  deps: GlabRefreshDeps,
  requestedHost?: string,
): Promise<GlabRefreshResult> {
  const binding = deps.sessionBinding()
  if (binding?.source !== "cli") return NOT_GLAB
  const host = binding.host
  if (requestedHost !== undefined && requestedHost.trim().toLowerCase() !== host) return NOT_GLAB

  const meta = await deps.hostMeta(host)
  if (!meta?.isOAuth2) return NOT_GLAB
  const session = await deps.sessionEnv()
  if (!session.token || session.token.startsWith("glpat-")) return NOT_GLAB

  // `glab config get token` only reads; a glab command that calls the API is
  // what makes glab refresh a token that is due.
  const expiry = meta.oauth2ExpiryDate?.getTime()
  if (expiry === undefined || expiry < deps.now() + GLAB_REFRESH_WINDOW_MS) {
    await deps.nudgeGlab(host)
  }

  const result = await deps.detect(host)
  if (result.outcome === "unreachable") {
    return {
      outcome: "unreachable",
      host,
      errorKind: result.errorKind ?? "network",
      error: result.error,
    }
  }
  if (result.outcome !== "valid" || !result.token || !result.user) {
    return { outcome: "failed", host, error: glabExpiredMessage(host) }
  }
  if (session.user && result.user.login !== session.user) {
    return {
      outcome: "failed",
      host,
      error: `glab is signed in to ${host} as ${result.user.login}, not ${session.user}. Select Re-authenticate to use that account.`,
    }
  }

  const fresh = {
    host,
    user: result.user,
    scopes: result.scopes,
    expiresAt: result.expiresAt,
  }
  if (result.token === session.token) return { outcome: "unchanged", ...fresh }

  const written = await deps.writeSession(host, {
    GITLAB_TOKEN: result.token,
    GITLAB_HOST: host,
    GITLAB_USER: result.user.login,
  })
  if (!written) return { outcome: "failed", host, error: glabExpiredMessage(host) }
  deps.notify(fresh)
  return { outcome: "refreshed", ...fresh }
}

// ---------------------------------------------------------------------------
// Live wiring
// ---------------------------------------------------------------------------

// When each host's session copy of glab's token expires, from its last
// validation in this process. Unknown after an app restart until the GitAuth
// block re-checks the restored sign-in.
const knownExpiry = new Map<string, number>()

/** Note when the glab token just written to the session for `host` expires. */
export function recordGlabSessionExpiry(host: string, expiresAt: string | undefined): void {
  const at = expiresAt === undefined ? Number.NaN : Date.parse(expiresAt)
  if (Number.isNaN(at)) knownExpiry.delete(host)
  else knownExpiry.set(host, at)
}

const liveDeps: GlabRefreshDeps = {
  sessionBinding: () => vcsSessionMeta.get("gitlab"),
  sessionEnv: () =>
    runtime.runPromise(
      sessionManager.getSession().pipe(
        Effect.map((session) => ({
          token: session.env.get("GITLAB_TOKEN"),
          user: session.env.get("GITLAB_USER"),
        })),
        Effect.orElseSucceed(() => ({})),
      ),
    ),
  hostMeta: (host) => runtime.runPromise(detectHostMeta(host)),
  nudgeGlab: async (host) => {
    await runtime.runPromise(glabAuthStatusForHost(host))
  },
  detect: (host) => {
    const baseUrl = normalizeGitLabBaseUrl(host)
    return withTlsOrchestration({
      provider: "gitlab",
      host,
      detect: () =>
        withVcs((vcs) => Effect.andThen(vcs.invalidateCache(), vcs.detectGitLabCli(baseUrl))),
    })
  },
  writeSession: async (host, env) => {
    if (env.GITLAB_TOKEN) registerSecret(env.GITLAB_TOKEN)
    const generation = sessionManager.getGeneration()
    const warning = await appendSessionEnvAndRecord("gitlab", host, "cli", env, generation)
    return warning === undefined && sessionManager.isCurrentGeneration(generation)
  },
  notify: (event) => {
    getMainWindow()?.webContents.send("gitlab:cli-credential-refreshed", event)
  },
  now: () => Date.now(),
}

// One refresh at a time per requested host: concurrent callers (the block's
// timer, a 401 retry) share it rather than each spawning glab.
const inFlight = new Map<string, Promise<GlabRefreshResult>>()

/** refreshGlabCredential against the live session and glab. Never rejects. */
export function refreshGlabSessionCredential(requestedHost?: string): Promise<GlabRefreshResult> {
  const key = requestedHost ?? ""
  const pending = inFlight.get(key)
  if (pending) return pending
  const run = refreshGlabCredential(liveDeps, requestedHost)
    .then((result) => {
      if (result.outcome === "refreshed" || result.outcome === "unchanged") {
        recordGlabSessionExpiry(result.host, result.expiresAt)
      }
      if (result.outcome !== "not-glab") log.info(`glab session credential: ${result.outcome}`)
      return result
    })
    .catch((err: unknown): GlabRefreshResult => {
      log.warn("glab session credential refresh failed", err)
      return NOT_GLAB
    })
    .finally(() => {
      inFlight.delete(key)
    })
  inFlight.set(key, run)
  return run
}

/**
 * Before the session's glab token is used, refresh it when its known expiry is
 * within GLAB_REFRESH_WINDOW_MS. A no-op for any other credential, or when the
 * expiry is not known.
 */
export async function ensureFreshGlabSessionCredential(): Promise<void> {
  const binding = vcsSessionMeta.get("gitlab")
  if (binding?.source !== "cli") return
  const at = knownExpiry.get(binding.host)
  if (at === undefined || at > Date.now() + GLAB_REFRESH_WINDOW_MS) return
  await refreshGlabSessionCredential()
}

/** Whether a failure is GitLab refusing the credential (an API 401, or git's auth failure). */
export function isGitLabAuthFailure(err: unknown): boolean {
  if (err instanceof GitLabApiError) return err.status === 401
  if (err instanceof GitError) {
    return /HTTP Basic: Access denied|Authentication failed|\b401\b/i.test(err.stderr)
  }
  return false
}

/**
 * Run a GitLab call with the session token, keeping a glab sign-in fresh: the
 * token is refreshed first when it is about to expire, and when GitLab refuses
 * it anyway, glab's current token is swapped in and the call runs once more.
 */
export async function withFreshGlabCredential<A>(attempt: () => Promise<A>): Promise<A> {
  await ensureFreshGlabSessionCredential()
  try {
    return await attempt()
  } catch (err) {
    if (!isGitLabAuthFailure(err)) throw err
    if ((await refreshGlabSessionCredential()).outcome !== "refreshed") throw err
    return attempt()
  }
}

/** withFreshGlabCredential for callers that inspect the Exit rather than catch. */
export async function withFreshGlabCredentialExit<A, E>(
  attempt: () => Promise<Exit.Exit<A, E>>,
): Promise<Exit.Exit<A, E>> {
  await ensureFreshGlabSessionCredential()
  const exit = await attempt()
  if (Exit.isSuccess(exit) || !isGitLabAuthFailure(Cause.squash(exit.cause))) return exit
  if ((await refreshGlabSessionCredential()).outcome !== "refreshed") return exit
  return attempt()
}
