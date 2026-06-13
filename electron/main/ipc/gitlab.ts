/**
 * IPC handlers for GitLab authentication operations.
 *
 * Detection and validation route through the unified VcsCredentials service
 * (vcs-auth-v2-design.md §2/§6) with the shared tri-state orchestration
 * (vcs-tristate.ts: cold trust-refresh-and-retry + §2.4 probe on tls; nothing
 * on server-cert/network). Detection handlers inject the resolved token into
 * the session environment so git operations can resolve it server-side. The
 * instance to target is selected by an optional `host` (a bare host from the
 * GitAuth picker / an authored prop) or `instanceUrl` (a manually-typed
 * instance URL that overrides `host`); both normalize to an origin and default
 * to gitlab.com. `gitlab:enumerate-hosts` lists the hosts glab is logged into
 * to drive the picker and triggers the §3.1 ca_cert harvest.
 */
import { Effect } from "effect"
import { ipcMain } from "electron"
import { runtime, sessionManager, getSessionTokenForProvider } from "./runtime.ts"
import { GitLabClient } from "../../../src/services/GitLabClient.ts"
import { Environment } from "../../../src/services/Environment.ts"
import {
  detectTokenType,
  collectGlabCaCertPems,
  detectConfigCredentials,
  detectHostMeta,
  envTokenHost,
  configuredEnvHost,
  hasEnvToken,
} from "../../../src/domain/gitlab/auth.ts"
import {
  normalizeGitLabBaseUrl,
  normalizeGitLabHost,
  tryNormalizeGitLabHost,
} from "../../../src/domain/git/gitlab-host.ts"
import { registerExtraCaPems } from "../index.ts"
import {
  withTlsOrchestration,
  withVcs,
  toDetectionIpcResult,
  toValidationIpcResult,
  appendSessionEnvAndRecord,
} from "./vcs-tristate.ts"
import { registerSecret } from "../../../src/domain/vcs/redact.ts"
import { readVcsAuthStore, addRecentGitLabHost, setLastSelectedGitLabHost } from "../recent-hosts.ts"

type HostSource = "glab" | "env" | "session" | "recent"

/**
 * Build the §4 merged host union: glab config hosts, env hosts, the session
 * host, and persisted recents — in that order, deduped by normalized host,
 * each annotated with provenance and an OFFLINE-ONLY hasCredential check
 * (env-token presence counted only for the §2.2-bound host; config.yml token
 * or use_keyring marker — no network, no per-host subprocess fan-out).
 */
async function buildMergedHosts(): Promise<{
  hosts: Array<{ host: string; sources: HostSource[]; hasCredential: boolean }>
  defaultHost: string
}> {
  const { hosts: glabHosts, defaultHost: glabDefault } = await withVcs((vcs) =>
    vcs.enumerateGitLabHosts(),
  )
  const allEnv = await runtime.runPromise(
    Effect.flatMap(Environment, (environment) => environment.getAll()),
  )
  // An unparseable env host yields NO entry — never a silent gitlab.com rebind.
  const envHost = tryNormalizeGitLabHost(configuredEnvHost(allEnv))
  const sessionHost = await runtime.runPromise(
    sessionManager.getSession().pipe(
      Effect.map((session) => session.env.get("GITLAB_HOST")),
      Effect.orElseSucceed(() => undefined),
    ),
  )
  const store = readVcsAuthStore()

  const union = new Map<string, Set<HostSource>>()
  const add = (host: string, source: HostSource) => {
    const key = normalizeGitLabHost(host)
    const entry = union.get(key) ?? new Set<HostSource>()
    entry.add(source)
    union.set(key, entry)
  }
  for (const host of glabHosts) add(host, "glab")
  if (envHost) add(envHost, "env")
  if (sessionHost) add(sessionHost, "session")
  for (const host of store.recentGitLabHosts) add(host, "recent")

  const envTokenPresent = hasEnvToken(allEnv)
  const boundHost = envTokenHost(allEnv)

  const hasCredentialFor = async (host: string): Promise<boolean> => {
    if (envTokenPresent && host === boundHost) return true
    if (await runtime.runPromise(detectConfigCredentials(host))) return true
    return (await runtime.runPromise(detectHostMeta(host)))?.useKeyring === true
  }

  const hosts = await Promise.all(
    [...union].map(async ([host, sources]) => ({
      host,
      sources: [...sources],
      hasCredential: await hasCredentialFor(host),
    })),
  )

  // §4 defaultHost precedence (the authored `host` prop pins instance
  // renderer-side and never reaches this handler): persisted pick — honored
  // only while still in the union AND credentialed, so a credential-less
  // stale pick can't steal auto-detect from a working gitlab.com token —
  // then env, then glab's own default, then gitlab.com.
  const last = store.lastSelectedGitLabHost
  const lastEntry = last ? hosts.find((h) => h.host === normalizeGitLabHost(last)) : undefined
  const defaultHost = normalizeGitLabHost(
    (lastEntry?.hasCredential ? lastEntry.host : undefined) ?? envHost ?? glabDefault,
  )
  // The renderer applies defaultHost to a controlled <select> over `hosts`
  // verbatim — a default outside the union would render a blank dropdown
  // while detection targets it. It IS the detection target, so list it.
  if (!hosts.some((h) => h.host === defaultHost)) {
    hosts.push({
      host: defaultHost,
      sources: [],
      hasCredential: await hasCredentialFor(defaultHost),
    })
  }
  return { hosts, defaultHost }
}

export function registerGitLabHandlers(): void {
  // Enumerate the GitLab hosts the user is logged into via glab, so the GitAuth
  // block can offer a host picker (gitlab.com vs a self-hosted instance).
  ipcMain.handle("gitlab:enumerate-hosts", async () => {
    // §3.1 ca_cert harvest piggybacks on enumeration: per-host PEMs from glab
    // config are added (additively) to the process trust. Best-effort.
    try {
      const pems = await runtime.runPromise(collectGlabCaCertPems())
      registerExtraCaPems(pems)
    } catch {
      /* harvest must never block enumeration */
    }
    return buildMergedHosts()
  })

  // Persist an explicit dropdown pick (any source) so it survives restart
  // (§4 item 4). Hostnames only — never tokens.
  ipcMain.handle("gitlab:host-picked", (_event, params: { host: string }) => {
    setLastSelectedGitLabHost(normalizeGitLabHost(params.host))
    return { ok: true as const }
  })

  ipcMain.handle(
    "gitlab:validate",
    async (
      _event,
      params: {
        token?: string
        host?: string
        instanceUrl?: string
        registerSession?: boolean
        useSessionToken?: boolean
      },
    ) => {
      const token = params.useSessionToken
        ? await runtime.runPromise(
            getSessionTokenForProvider("gitlab", () => new Error("none")).pipe(
              Effect.orElseSucceed(() => undefined),
            ),
          )
        : params.token
      if (!token) {
        return {
          valid: false,
          outcome: "invalid" as const,
          error: params.useSessionToken
            ? "No GitLab session credential available"
            : "No token provided",
        }
      }
      registerSecret(token)
      const tokenType = detectTokenType(token)
      // ORIGIN (scheme preserved — plain-http instances exist) feeds
      // validation; the bare host keys probe/session/recents/copy.
      const baseUrl = normalizeGitLabBaseUrl(params.instanceUrl ?? params.host)
      const host = new URL(baseUrl).host
      const result = await withTlsOrchestration({
        provider: "gitlab",
        host,
        detect: () => withVcs((vcs) => vcs.validateDirect("gitlab", baseUrl, token)),
        probeSource: "manual",
      })
      if (result.outcome === "valid") {
        let sessionEnvWarning: string | undefined
        if (params.registerSession && !params.useSessionToken && result.user) {
          sessionEnvWarning = await appendSessionEnvAndRecord("gitlab", host, "manual", {
            GITLAB_TOKEN: token,
            GITLAB_USER: result.user.login,
            GITLAB_HOST: host,
          })
        }
        // §4 item 4: every successful GitLab auth persists the pick; a
        // manually-typed instance URL additionally enters the recents.
        setLastSelectedGitLabHost(host)
        if (params.instanceUrl) {
          addRecentGitLabHost(host)
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
      return { ...toValidationIpcResult(result, host), valid: false, tokenType }
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
      const baseUrl = normalizeGitLabBaseUrl(params.instanceUrl ?? params.host)
      const host = new URL(baseUrl).host

      // §2.2 env-token host binding is enforced inside detectGitLabEnv.
      const result = await withTlsOrchestration({
        provider: "gitlab",
        host,
        detect: () => withVcs((vcs) => vcs.detectGitLabEnv(baseUrl)),
      })

      let sessionEnvWarning: string | undefined
      if (result.outcome === "valid" && result.token) {
        sessionEnvWarning = await appendSessionEnvAndRecord("gitlab", host, result.source, {
          GITLAB_TOKEN: result.token,
          GITLAB_HOST: host,
          ...(result.user ? { GITLAB_USER: result.user.login } : {}),
        })
        setLastSelectedGitLabHost(host)
      }

      return {
        ...toDetectionIpcResult(result, host),
        ...(result.token ? { tokenType: detectTokenType(result.token) } : {}),
        ...(sessionEnvWarning ? { sessionEnvWarning } : {}),
      }
    },
  )

  ipcMain.handle(
    "gitlab:cli-credentials",
    async (_event, params: { host?: string; instanceUrl?: string } = {}) => {
      // No requested host → fall back to glab's own default. Always an origin
      // (§6 contract).
      const requested = params.instanceUrl ?? params.host
      const instance = normalizeGitLabBaseUrl(
        requested || (await withVcs((vcs) => vcs.enumerateGitLabHosts())).defaultHost,
      )
      const host = new URL(instance).host

      const result = await withTlsOrchestration({
        provider: "gitlab",
        host,
        detect: () => withVcs((vcs) => vcs.detectGitLabCli(instance)),
      })

      let sessionEnvWarning: string | undefined
      if (result.outcome === "valid" && result.token) {
        sessionEnvWarning = await appendSessionEnvAndRecord("gitlab", host, result.source, {
          GITLAB_TOKEN: result.token,
          GITLAB_HOST: host,
          ...(result.user ? { GITLAB_USER: result.user.login } : {}),
        })
        setLastSelectedGitLabHost(host)
      }

      return {
        ...toDetectionIpcResult(result, host),
        ...(result.token ? { tokenType: detectTokenType(result.token) } : {}),
        ...(sessionEnvWarning ? { sessionEnvWarning } : {}),
      }
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
