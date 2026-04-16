/**
 * IPC handlers for GitHub authentication and API operations.
 *
 * Bridges Electron ipcMain to the GitHub auth domain module, providing token
 * validation, OAuth device flow, credential detection, and repository queries.
 */
import { Effect } from "effect"
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

/**
 * Resolve the GitHub token from the current session's environment. The env
 * is populated by github:env-credentials / github:cli-credentials / user
 * paste, and is the single source of truth for "which token do API calls
 * use" — the renderer never sees the token directly.
 */
const getSessionToken = () =>
  Effect.gen(function* () {
    const session = yield* sessionManager.getSession()
    const token = session.env.get("GITHUB_TOKEN")
    if (!token) {
      return yield* Effect.fail(new Error("No GitHub token available in session"))
    }
    return token
  })

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

  ipcMain.handle("github:orgs", async () => {
    return runtime.runPromise(
      Effect.gen(function* () {
        const token = yield* getSessionToken()
        return yield* listOrgs(token)
      }),
    )
  })

  ipcMain.handle(
    "github:repos",
    async (_event, params: { org: string; query?: string }) => {
      return runtime.runPromise(
        Effect.gen(function* () {
          const token = yield* getSessionToken()
          return yield* listRepos(token, params.org, params.query)
        }),
      )
    },
  )

  ipcMain.handle(
    "github:refs",
    async (
      _event,
      params: { owner: string; repo: string; query?: string },
    ) => {
      return runtime.runPromise(
        Effect.gen(function* () {
          const token = yield* getSessionToken()
          return yield* listRefs(token, params.owner, params.repo, params.query)
        }),
      )
    },
  )

  ipcMain.handle(
    "github:labels",
    async (_event, params: { owner: string; repo: string }) => {
      return runtime.runPromise(
        Effect.gen(function* () {
          const token = yield* getSessionToken()
          return yield* listLabels(token, params.owner, params.repo)
        }),
      )
    },
  )
}
