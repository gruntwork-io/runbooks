/**
 * IPC handlers for GitLab authentication operations.
 *
 * Bridges Electron ipcMain to the GitLab auth domain module, providing token
 * validation and credential detection (env var, `glab` CLI, and glab's
 * config.yml). Mirrors github.ts:
 * detection handlers inject the resolved token into the session environment so
 * git operations can resolve it server-side, while `gitlab:validate` only
 * validates (the renderer owns the PAT-paste session write, matching the GitHub
 * flow). An optional `instanceUrl` targets a self-hosted GitLab instance for
 * validation/detection; it defaults to gitlab.com.
 */
import { Effect } from "effect"
import { ipcMain } from "electron"
import { runtime, sessionManager, getSessionTokenForProvider } from "./runtime.ts"
import { GitLabClient } from "../../../src/services/GitLabClient.ts"
import {
  validateToken,
  detectTokenType,
  detectEnvCredentials,
  detectCliCredentials,
  detectConfigCredentials,
} from "../../../src/domain/gitlab/auth.ts"
import { normalizeGitLabBaseUrl } from "../../../src/domain/git/gitlab-host.ts"

export function registerGitLabHandlers(): void {
  ipcMain.handle(
    "gitlab:validate",
    async (_event, params: { token: string; instanceUrl?: string }) => {
      const tokenType = detectTokenType(params.token)
      const baseUrl = normalizeGitLabBaseUrl(params.instanceUrl)
      try {
        const { user, scopes } = await runtime.runPromise(
          validateToken(params.token, baseUrl),
        )
        return { valid: true, user, scopes, tokenType }
      } catch (err) {
        return {
          valid: false,
          tokenType,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    },
  )

  ipcMain.handle("gitlab:env-credentials", async (_event, params?: { envVar?: string; prefix?: string; githubAuthId?: string; instanceUrl?: string }) => {
    const token = await runtime.runPromise(detectEnvCredentials())
    if (!token) {
      return { found: false as const }
    }

    const tokenType = detectTokenType(token)
    const baseUrl = normalizeGitLabBaseUrl(params?.instanceUrl)

    try {
      const { user, scopes } = await runtime.runPromise(validateToken(token, baseUrl))

      // Inject the token into the session environment (mirrors github.ts).
      await runtime.runPromise(
        sessionManager.appendToEnv({ GITLAB_TOKEN: token }),
      )

      return {
        found: true as const,
        valid: true as const,
        token,
        user,
        scopes,
        tokenType,
      }
    } catch (err) {
      return {
        found: true as const,
        valid: false as const,
        token,
        tokenType,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  })

  ipcMain.handle("gitlab:cli-credentials", async (_event, params?: { instanceUrl?: string }) => {
    const baseUrl = normalizeGitLabBaseUrl(params?.instanceUrl)
    const host = new URL(baseUrl).host
    // Prefer the `glab` binary (it refreshes OAuth tokens); if it yields no
    // token (not on PATH, not installed, not authenticated, or it timed out),
    // read glab's config.yml directly for the target host, where
    // `glab auth login` stores the token.
    const token =
      (await runtime.runPromise(detectCliCredentials())) ??
      (await runtime.runPromise(detectConfigCredentials(host)))
    if (!token) {
      return { found: false as const }
    }

    const tokenType = detectTokenType(token)

    try {
      const { user, scopes } = await runtime.runPromise(validateToken(token, baseUrl))

      // Inject the token into the session environment so git operations
      // (e.g. git:clone) can resolve it server-side, matching the
      // env-credentials path.
      await runtime.runPromise(
        sessionManager.appendToEnv({ GITLAB_TOKEN: token }),
      )

      return { found: true as const, token, user, scopes, tokenType }
    } catch (err) {
      return {
        found: true as const,
        tokenType,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  })

  // List a GitLab project's labels for the MR label picker. Resolves the token
  // from the session env (populated by the GitAuth block), so the renderer
  // never handles it. Returns an empty list on failure — labels are enrichment
  // and must never block opening a merge request.
  ipcMain.handle(
    "gitlab:labels",
    async (_event, params: { owner: string; repo: string; host?: string }) => {
      const baseUrl = normalizeGitLabBaseUrl(params.host)
      const program = Effect.gen(function* () {
        const token = yield* getSessionTokenForProvider(
          "gitlab",
          () => new Error("No GitLab token available in session"),
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
