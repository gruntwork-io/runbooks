/**
 * IPC handlers for GitHub authentication and API operations.
 *
 * Detection and validation route through the unified VcsCredentials service
 * with the shared tri-state orchestration
 * (vcs-tristate.ts: cold trust-refresh-and-retry + probe on tls; nothing
 * on server-cert/network). Every handler targets one GitHub HOST — the
 * optional `host` param (github.com, a GHES host, or a `<sub>.ghe.com`
 * tenant), defaulting to github.com — and every token it reads, validates or
 * writes stays with that host. `github:enumerate-hosts` lists the hosts gh is
 * logged into (plus GH_HOST, the session host and recents) to drive the
 * GitAuth host picker, mirroring gitlab:enumerate-hosts.
 */
import { Effect } from "effect"
import { ipcMain } from "electron"
import { runtime, vcsSessionMeta, getGitHubSessionCredential } from "./runtime.ts"
import { Environment } from "../../../src/services/Environment.ts"
import {
  validateToken,
  detectTokenType,
  startOAuthDeviceFlow,
  pollOAuthToken,
  listOrgs,
  listRepos,
  listRefs,
  listLabels,
  detectHostsYmlCredentials,
  githubEnvTokenVarsForHost,
  githubSessionEnv,
  oauthUnavailableMessage,
  resolveOAuthClientId,
  ENV_PREFIX_PATTERN,
} from "../../../src/domain/github/auth.ts"
import {
  DEFAULT_GITHUB_HOST,
  isGitHubEnterpriseHost,
  tryNormalizeGitHubHost,
} from "../../../src/domain/git/github-host.ts"
import {
  withTlsOrchestration,
  withVcs,
  toDetectionIpcResult,
  toValidationIpcResult,
  appendSessionEnvAndRecord,
} from "./vcs-tristate.ts"
import { registerSecret } from "../../../src/domain/vcs/redact.ts"
import { readVcsAuthStore, addRecentGitHubHost, setLastSelectedGitHubHost } from "../recent-hosts.ts"

type HostSource = "gh" | "env" | "session" | "recent"

/**
 * Resolve a renderer-supplied GitHub host (a bare host or URL) with the
 * STRICT parse. Absent → github.com; present but unparseable → undefined, so
 * the handler refuses instead of sending anything to github.com.
 */
export function resolveRequestedGitHubHost(raw?: string | null): string | undefined {
  if (raw === undefined || raw === null || raw.trim() === "") return DEFAULT_GITHUB_HOST
  return tryNormalizeGitHubHost(raw)
}

const invalidHostError = (raw?: string | null) => `Invalid GitHub host: ${JSON.stringify(raw ?? "")}`

/**
 * The session's GitHub credential for `host` (undefined = the session's
 * GitHub host), failing with a plain Error (the message these handlers
 * surface). The session env is populated by the github:* detection/validation
 * handlers and is the single source of truth for "which token do API calls
 * use" — the renderer never sees the token directly.
 */
const getSessionCredential = (host?: string) =>
  getGitHubSessionCredential(host, () =>
    new Error(
      host
        ? `No GitHub token for ${tryNormalizeGitHubHost(host) ?? host} available in session`
        : "No GitHub token available in session",
    ),
  )

/**
 * Record a successful GitHub auth for `host`: persist the pick, and add an
 * enterprise host to the recents (the picker lists it next time, and the
 * window CSP allows its avatars on the next load).
 */
function rememberGitHubHost(host: string): void {
  setLastSelectedGitHubHost(host)
  if (isGitHubEnterpriseHost(host)) addRecentGitHubHost(host)
}

/**
 * Write a validated GitHub credential to the session env (githubSessionEnv:
 * token, user, and the host it belongs to) and record the host binding.
 */
const writeGitHubSession = (
  host: string,
  source: string | undefined,
  token: string,
  login?: string,
): Promise<string | undefined> =>
  appendSessionEnvAndRecord("github", host, source, githubSessionEnv(host, token, login))

/**
 * Build the merged host union for the picker: gh's hosts.yml hosts, GH_HOST,
 * the session host, persisted recents, and always github.com — deduped by
 * normalized host, each annotated with provenance and an OFFLINE-ONLY
 * hasCredential check (an env token bound to the host, or a hosts.yml entry
 * for it — a token on disk or the keyring marker; no network, no gh spawn).
 */
export async function buildMergedGitHubHosts(): Promise<{
  hosts: Array<{ host: string; sources: HostSource[]; hasCredential: boolean }>
  defaultHost: string
}> {
  const [{ configHosts, envHost }, allEnv] = await Promise.all([
    withVcs((vcs) => vcs.enumerateGitHubHosts()),
    runtime.runPromise(Effect.flatMap(Environment, (environment) => environment.getAll())),
  ])
  const sessionHost = vcsSessionMeta.get("github")?.host
  const store = readVcsAuthStore()

  const union = new Map<string, Set<HostSource>>()
  const add = (raw: string, source?: HostSource) => {
    const host = tryNormalizeGitHubHost(raw)
    if (!host) return
    const entry = union.get(host) ?? new Set<HostSource>()
    if (source) entry.add(source)
    union.set(host, entry)
  }
  add(DEFAULT_GITHUB_HOST)
  for (const host of configHosts) add(host, "gh")
  if (envHost) add(envHost, "env")
  if (sessionHost) add(sessionHost, "session")
  for (const host of store.recentGitHubHosts) add(host, "recent")

  const hasCredentialFor = async (host: string): Promise<boolean> => {
    if (githubEnvTokenVarsForHost(host, allEnv).some((name) => (allEnv[name] ?? "").trim() !== "")) {
      return true
    }
    return (await runtime.runPromise(detectHostsYmlCredentials(host))).entryExists
  }

  const hosts = await Promise.all(
    [...union].map(async ([host, sources]) => ({
      host,
      sources: [...sources],
      hasCredential: await hasCredentialFor(host),
    })),
  )

  // defaultHost precedence (an authored `host` prop pins the host
  // renderer-side and never reaches this handler): the persisted pick —
  // honored only while still credentialed, so a stale pick can't steal
  // auto-detect from a working github.com token — then GH_HOST, then
  // github.com (gh's own default).
  const last = tryNormalizeGitHubHost(store.lastSelectedGitHubHost)
  const lastEntry = last ? hosts.find((h) => h.host === last) : undefined
  const defaultHost = (lastEntry?.hasCredential ? lastEntry.host : undefined) ?? envHost ?? DEFAULT_GITHUB_HOST
  return { hosts, defaultHost }
}

export function registerGitHubHandlers(): void {
  // Enumerate the GitHub hosts the user can pick from (see buildMergedGitHubHosts).
  ipcMain.handle("github:enumerate-hosts", () => buildMergedGitHubHosts())

  // Persist an explicit dropdown pick so it survives restart. Hostnames only.
  ipcMain.handle("github:host-picked", (_event, params: { host: string }) => {
    const host = tryNormalizeGitHubHost(params.host)
    if (host) setLastSelectedGitHubHost(host)
    return { ok: true as const }
  })

  ipcMain.handle(
    "github:validate",
    async (
      _event,
      params: { token?: string; host?: string; registerSession?: boolean; useSessionToken?: boolean },
    ) => {
      const host = resolveRequestedGitHubHost(params.host)
      if (!host) {
        return { valid: false, outcome: "invalid" as const, error: invalidHostError(params.host) }
      }
      // Session mode validates the session credential FOR THIS HOST only.
      const token = params.useSessionToken
        ? await runtime.runPromise(
            getGitHubSessionCredential(host, () => new Error("none")).pipe(
              Effect.map((credential) => credential.token),
              Effect.orElseSucceed(() => undefined),
            ),
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
        host,
        detect: () => withVcs((vcs) => vcs.validateDirect("github", host, token)),
        probeSource: "manual",
      })
      if (result.outcome === "valid") {
        let sessionEnvWarning: string | undefined
        if (params.registerSession && !params.useSessionToken && result.user) {
          sessionEnvWarning = await writeGitHubSession(host, "manual", token, result.user.login)
        }
        rememberGitHubHost(host)
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
      return { ...toValidationIpcResult(result, host), valid: false, tokenType }
    },
  )

  ipcMain.handle(
    "github:oauth-start",
    async (
      _event,
      params: { clientId?: string; scopes?: string[]; host?: string },
    ) => {
      const host = resolveRequestedGitHubHost(params.host)
      if (!host) throw new Error(invalidHostError(params.host))
      // An enterprise host needs an OAuth app registered on that instance; the
      // github.com default never applies there, and the flow never silently
      // moves to github.com.
      const clientId = resolveOAuthClientId(host, params.clientId)
      if (!clientId) throw new Error(oauthUnavailableMessage(host))
      const scopes = params.scopes ?? ["repo", "read:org"]
      return runtime.runPromise(startOAuthDeviceFlow(clientId, scopes, host))
    },
  )

  ipcMain.handle(
    "github:oauth-poll",
    async (_event, params: { clientId?: string; deviceCode: string; host?: string }) => {
      const host = resolveRequestedGitHubHost(params.host)
      if (!host) return { status: "failed" as const, error: invalidHostError(params.host) }
      const clientId = resolveOAuthClientId(host, params.clientId)
      if (!clientId) return { status: "failed" as const, error: oauthUnavailableMessage(host) }
      try {
        const result = await runtime.runPromise(
          pollOAuthToken(clientId, params.deviceCode, host),
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
          validateToken(result.token, host),
        )

        const sessionEnvWarning = await writeGitHubSession(host, "oauth", result.token, user.login)
        rememberGitHubHost(host)

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

      const host = resolveRequestedGitHubHost(params.host)
      if (!host) {
        return { found: false as const, outcome: "absent" as const, error: invalidHostError(params.host) }
      }

      // env-token host binding is enforced inside detectGitHubEnv.
      const result = await withTlsOrchestration({
        provider: "github",
        host,
        detect: () => withVcs((vcs) => vcs.detectGitHubEnv(host, prefix)),
      })

      let sessionEnvWarning: string | undefined
      if (result.outcome === "valid" && result.token) {
        sessionEnvWarning = await writeGitHubSession(host, result.source, result.token, result.user?.login)
        rememberGitHubHost(host)
      }

      return {
        ...toDetectionIpcResult(result, host),
        ...(result.token ? { tokenType: detectTokenType(result.token) } : {}),
        ...(sessionEnvWarning ? { sessionEnvWarning } : {}),
      }
    },
  )

  ipcMain.handle("github:cli-credentials", async (_event, params: { host?: string } = {}) => {
    const host = resolveRequestedGitHubHost(params?.host)
    if (!host) {
      return { found: false as const, outcome: "absent" as const, error: invalidHostError(params?.host) }
    }
    const result = await withTlsOrchestration({
      provider: "github",
      host,
      detect: () => withVcs((vcs) => vcs.detectGitHubCli(host)),
    })

    let sessionEnvWarning: string | undefined
    if (result.outcome === "valid" && result.token) {
      sessionEnvWarning = await writeGitHubSession(host, result.source, result.token, result.user?.login)
      rememberGitHubHost(host)
    }

    return {
      ...toDetectionIpcResult(result, host),
      ...(result.token ? { tokenType: detectTokenType(result.token) } : {}),
      ...(sessionEnvWarning ? { sessionEnvWarning } : {}),
    }
  })

  // API queries run against the session's GitHub credential. `host` (the
  // linked auth block's host) selects which one; omitted, it is the session's
  // GitHub host. The token is released only for the host it belongs to, and
  // the request goes to that host's API.
  ipcMain.handle("github:orgs", async (_event, params?: { host?: string }) => {
    return runtime.runPromise(
      Effect.gen(function* () {
        const { token, host } = yield* getSessionCredential(params?.host)
        return yield* listOrgs(token, host)
      }),
    )
  })

  ipcMain.handle(
    "github:repos",
    async (_event, params: { org: string; query?: string; host?: string }) => {
      return runtime.runPromise(
        Effect.gen(function* () {
          const { token, host } = yield* getSessionCredential(params.host)
          return yield* listRepos(token, params.org, params.query, host)
        }),
      )
    },
  )

  ipcMain.handle(
    "github:refs",
    async (
      _event,
      params: { owner: string; repo: string; query?: string; host?: string },
    ) => {
      return runtime.runPromise(
        Effect.gen(function* () {
          const { token, host } = yield* getSessionCredential(params.host)
          return yield* listRefs(token, params.owner, params.repo, params.query, host)
        }),
      )
    },
  )

  ipcMain.handle(
    "github:labels",
    async (_event, params: { owner: string; repo: string; host?: string }) => {
      return runtime.runPromise(
        Effect.gen(function* () {
          const { token, host } = yield* getSessionCredential(params.host)
          return yield* listLabels(token, params.owner, params.repo, host)
        }),
      )
    },
  )
}
