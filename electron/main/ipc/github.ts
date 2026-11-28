/**
 * IPC handlers for GitHub authentication and API operations.
 *
 * Detection and validation route through the unified VcsCredentials service
 * with the shared tri-state orchestration
 * (vcs-tristate.ts: cold trust-refresh-and-retry + probe on tls; nothing
 * on server-cert/network). Every handler targets one GitHub HOST — the
 * optional `host` param (github.com, a GHES host, or a `<sub>.ghe.com`
 * tenant), defaulting to github.com — and every token it reads, validates or
 * writes stays with that host. A sign-in made for a block (`componentId`) is
 * saved as that block's export, which a block that names it in envFrom gets.
 * `github:enumerate-hosts` lists the hosts gh is logged into (plus GH_HOST and
 * recents) to drive the GitAuth host picker, mirroring gitlab:enumerate-hosts.
 */
import { Effect } from "effect"
import { ipcMain } from "electron"
import {
  runtime,
  sessionManager,
  exportedVcsCredential,
  getExportedVcsCredential,
} from "./runtime.ts"
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
  saveVcsExport,
} from "./vcs-tristate.ts"
import { registerSecret } from "../../../src/domain/vcs/redact.ts"
import {
  readVcsAuthStore,
  addRecentGitHubHost,
  setLastSelectedGitHubHost,
} from "../recent-hosts.ts"
import { errorMessage } from "../../../src/errors/message.ts"
import { MissingCredentialError } from "../../../src/errors/index.ts"

type HostSource = "gh" | "env" | "recent"

/**
 * Resolve a renderer-supplied GitHub host (a bare host or URL) with the
 * STRICT parse. Absent → github.com; present but unparseable → undefined, so
 * the handler refuses instead of sending anything to github.com.
 */
export function resolveRequestedGitHubHost(raw?: string | null): string | undefined {
  if (raw === undefined || raw === null || raw.trim() === "") return DEFAULT_GITHUB_HOST
  return tryNormalizeGitHubHost(raw)
}

const invalidHostError = (raw?: string | null) =>
  `Invalid GitHub host: ${JSON.stringify(raw ?? "")}`

/**
 * The GitHub credential `envFrom` gives for `host` (undefined = the host of
 * the GitHub Auth block it names), failing with a
 * MissingCredentialError whose message these handlers surface. The
 * token stays in the main process: the renderer sends block ids, never a
 * token.
 */
const getBlockCredential = (envFrom: readonly string[] | undefined, host?: string) =>
  getExportedVcsCredential(
    "github",
    envFrom ?? [],
    host,
    () =>
      new MissingCredentialError({
        message: host
          ? `No GitHub sign-in for ${tryNormalizeGitHubHost(host) ?? host}. Name a GitHub Auth block for that host in envFrom.`
          : "No GitHub sign-in. Name a GitHub Auth block in envFrom.",
      }),
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
 * Save a validated GitHub credential as block `componentId`'s export
 * (githubSessionEnv: token, user, and the host it belongs to). Nothing is
 * saved for a request that names no block. `generation` is the session
 * generation captured when the request arrived.
 */
const saveGitHubExport = (
  componentId: string | undefined,
  generation: number,
  host: string,
  token: string,
  login?: string,
): Promise<void> =>
  componentId === undefined
    ? Promise.resolve()
    : saveVcsExport("github", componentId, githubSessionEnv(host, token, login), generation)

/**
 * Build the merged host union for the picker: gh's hosts.yml hosts, GH_HOST,
 * persisted recents, and always github.com — deduped by
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
  for (const host of store.recentGitHubHosts) add(host, "recent")

  const hasCredentialFor = async (host: string): Promise<boolean> => {
    if (
      githubEnvTokenVarsForHost(host, allEnv).some((name) => (allEnv[name] ?? "").trim() !== "")
    ) {
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
  const defaultHost =
    (lastEntry?.hasCredential ? lastEntry.host : undefined) ?? envHost ?? DEFAULT_GITHUB_HOST
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
      params: {
        token?: string
        host?: string
        componentId?: string
        registerSession?: boolean
        fromBlock?: string
      },
    ) => {
      const generation = sessionManager.getGeneration()
      const host = resolveRequestedGitHubHost(params.host)
      if (!host) {
        return { valid: false, outcome: "invalid" as const, error: invalidHostError(params.host) }
      }
      // A block's sign-in is validated for THIS HOST only.
      const token =
        params.fromBlock !== undefined
          ? exportedVcsCredential("github", [params.fromBlock], host)?.token
          : params.token
      if (!token) {
        return {
          valid: false,
          outcome: "invalid" as const,
          error:
            params.fromBlock !== undefined
              ? `${params.fromBlock} has no GitHub sign-in for ${host}`
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
        if (params.registerSession && result.user) {
          await saveGitHubExport(params.componentId, generation, host, token, result.user.login)
        }
        rememberGitHubHost(host)
        return {
          valid: true,
          host,
          user: result.user,
          scopes: result.scopes,
          ...(result.expiresAt ? { expiresAt: result.expiresAt } : {}),
          tokenType,
          outcome: "valid" as const,
          ...(result.validatedVia ? { validatedVia: result.validatedVia } : {}),
        }
      }
      return { ...toValidationIpcResult(result, host), valid: false, tokenType }
    },
  )

  ipcMain.handle(
    "github:oauth-start",
    async (_event, params: { clientId?: string; scopes?: string[]; host?: string }) => {
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
    async (
      _event,
      params: { clientId?: string; deviceCode: string; host?: string; componentId?: string },
    ) => {
      const generation = sessionManager.getGeneration()
      const host = resolveRequestedGitHubHost(params.host)
      if (!host) return { status: "failed" as const, error: invalidHostError(params.host) }
      const clientId = resolveOAuthClientId(host, params.clientId)
      if (!clientId) return { status: "failed" as const, error: oauthUnavailableMessage(host) }
      try {
        const result = await runtime.runPromise(pollOAuthToken(clientId, params.deviceCode, host))

        if (result.pending) {
          return {
            status: "pending" as const,
            ...(result.slowDown ? { slowDown: true, interval: result.interval } : {}),
          }
        }

        if (!result.token) {
          return { status: "failed" as const, error: "No access token returned" }
        }

        registerSecret(result.token)
        const tokenType = detectTokenType(result.token)
        const { user, scopes, expiresAt } = await runtime.runPromise(
          validateToken(result.token, host),
        )

        await saveGitHubExport(params.componentId, generation, host, result.token, user.login)
        rememberGitHubHost(host)

        // The completion result is metadata only: the token stays in the
        // block's export and never crosses IPC.
        return {
          status: "complete" as const,
          user,
          scopes,
          ...(expiresAt ? { expiresAt } : {}),
          tokenType,
        }
      } catch (err) {
        const message = errorMessage(err)
        if (message.includes("expired_token") || message.includes("expired")) {
          return { status: "expired" as const, error: message }
        }
        if (message.includes("access_denied")) {
          return { status: "failed" as const, error: "Authorization was denied" }
        }
        return { status: "failed" as const, error: message }
      }
    },
  )

  ipcMain.handle(
    "github:env-credentials",
    async (_event, params: { prefix?: string; host?: string; componentId?: string } = {}) => {
      const generation = sessionManager.getGeneration()
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
        return {
          found: false as const,
          outcome: "absent" as const,
          error: invalidHostError(params.host),
        }
      }

      // env-token host binding is enforced inside detectGitHubEnv.
      const result = await withTlsOrchestration({
        provider: "github",
        host,
        detect: () => withVcs((vcs) => vcs.detectGitHubEnv(host, prefix)),
      })

      if (result.outcome === "valid" && result.token) {
        await saveGitHubExport(
          params.componentId,
          generation,
          host,
          result.token,
          result.user?.login,
        )
        rememberGitHubHost(host)
      }

      return {
        ...toDetectionIpcResult(result, host),
        ...(result.token ? { tokenType: detectTokenType(result.token) } : {}),
      }
    },
  )

  ipcMain.handle(
    "github:cli-credentials",
    async (_event, params: { host?: string; componentId?: string } = {}) => {
      const generation = sessionManager.getGeneration()
      const host = resolveRequestedGitHubHost(params?.host)
      if (!host) {
        return {
          found: false as const,
          outcome: "absent" as const,
          error: invalidHostError(params?.host),
        }
      }
      const result = await withTlsOrchestration({
        provider: "github",
        host,
        detect: () => withVcs((vcs) => vcs.detectGitHubCli(host)),
      })

      if (result.outcome === "valid" && result.token) {
        await saveGitHubExport(
          params.componentId,
          generation,
          host,
          result.token,
          result.user?.login,
        )
        rememberGitHubHost(host)
      }

      return {
        ...toDetectionIpcResult(result, host),
        ...(result.token ? { tokenType: detectTokenType(result.token) } : {}),
      }
    },
  )

  // API queries run with the GitHub credential of the auth blocks `envFrom`
  // names. `host` selects which host's; omitted, it is that block's host.
  // The token is released only for the host it belongs to, and the request
  // goes to that host's API.
  ipcMain.handle(
    "github:orgs",
    async (_event, params?: { host?: string; envFrom?: readonly string[] }) => {
      return runtime.runPromise(
        Effect.gen(function* () {
          const { token, host } = yield* getBlockCredential(params?.envFrom, params?.host)
          return yield* listOrgs(token, host)
        }),
      )
    },
  )

  ipcMain.handle(
    "github:repos",
    async (
      _event,
      params: { org: string; query?: string; host?: string; envFrom?: readonly string[] },
    ) => {
      return runtime.runPromise(
        Effect.gen(function* () {
          const { token, host } = yield* getBlockCredential(params.envFrom, params.host)
          return yield* listRepos(token, params.org, params.query, host)
        }),
      )
    },
  )

  ipcMain.handle(
    "github:refs",
    async (
      _event,
      params: {
        owner: string
        repo: string
        query?: string
        host?: string
        envFrom?: readonly string[]
      },
    ) => {
      return runtime.runPromise(
        Effect.gen(function* () {
          const { token, host } = yield* getBlockCredential(params.envFrom, params.host)
          return yield* listRefs(token, params.owner, params.repo, params.query, host)
        }),
      )
    },
  )

  ipcMain.handle(
    "github:labels",
    async (
      _event,
      params: { owner: string; repo: string; host?: string; envFrom?: readonly string[] },
    ) => {
      return runtime.runPromise(
        Effect.gen(function* () {
          const { token, host } = yield* getBlockCredential(params.envFrom, params.host)
          const labels = yield* listLabels(token, params.owner, params.repo, host)
          return { labels }
        }),
      )
    },
  )
}
