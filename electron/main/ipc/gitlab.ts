/**
 * IPC handlers for GitLab authentication operations.
 *
 * Bridges Electron ipcMain to the GitLab auth domain module, providing token
 * validation and credential detection (env var, `glab` CLI, and glab's
 * config.yml). Mirrors github.ts:
 * detection handlers inject the resolved token into the session environment so
 * git operations can resolve it server-side, while `gitlab:validate` only
 * validates (the renderer owns the PAT-paste session write, matching the GitHub
 * flow). The instance to target is selected by an optional `host` (a bare host
 * from the GitAuth picker / an authored prop) or `instanceUrl` (a manually-typed
 * instance URL that overrides `host`); both normalize to an origin and default
 * to gitlab.com. `gitlab:enumerate-hosts` lists the hosts glab is logged into to
 * drive the picker.
 */
import { Cause, Effect, Exit, ManagedRuntime } from "effect"
import { ipcMain } from "electron"
import { runtime, sessionManager, getSessionTokenForProvider } from "./runtime.ts"
import { GitLabClient } from "../../../src/services/GitLabClient.ts"
import { GitLabApiError } from "../../../src/errors/index.ts"
import {
  validateToken,
  detectTokenType,
  detectEnvCredentials,
  detectCliCredentials,
  detectConfigCredentials,
  detectConfigHosts,
  isEnvTokenHostAllowed,
} from "../../../src/domain/gitlab/auth.ts"
import { normalizeGitLabBaseUrl } from "../../../src/domain/git/gitlab-host.ts"

type ValidationResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly message: string; readonly status: number | undefined }

/**
 * Run a token-validation effect and recover the typed GitLabApiError on failure.
 *
 * `runtime.runPromise` rejects with a FiberFailure *wrapper*, so a plain
 * try/catch + `err instanceof GitLabApiError` never matches and the HTTP
 * `status` is lost (the renderer needs it to distinguish 401/403 from other
 * failures). `runPromiseExit` + `Cause.failureOption` recovers the real error —
 * the same approach as git.ts's `runAndUnwrap`.
 */
const runValidation = async <A>(
  program: Effect.Effect<A, GitLabApiError, ManagedRuntime.ManagedRuntime.Context<typeof runtime>>,
): Promise<ValidationResult<A>> => {
  const exit = await runtime.runPromiseExit(program)
  if (Exit.isSuccess(exit)) return { ok: true, value: exit.value }
  const failure = Cause.failureOption(exit.cause)
  const error = failure._tag === "Some" ? failure.value : undefined
  return {
    ok: false,
    message: error?.message ?? Cause.pretty(exit.cause),
    status: error instanceof GitLabApiError ? error.status : undefined,
  }
}

export function registerGitLabHandlers(): void {
  // Enumerate the GitLab hosts the user is logged into via glab, so the GitAuth
  // block can offer a host picker (gitlab.com vs a self-hosted instance).
  ipcMain.handle("gitlab:enumerate-hosts", async () => {
    return runtime.runPromise(detectConfigHosts())
  })

  ipcMain.handle(
    "gitlab:validate",
    async (_event, params: { token: string; host?: string; instanceUrl?: string }) => {
      const tokenType = detectTokenType(params.token)
      // A manually-entered instance URL overrides the picked/authored host;
      // either a bare host or a full URL normalizes to the instance origin.
      const baseUrl = normalizeGitLabBaseUrl(params.instanceUrl ?? params.host)
      const result = await runValidation(validateToken(params.token, baseUrl))
      if (result.ok) {
        const { user, scopes } = result.value
        return { valid: true, user, scopes, tokenType }
      }
      return {
        valid: false,
        tokenType,
        error: result.message,
        status: result.status,
      }
    },
  )

  ipcMain.handle(
    "gitlab:env-credentials",
    async (
      _event,
      params: {
        envVar?: string
        prefix?: string
        githubAuthId?: string
        host?: string
        instanceUrl?: string
      } = {},
    ) => {
      const token = await runtime.runPromise(detectEnvCredentials())
      if (!token) {
        return { found: false as const }
      }

      const tokenType = detectTokenType(token)
      // A manually-entered instance URL overrides the picked/authored host.
      const baseUrl = normalizeGitLabBaseUrl(params.instanceUrl ?? params.host)
      const host = new URL(baseUrl).host

      // GITLAB_TOKEN is host-agnostic, and detection runs on mount, so an
      // authored `host`/`instanceUrl` prop could otherwise make us POST the
      // user's token to an arbitrary origin with no interaction. Only auto-send
      // it to gitlab.com or a host the user has actually logged into via glab;
      // any other host requires the explicit PAT flow.
      const { hosts } = await runtime.runPromise(detectConfigHosts())
      if (!isEnvTokenHostAllowed(host, hosts)) {
        return { found: false as const }
      }

      const result = await runValidation(validateToken(token, baseUrl))
      if (!result.ok) {
        return {
          found: true as const,
          valid: false as const,
          token,
          tokenType,
          error: result.message,
          status: result.status,
          host,
        }
      }

      const { user, scopes } = result.value
      // Inject the token + its host into the session environment (mirrors
      // github.ts) so git operations can resolve the right credential.
      await runtime.runPromise(
        sessionManager.appendToEnv({ GITLAB_TOKEN: token, GITLAB_HOST: host }),
      )

      return {
        found: true as const,
        valid: true as const,
        token,
        user,
        scopes,
        tokenType,
        host,
      }
    },
  )

  ipcMain.handle(
    "gitlab:cli-credentials",
    async (_event, params: { host?: string; instanceUrl?: string } = {}) => {
      // Resolve which host to detect: a manually-entered instance URL wins over
      // the picked host; otherwise fall back to glab's own default host.
      const { defaultHost } = await runtime.runPromise(detectConfigHosts())
      const requested = params.instanceUrl ?? params.host
      const host = requested
        ? new URL(normalizeGitLabBaseUrl(requested)).host
        : defaultHost
      const baseUrl = normalizeGitLabBaseUrl(host)

      // `glab auth token` refreshes OAuth tokens, but it returns only glab's
      // DEFAULT host's token and (in current glab versions) cannot target a host
      // when several are configured. So only trust it for the default host;
      // every other host reads glab's config.yml directly, where `glab auth
      // login` stores the per-host token. config.yml is also the fallback when
      // the `glab` binary is not on PATH.
      const cliToken =
        host === defaultHost
          ? await runtime.runPromise(detectCliCredentials())
          : undefined
      const token =
        cliToken ?? (await runtime.runPromise(detectConfigCredentials(host)))
      if (!token) {
        return { found: false as const }
      }

      const tokenType = detectTokenType(token)

      const result = await runValidation(validateToken(token, baseUrl))
      if (!result.ok) {
        return {
          found: true as const,
          tokenType,
          error: result.message,
          status: result.status,
          host,
        }
      }

      const { user, scopes } = result.value
      // Inject the token + its host into the session environment so git
      // operations (e.g. git:clone) can resolve it server-side.
      await runtime.runPromise(
        sessionManager.appendToEnv({ GITLAB_TOKEN: token, GITLAB_HOST: host }),
      )

      return { found: true as const, token, user, scopes, tokenType, host }
    },
  )

  // List a GitLab project's labels for the MR label picker. Resolves the token
  // from the session env (populated by the GitAuth block), so the renderer
  // never handles it. Returns an empty list on failure — labels are enrichment
  // and must never block opening a merge request.
  ipcMain.handle(
    "gitlab:labels",
    async (_event, params: { owner: string; repo: string; host?: string }) => {
      const program = Effect.gen(function* () {
        const token = yield* getSessionTokenForProvider(
          "gitlab",
          () => new Error("No GitLab token available in session"),
        )
        // Target the repo's own GitLab instance (passed by the renderer from the
        // repo's remote); fall back to the host the auth block authenticated
        // against. A bare host or a URL normalizes to the API origin.
        const session = yield* sessionManager.getSession()
        const baseUrl = normalizeGitLabBaseUrl(
          params.host ?? session.env.get("GITLAB_HOST"),
        )
        const client = yield* GitLabClient
        return yield* client.listLabels(token, params.owner, params.repo, baseUrl)
      })

      try {
        const labels = await runtime.runPromise(program)
        return { labels }
      } catch {
        return { labels: [] }
      }
    },
  )
}
