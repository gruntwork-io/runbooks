/**
 * IPC handlers for GitHub authentication and API operations.
 *
 * Bridges Electron ipcMain to the GitHub auth domain module, providing token
 * validation, OAuth device flow, credential detection, and repository queries.
 */
import { ipcMain } from "electron"
import { runtime, sessionManager } from "./runtime.ts"
import {
  validateToken,
  detectTokenType,
  startOAuthDeviceFlow,
  pollOAuthToken,
  detectEnvCredentials,
  detectCliCredentials,
  listOrgs,
  listRepos,
  listRefs,
  listLabels,
  DEFAULT_GITHUB_OAUTH_CLIENT_ID,
} from "../../../src/domain/github/auth.ts"

export function registerGitHubHandlers(): void {
  ipcMain.handle(
    "github:validate",
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

  ipcMain.handle(
    "github:oauth-start",
    async (
      _event,
      params: { clientId?: string; scopes?: string[] },
    ) => {
      const clientId = params.clientId ?? DEFAULT_GITHUB_OAUTH_CLIENT_ID
      const scopes = params.scopes ?? ["repo", "read:org"]
      return runtime.runPromise(startOAuthDeviceFlow(clientId, scopes))
    },
  )

  ipcMain.handle(
    "github:oauth-poll",
    async (_event, params: { clientId?: string; deviceCode: string }) => {
      const clientId = params.clientId ?? DEFAULT_GITHUB_OAUTH_CLIENT_ID
      return runtime.runPromise(pollOAuthToken(clientId, params.deviceCode))
    },
  )

  ipcMain.handle("github:env-credentials", async () => {
    const token = await runtime.runPromise(detectEnvCredentials())
    if (!token) {
      return { found: false as const }
    }

    const tokenType = detectTokenType(token)

    try {
      const { user, scopes } = await runtime.runPromise(validateToken(token))

      // Inject the token into the session environment
      await runtime.runPromise(
        sessionManager.appendToEnv({ GITHUB_TOKEN: token }),
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

  ipcMain.handle("github:cli-credentials", async () => {
    const token = await runtime.runPromise(detectCliCredentials())
    if (!token) {
      return { found: false as const }
    }

    const tokenType = detectTokenType(token)

    try {
      const { user, scopes } = await runtime.runPromise(validateToken(token))
      return { found: true as const, token, user, scopes, tokenType }
    } catch (err) {
      return {
        found: true as const,
        tokenType,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  })

  ipcMain.handle(
    "github:orgs",
    async (_event, params: { token: string }) => {
      return runtime.runPromise(listOrgs(params.token))
    },
  )

  ipcMain.handle(
    "github:repos",
    async (_event, params: { token: string; org: string; query?: string }) => {
      return runtime.runPromise(
        listRepos(params.token, params.org, params.query),
      )
    },
  )

  ipcMain.handle(
    "github:refs",
    async (
      _event,
      params: { token: string; owner: string; repo: string; query?: string },
    ) => {
      return runtime.runPromise(
        listRefs(params.token, params.owner, params.repo, params.query),
      )
    },
  )

  ipcMain.handle(
    "github:labels",
    async (
      _event,
      params: { token: string; owner: string; repo: string },
    ) => {
      return runtime.runPromise(
        listLabels(params.token, params.owner, params.repo),
      )
    },
  )
}
