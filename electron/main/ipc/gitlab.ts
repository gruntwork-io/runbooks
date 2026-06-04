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
import { ipcMain } from "electron"
import { runtime, sessionManager } from "./runtime.ts"
import {
  validateToken,
  detectTokenType,
  detectEnvCredentials,
  detectCliCredentials,
  detectConfigCredentials,
} from "../../../src/domain/gitlab/auth.ts"

export function registerGitLabHandlers(): void {
  ipcMain.handle(
    "gitlab:validate",
    async (_event, params: { token: string }) => {
      const tokenType = detectTokenType(params.token)
      try {
        const { user, scopes } = await runtime.runPromise(
          validateToken(params.token),
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

  ipcMain.handle("gitlab:env-credentials", async () => {
    const token = await runtime.runPromise(detectEnvCredentials())
    if (!token) {
      return { found: false as const }
    }

    const tokenType = detectTokenType(token)

    try {
      const { user, scopes } = await runtime.runPromise(validateToken(token))

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

  ipcMain.handle("gitlab:cli-credentials", async () => {
    // Prefer the `glab` binary (it refreshes OAuth tokens), then fall back to
    // reading glab's config.yml directly. `glab auth login` only writes the
    // token to config.yml, and the binary may not be on PATH inside Electron's
    // spawn environment, so the file is the more reliable source.
    const token =
      (await runtime.runPromise(detectCliCredentials())) ??
      (await runtime.runPromise(detectConfigCredentials()))
    if (!token) {
      return { found: false as const }
    }

    const tokenType = detectTokenType(token)

    try {
      const { user, scopes } = await runtime.runPromise(validateToken(token))

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
}
