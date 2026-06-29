/**
 * IPC handlers for GitHub authentication and API operations.
 *
 * Detection and validation route through the unified VcsCredentials service
 * with the shared tri-state orchestration
 * (vcs-tristate.ts: cold trust-refresh-and-retry + probe on tls; nothing
 * on server-cert/network). The OAuth device flow and the API query handlers
 * keep their existing shapes.
 */
import { Effect } from "effect"
import { ipcMain } from "electron"
import {
  runtime,
  getSessionToken as resolveSessionToken,
} from "./runtime.ts"
import {
  validateToken,
  detectTokenType,
  startOAuthDeviceFlow,
  pollOAuthToken,
  listOrgs,
  listRepos,
  listRefs,
  listLabels,
  DEFAULT_GITHUB_OAUTH_CLIENT_ID,
  ENV_PREFIX_PATTERN,
} from "../../../src/domain/github/auth.ts"
import {
  withTlsOrchestration,
  withVcs,
  toDetectionIpcResult,
  toValidationIpcResult,
  appendSessionEnvAndRecord,
} from "./vcs-tristate.ts"
import { registerSecret } from "../../../src/domain/vcs/redact.ts"

/**
 * Resolve the GitHub token from the session env, failing with a plain Error
 * (the message these handlers surface from their catch blocks). The env is
 * populated by github:env-credentials / github:cli-credentials / user paste,
 * and is the single source of truth for "which token do API calls use" — the
 * renderer never sees the token directly. See getSessionToken() in runtime.ts.
 */
const getSessionToken = () =>
  resolveSessionToken(() => new Error("No GitHub token available in session"))

export function registerGitHubHandlers(): void {
  ipcMain.handle(
    "github:validate",
    // `host` is part of the channel contract (GitHub is single-host, so it's
    // accepted and ignored) — annotate it for parity with the channel type.
    async (
      _event,
      params: { token?: string; host?: string; registerSession?: boolean; useSessionToken?: boolean },
    ) => {
      const token = params.useSessionToken
        ? await runtime.runPromise(
            resolveSessionToken(() => new Error("none")).pipe(Effect.orElseSucceed(() => undefined)),
          )
        : params.token
      if (!token) {
        return {
          valid: false,
          outcome: "invalid" as const,
          error: params.useSessionToken
            ? "No GitHub session credential available"
            : "No token provided",
        }
      }
      registerSecret(token)
      const tokenType = detectTokenType(token)
      const result = await withTlsOrchestration({
        provider: "github",
        host: "github.com",
        detect: () => withVcs((vcs) => vcs.validateDirect("github", "github.com", token)),
        probeSource: "manual",
      })
      if (result.outcome === "valid") {
        let sessionEnvWarning: string | undefined
        if (params.registerSession && !params.useSessionToken && result.user) {
          sessionEnvWarning = await appendSessionEnvAndRecord("github", "github.com", "manual", {
            GITHUB_TOKEN: token,
            GITHUB_USER: result.user.login,
          })
        }
        return {
          valid: true,
          user: result.user,
          scopes: result.scopes,
          tokenType,
          outcome: "valid" as const,
          ...(result.validatedVia ? { validatedVia: result.validatedVia } : {}),
          ...(sessionEnvWarning ? { sessionEnvWarning } : {}),
        }
      }
      return { ...toValidationIpcResult(result), valid: false, tokenType }
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
      try {
        const result = await runtime.runPromise(
          pollOAuthToken(clientId, params.deviceCode),
        )

        if (result.pending) {
          return { status: "pending" as const }
        }

        if (!result.token) {
          return { status: "failed" as const, error: "No access token returned" }
        }

        registerSecret(result.token)
        const tokenType = detectTokenType(result.token)
        const { user, scopes } = await runtime.runPromise(
          validateToken(result.token),
        )

        const sessionEnvWarning = await appendSessionEnvAndRecord("github", "github.com", "oauth", {
          GITHUB_TOKEN: result.token,
          GITHUB_USER: user.login,
        })

        // the completion result is METADATA-ONLY — the session env above
        // is the single source of truth; the token never crosses IPC.
        return {
          status: "complete" as const,
          user,
          scopes,
          tokenType,
          ...(sessionEnvWarning ? { sessionEnvWarning } : {}),
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (message.includes("expired_token") || message.includes("expired")) {
          return { status: "expired" as const, error: message }
        }
        if (message.includes("access_denied")) {
          return { status: "failed" as const, error: "Authorization was denied" }
        }
        if (message.includes("slow_down")) {
          return { status: "pending" as const, slowDown: true }
        }
        return { status: "failed" as const, error: message }
      }
    },
  )

  ipcMain.handle(
    "github:env-credentials",
    async (_event, params: { envVar?: string; prefix?: string; githubAuthId?: string; host?: string } = {}) => {
      // The {env:{prefix}} variant: the renderer-supplied prefix is
      // untrusted input — allowlist-validated IN MAIN, rejected otherwise.
      const prefix = params.prefix || undefined
      if (prefix !== undefined && !ENV_PREFIX_PATTERN.test(prefix)) {
        return {
          found: false as const,
          outcome: "absent" as const,
          error: `Invalid env prefix "${prefix}": must match ${ENV_PREFIX_PATTERN}`,
        }
      }

      const result = await withTlsOrchestration({
        provider: "github",
        host: "github.com",
        detect: () => withVcs((vcs) => vcs.detectGitHubEnv(prefix)),
      })

      let sessionEnvWarning: string | undefined
      if (result.outcome === "valid" && result.token) {
        sessionEnvWarning = await appendSessionEnvAndRecord("github", "github.com", result.source, {
          GITHUB_TOKEN: result.token,
          ...(result.user ? { GITHUB_USER: result.user.login } : {}),
        })
      }

      return {
        ...toDetectionIpcResult(result),
        ...(result.token ? { tokenType: detectTokenType(result.token) } : {}),
        ...(sessionEnvWarning ? { sessionEnvWarning } : {}),
      }
    },
  )

  ipcMain.handle("github:cli-credentials", async () => {
    const result = await withTlsOrchestration({
      provider: "github",
      host: "github.com",
      detect: () => withVcs((vcs) => vcs.detectGitHubCli()),
    })

    let sessionEnvWarning: string | undefined
    if (result.outcome === "valid" && result.token) {
      sessionEnvWarning = await appendSessionEnvAndRecord("github", "github.com", result.source, {
        GITHUB_TOKEN: result.token,
        ...(result.user ? { GITHUB_USER: result.user.login } : {}),
      })
    }

    return {
      ...toDetectionIpcResult(result),
      ...(result.token ? { tokenType: detectTokenType(result.token) } : {}),
      ...(sessionEnvWarning ? { sessionEnvWarning } : {}),
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
