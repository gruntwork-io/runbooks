/**
 * IPC handlers for GitLab authentication operations.
 *
 * Detection and validation route through the unified VcsCredentials service
 * with the shared tri-state orchestration
 * (vcs-tristate.ts: cold trust-refresh-and-retry + probe on tls; nothing
 * on server-cert/network). A sign-in made for a block (`componentId`) is saved
 * as that block's export, which a block that names it in envFrom gets, so git
 * operations resolve the token in the main process. The
 * instance to target is selected by an optional `host` (a bare host from the
 * GitAuth picker / an authored prop) or `instanceUrl` (a manually-typed
 * instance URL that overrides `host`); both normalize to an origin and default
 * to gitlab.com. `gitlab:enumerate-hosts` lists the hosts glab is logged into
 * to drive the picker and triggers the ca_cert harvest.
 */
import { Effect } from "effect"
import { ipcMain } from "electron"
import {
  runtime,
  sessionManager,
  exportedVcsCredential,
  getExportedGitLabTokenForOrigin,
} from "./runtime.ts"
import { MissingCredentialError } from "../../../src/errors/index.ts"
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
import { ENV_PREFIX_PATTERN } from "../../../src/domain/env-prefix.ts"
import {
  normalizeGitLabBaseUrl,
  normalizeGitLabHost,
  tryNormalizeGitLabBaseUrl,
  tryNormalizeGitLabHost,
} from "../../../src/domain/git/gitlab-host.ts"
import { registerExtraCaPems } from "../system-trust.ts"
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
  addRecentGitLabHost,
  setLastSelectedGitLabHost,
} from "../recent-hosts.ts"

type HostSource = "glab" | "env" | "recent"

/**
 * Resolve a GitLab instance string (a bare host or a scheme-qualified URL) to
 * the API ORIGIN (scheme preserved — plain-http instances exist) that feeds
 * validation, plus the bare HOST that keys probe/export/recents/copy. Both
 * default to gitlab.com.
 */
function resolveGitLabInstance(input?: string | null): { baseUrl: string; host: string } {
  const baseUrl = normalizeGitLabBaseUrl(input)
  return { baseUrl, host: new URL(baseUrl).host }
}

/**
 * Save a validated GitLab credential as block `componentId`'s export. Nothing
 * is saved for a request that names no block. `generation` is the session
 * generation captured when the request arrived.
 */
const saveGitLabExport = (
  componentId: string | undefined,
  generation: number,
  host: string,
  token: string,
  login?: string,
): Promise<void> =>
  componentId === undefined
    ? Promise.resolve()
    : saveVcsExport(
        "gitlab",
        componentId,
        { GITLAB_TOKEN: token, GITLAB_HOST: host, ...(login ? { GITLAB_USER: login } : {}) },
        generation,
      )

/**
 * Build the merged host union: glab config hosts, env hosts and persisted
 * recents — in that order, deduped by normalized host,
 * each annotated with provenance and an OFFLINE-ONLY hasCredential check
 * (env-token presence counted only for the bound host; config.yml token
 * or use_keyring marker — no network, no per-host subprocess fan-out).
 */
async function buildMergedHosts(): Promise<{
  hosts: Array<{ host: string; sources: HostSource[]; hasCredential: boolean }>
  defaultHost: string
}> {
  // These sources are independent — resolve them concurrently.
  const [{ hosts: glabHosts, defaultHost: glabDefault }, allEnv] = await Promise.all([
    withVcs((vcs) => vcs.enumerateGitLabHosts()),
    runtime.runPromise(Effect.flatMap(Environment, (environment) => environment.getAll())),
  ])
  // An unparseable env host yields NO entry — never a silent gitlab.com rebind.
  const envHost = tryNormalizeGitLabHost(configuredEnvHost(allEnv))
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

  // defaultHost precedence (the authored `host` prop pins instance
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
    // ca_cert harvest piggybacks on enumeration: per-host PEMs from glab
    // config are added (additively) to the process trust. Best-effort.
    try {
      const pems = await runtime.runPromise(collectGlabCaCertPems())
      registerExtraCaPems(pems)
    } catch {
      /* harvest must never block enumeration */
    }
    return buildMergedHosts()
  })

  // Persist an explicit dropdown pick (any source) so it survives restart.
  // Hostnames only — never tokens.
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
        componentId?: string
        registerSession?: boolean
        fromBlock?: string
      },
    ) => {
      const generation = sessionManager.getGeneration()
      const { baseUrl, host } = resolveGitLabInstance(params.instanceUrl ?? params.host)
      // A block's sign-in is released only to the host it signed in to (as
      // for GitHub), and never over plain http: it may be an auto-detected
      // env or CLI token.
      const token =
        params.fromBlock !== undefined && baseUrl.startsWith("https:")
          ? exportedVcsCredential("gitlab", [params.fromBlock], host)?.token
          : params.token
      if (!token) {
        return {
          valid: false,
          outcome: "invalid" as const,
          error:
            params.fromBlock !== undefined
              ? `${params.fromBlock} has no GitLab sign-in for ${host}`
              : "No token provided",
        }
      }
      registerSecret(token)
      const tokenType = detectTokenType(token)
      const result = await withTlsOrchestration({
        provider: "gitlab",
        host,
        detect: () => withVcs((vcs) => vcs.validateDirect("gitlab", baseUrl, token)),
        probeSource: "manual",
      })
      if (result.outcome === "valid") {
        if (params.registerSession && result.user) {
          await saveGitLabExport(params.componentId, generation, host, token, result.user.login)
        }
        // every successful GitLab auth persists the pick; a
        // manually-typed instance URL additionally enters the recents.
        setLastSelectedGitLabHost(host)
        if (params.instanceUrl) {
          addRecentGitLabHost(host)
        }
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
    "gitlab:env-credentials",
    async (
      _event,
      params: {
        prefix?: string
        host?: string
        instanceUrl?: string
        componentId?: string
      } = {},
    ) => {
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

      const { baseUrl, host } = resolveGitLabInstance(params.instanceUrl ?? params.host)

      // env-token host binding (and the https-only rule) is enforced inside
      // detectGitLabEnv.
      const result = await withTlsOrchestration({
        provider: "gitlab",
        host,
        detect: () => withVcs((vcs) => vcs.detectGitLabEnv(baseUrl, prefix)),
      })

      if (result.outcome === "valid" && result.token) {
        await saveGitLabExport(
          params.componentId,
          generation,
          host,
          result.token,
          result.user?.login,
        )
        setLastSelectedGitLabHost(host)
      }

      return {
        ...toDetectionIpcResult(result, host),
        ...(result.token ? { tokenType: detectTokenType(result.token) } : {}),
      }
    },
  )

  ipcMain.handle(
    "gitlab:cli-credentials",
    async (_event, params: { host?: string; instanceUrl?: string; componentId?: string } = {}) => {
      const generation = sessionManager.getGeneration()
      // No requested host → fall back to glab's own default. Always an origin
      // (contract).
      const requested = params.instanceUrl ?? params.host
      const { baseUrl: instance, host } = resolveGitLabInstance(
        requested || (await withVcs((vcs) => vcs.enumerateGitLabHosts())).defaultHost,
      )

      const result = await withTlsOrchestration({
        provider: "gitlab",
        host,
        detect: () => withVcs((vcs) => vcs.detectGitLabCli(instance)),
      })

      if (result.outcome === "valid" && result.token) {
        await saveGitLabExport(
          params.componentId,
          generation,
          host,
          result.token,
          result.user?.login,
        )
        setLastSelectedGitLabHost(host)
      }

      return {
        ...toDetectionIpcResult(result, host),
        ...(result.token ? { tokenType: detectTokenType(result.token) } : {}),
      }
    },
  )

  // List a GitLab project's labels for the MR label picker, with the token of
  // the GitLab Auth block `envFrom` names, so the renderer never handles it.
  // Returns an empty list on failure — labels are enrichment and must never
  // block opening a merge request.
  ipcMain.handle(
    "gitlab:labels",
    async (
      _event,
      params: { owner: string; repo: string; host?: string; envFrom?: readonly string[] },
    ) => {
      const envFrom = params.envFrom ?? []
      const program = Effect.gen(function* () {
        // Target the repo's own GitLab instance (passed by the renderer from the
        // repo's remote); fall back to the host of the block envFrom names. A
        // bare host or a URL normalizes to the API origin. One that doesn't
        // parse returns no labels rather than asking gitlab.com, as the client
        // itself would refuse it.
        const baseUrl = tryNormalizeGitLabBaseUrl(
          params.host ?? exportedVcsCredential("gitlab", envFrom)?.host,
        )
        if (!baseUrl) {
          return yield* new MissingCredentialError({
            message: "No GitLab instance to list labels from",
          })
        }
        // The token goes only to the host its block signed in to (port
        // included), over https.
        const token = yield* getExportedGitLabTokenForOrigin(
          envFrom,
          baseUrl,
          () =>
            new MissingCredentialError({
              message: "No GitLab sign-in for this host. Name a GitLab Auth block in envFrom.",
            }),
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
