/**
 * IPC handlers for GitLab authentication operations.
 *
 * Bridges Electron ipcMain to the GitLab auth domain module, providing token
 * validation and credential detection (env var, `glab` CLI, and glab's
 * config.yml). Mirrors github.ts:
 * detection handlers inject the resolved token into the session environment so
 * git operations against gitlab.com can resolve it server-side, while
 * `gitlab:validate` only validates (the renderer owns the PAT-paste session
 * write, matching the GitHub flow).
 */
import { Effect } from "effect"
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
  DEFAULT_GITLAB_HOST,
} from "../../../src/domain/gitlab/auth.ts"

/** HTTP status from a failed validation, when the failure was a GitLab API error. */
const errorStatus = (err: unknown): number | undefined =>
  err instanceof GitLabApiError ? err.status : undefined

export function registerGitLabHandlers(): void {
  // Enumerate the GitLab hosts the user is logged into via glab, so the GitAuth
  // block can offer a host picker (gitlab.com vs a self-hosted instance).
  ipcMain.handle("gitlab:enumerate-hosts", async () => {
    return runtime.runPromise(detectConfigHosts())
  })

  ipcMain.handle(
    "gitlab:validate",
    async (_event, params: { token: string; host?: string }) => {
      const host = params.host ?? DEFAULT_GITLAB_HOST
      const tokenType = detectTokenType(params.token)
      try {
        const { user, scopes } = await runtime.runPromise(
          validateToken(params.token, host),
        )
        return { valid: true, user, scopes, tokenType }
      } catch (err) {
        return {
          valid: false,
          tokenType,
          error: err instanceof Error ? err.message : String(err),
          status: errorStatus(err),
        }
      }
    },
  )

  ipcMain.handle(
    "gitlab:env-credentials",
    async (_event, params: { host?: string } = {}) => {
      const host = params.host ?? DEFAULT_GITLAB_HOST
      const token = await runtime.runPromise(detectEnvCredentials())
      if (!token) {
        return { found: false as const }
      }

      const tokenType = detectTokenType(token)

      try {
        const { user, scopes } = await runtime.runPromise(validateToken(token, host))

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
      } catch (err) {
        return {
          found: true as const,
          valid: false as const,
          token,
          tokenType,
          error: err instanceof Error ? err.message : String(err),
          status: errorStatus(err),
          host,
        }
      }
    },
  )

  ipcMain.handle(
    "gitlab:cli-credentials",
    async (_event, params: { host?: string } = {}) => {
      // Resolve which host to detect: the caller's pick, else glab's default.
      const { defaultHost } = await runtime.runPromise(detectConfigHosts())
      const host = params.host ?? defaultHost

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

      try {
        const { user, scopes } = await runtime.runPromise(validateToken(token, host))

        // Inject the token + its host into the session environment so git
        // operations (e.g. git:clone) can resolve it server-side.
        await runtime.runPromise(
          sessionManager.appendToEnv({ GITLAB_TOKEN: token, GITLAB_HOST: host }),
        )

        return { found: true as const, token, user, scopes, tokenType, host }
      } catch (err) {
        return {
          found: true as const,
          tokenType,
          error: err instanceof Error ? err.message : String(err),
          status: errorStatus(err),
          host,
        }
      }
    },
  )

  // List a GitLab project's labels for the MR label picker. Resolves the token
  // from the session env (populated by the GitAuth block), so the renderer
  // never handles it. Returns an empty list on failure — labels are enrichment
  // and must never block opening a merge request.
  ipcMain.handle(
    "gitlab:labels",
    async (_event, params: { owner: string; repo: string }) => {
      const program = Effect.gen(function* () {
        const token = yield* getSessionTokenForProvider(
          "gitlab",
          () => new Error("No GitLab token available in session"),
        )
        // The host the auth block authenticated against (gitlab.com when unset),
        // so labels are fetched from the same instance the token belongs to.
        const session = yield* sessionManager.getSession()
        const host = session.env.get("GITLAB_HOST")
        const client = yield* GitLabClient
        return yield* client.listLabels(token, params.owner, params.repo, host)
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
