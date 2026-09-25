import { useState, useCallback, useRef, useEffect } from "react"
import { useApi } from "@/contexts/ApiContext"
import { useRunbookContext } from "@/contexts/useRunbook"
import { useSession } from "@/contexts/useSession"
import { normalizeBlockId } from "@/lib/utils"
import type {
  GitAuthMethod,
  GitAuthStatus,
  GitDetectionStatus,
  GitDetectionSource,
  GitErrorKind,
  GitLabHostEntry,
  GitSuccessMeta,
  GitUnreachableInfo,
  GitUserInfo,
  GitCredentialSource,
  GitCliCredentialsResponse,
  GitTokenType,
  VcsCliStatusResult,
} from "../types"
import { isCliAuthFound, OTHER_INSTANCE_SENTINEL } from "../types"
import type { ProviderConfig } from "../providers"
import { resolveDefaultAuthMethod } from "../utils"

interface UseGitAuthOptions {
  id: string
  provider: ProviderConfig
  /** Self-hosted GitLab instance URL (GitLab only); seeds the editable field. */
  instanceUrl?: string
  oauthClientId?: string
  oauthScopes?: string[]
  detectCredentials?: false | GitCredentialSource[]
  /** Tab to open on; validated against the provider by resolveDefaultAuthMethod. */
  defaultTab?: string
  /** GitLab only: an authored host that pins the instance and hides the picker. */
  host?: string
}

const DEFAULT_GITLAB_HOST = 'gitlab.com'

/** GitHub's device-code lifetime in seconds when oauth-start reports none. */
const DEFAULT_OAUTH_EXPIRES_IN = 900

// Shown both when GitHub answers `expired_token` and when the polling deadline
// passes first, so a timeout never reads as a denial.
const OAUTH_CODE_EXPIRED_MESSAGE = 'Authorization request expired. Please try again.'

/**
 * What a validated credential reports beyond its user: the token's scopes and
 * type, where it came from, and main's advisory copy. Every success path (each
 * detection source, PAT, OAuth) hands one of these to applyCredentialDetails,
 * so the success card shows the same fields whichever way the user got there.
 */
type CredentialDetails = {
  scopes?: string[]
  tokenType?: GitTokenType
  meta?: GitSuccessMeta | null
  divergenceHint?: string
  sessionEnvWarning?: string
}

/**
 * A {block} source's success-card details. Its token was validated like a
 * PAT, so there is no env var or CLI source to name — only the transport.
 */
function blockCredentialDetails(result: {
  scopes?: string[]
  tokenType?: GitTokenType
  validatedVia?: 'direct' | 'cli'
  sessionEnvWarning?: string
}): CredentialDetails {
  return {
    scopes: result.scopes,
    tokenType: result.tokenType,
    sessionEnvWarning: result.sessionEnvWarning,
    meta: result.validatedVia ? { validatedVia: result.validatedVia } : null,
  }
}

/**
 * Extract the bare host from a user-entered GitLab instance URL (bare host or
 * full URL, scheme optional). Returns undefined for unparseable input so the
 * caller can fall back to the picked/default host. Keeps the renderer's notion
 * of "which instance" in sync with the URL the token is actually validated
 * against on the backend (which normalizes the same way).
 */
function hostFromInstanceUrl(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    return new URL(withScheme).host || undefined
  } catch {
    return undefined
  }
}

export function useGitAuth({
  id,
  provider,
  instanceUrl,
  oauthClientId,
  oauthScopes = ['repo'],
  detectCredentials = ['env', 'cli'],
  host,
  defaultTab,
}: UseGitAuthOptions) {
  const api = useApi()
  const { registerOutputs, blockOutputs } = useRunbookContext()
  const { isReady: sessionReady } = useSession()

  // Core auth state. The starting tab is the author's `defaultTab` when the
  // provider offers it; otherwise the provider's own default (GitHub → OAuth,
  // GitLab → PAT, as it has no OAuth). Only the initial value comes from the
  // prop — the user's tab clicks own it from then on.
  const [authMethod, setAuthMethod] = useState<GitAuthMethod>(
    () => resolveDefaultAuthMethod(provider, defaultTab)
  )
  const [authStatus, setAuthStatus] = useState<GitAuthStatus>('pending')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [userInfo, setUserInfo] = useState<GitUserInfo | null>(null)

  // Detection state
  const [detectionStatus, setDetectionStatus] = useState<GitDetectionStatus>(
    detectCredentials === false ? 'done' : 'pending'
  )
  const [detectionSource, setDetectionSource] = useState<GitDetectionSource>(null)
  const [detectedScopes, setDetectedScopes] = useState<string[] | null>(null)
  const [detectedTokenType, setDetectedTokenType] = useState<GitTokenType | null>(null)
  const [missingScope, setMissingScope] = useState(false)
  const [detectionWarning, setDetectionWarning] = useState<string | null>(null)
  const [sessionEnvWarning, setSessionEnvWarning] = useState<string | null>(null)
  const [unreachableInfo, setUnreachableInfo] = useState<GitUnreachableInfo | null>(null)
  // Manual-UI hint copy from main (e.g. the glab keyring contracts) —
  // informational, distinct from any warning chip.
  const [detectionHint, setDetectionHint] = useState<string | null>(null)
  // both-set-and-differ env hint, shown on the success card.
  const [divergenceHint, setDivergenceHint] = useState<string | null>(null)
  const [cliStatus, setCliStatus] = useState<VcsCliStatusResult | null>(null)
  const [successMeta, setSuccessMeta] = useState<GitSuccessMeta | null>(null)
  // set when another block's auth replaced this provider's single
  // session credential with a different host (vcs:session-changed).
  const [sessionStale, setSessionStale] = useState(false)
  const authenticatedHostRef = useRef<string | undefined>(undefined)
  // Set by reAuthenticate: focus re-detection stays off until detection is
  // re-armed explicitly (Check again, Retry, Reload, a host pick or a
  // provider switch). State, not a ref, because it gates focusRedetectArmed.
  const [redetectSuppressed, setRedetectSuppressed] = useState(false)
  const detectionAttemptedRef = useRef(false)
  // Bumped to invalidate in-flight detection loops; checked after every await.
  const detectionRunRef = useRef(0)

  // ---------------------------------------------------------------------------
  // Host selection (GitLab can be logged into several instances via glab).
  // For providers without host selection (GitHub) or when the author pinned a
  // `host`, there is nothing to enumerate and we are "ready" immediately.
  // ---------------------------------------------------------------------------
  const hostSelectable = Boolean(provider.supportsHostSelection && !host)
  const [availableHosts, setAvailableHosts] = useState<GitLabHostEntry[]>(
    host ? [{ host, sources: [], hasCredential: false }] : [],
  )
  const [selectedHost, setSelectedHost] = useState<string>(host ?? DEFAULT_GITLAB_HOST)
  // Hosts whose key icon was downgraded after a failed validation this
  // session (the dropdown must never contradict the warning chip).
  const [downgradedHosts, setDowngradedHosts] = useState<ReadonlySet<string>>(new Set())
  // The provider whose host list is settled. Keyed to the provider rather than
  // a boolean so a GitHub→GitLab switch closes the gate on the very render the
  // provider changes: the enumerate and detection effects run in the same
  // flush, and a stale `true` would let detection run against the gitlab.com
  // default before the glab hosts (and the persisted pick) are known.
  const [hostsReadyFor, setHostsReadyFor] = useState<string | null>(hostSelectable ? null : provider.id)
  const hostsReady = hostsReadyFor === provider.id
  // Bumped to force the detection effect to re-run (host change / manual reload).
  const [detectionNonce, setDetectionNonce] = useState(0)
  // Bumped to force re-enumeration of glab hosts (manual "reload config").
  const [hostsReloadNonce, setHostsReloadNonce] = useState(0)
  // True once the user explicitly picks a host, so a config reload preserves it
  // instead of snapping back to glab's default.
  const userPickedHostRef = useRef(false)

  // For block-based detection, track which block we're waiting for
  const [waitingForBlockId, setWaitingForBlockId] = useState<string | null>(null)
  // The rest of a detection walk paused on a {block} source that has not run:
  // the sources after it and the warnings collected before it. The block
  // watcher resumes the walk once that block has run.
  const pausedWalkRef = useRef<{ sources: GitCredentialSource[]; warnings: string[] } | null>(null)

  // PAT form state
  const [patToken, setPatToken] = useState('')
  const [showPatToken, setShowPatToken] = useState(false)
  // The current PAT submission. Each submit takes the next number and
  // resetAuth (a provider switch, Re-authenticate) bumps it, so a validation
  // still in flight when the card was reset neither signs the card in nor
  // publishes the old provider's outputs.
  const patSubmitRef = useRef(0)

  // GitLab self-hosted instance URL, seeded from the prop and editable in the
  // PAT form. Only meaningful for the GitLab provider; sent with the token so
  // validation/detection targets the right instance (empty → gitlab.com).
  const [gitlabInstanceUrl, setGitlabInstanceUrl] = useState(instanceUrl ?? '')
  // Bumped when "Other instance…" is picked; the block focuses the
  // instance-URL field on each bump.
  const [instanceFieldFocusNonce, setInstanceFieldFocusNonce] = useState(0)

  // The instance URL to send over IPC: only for GitLab, and only when non-empty
  // (so GitHub and the gitlab.com default both send nothing).
  const instanceUrlForIpc = provider.id === 'gitlab' && gitlabInstanceUrl.trim()
    ? gitlabInstanceUrl.trim()
    : undefined

  // The host threaded into provider IPC calls. Held in a ref so the credential
  // callbacks don't need it as a dependency (which would churn the detect loop).
  // A manually-entered instance URL wins over the picked/authored host (matching
  // the backend's `instanceUrl ?? host` rule), so the session GITLAB_HOST and the
  // success banner agree with the instance the token was validated against.
  const effectiveHost = provider.supportsHostSelection
    ? ((instanceUrlForIpc ? hostFromInstanceUrl(instanceUrlForIpc) : undefined) ?? host ?? selectedHost)
    : undefined
  const effectiveHostRef = useRef<string | undefined>(effectiveHost)
  effectiveHostRef.current = effectiveHost

  // OAuth state
  const [oauthUserCode, setOauthUserCode] = useState<string | null>(null)
  const [oauthVerificationUri, setOauthVerificationUri] = useState<string | null>(null)
  // The current device flow. Each startOAuth takes the next number; cancel,
  // reset and unmount bump it. Every continuation of a flow (the oauth-start
  // reply, each poll reply, each scheduled poll) re-checks its number, so a
  // poll in flight when its flow ended can never resume or publish.
  const oauthFlowRef = useRef(0)
  const oauthPollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // The author-supplied client ID (GitHub OAuth only). Undefined means main
  // uses its default Gruntwork app — the renderer never holds that constant.
  const effectiveClientId = oauthClientId || undefined
  const isCustomClientId = Boolean(effectiveClientId)

  // Whether to warn about a missing required scope. Only warns when the token's
  // scopes are actually known (an unknown/empty list means we can't claim a
  // scope is missing) and none of the acceptable scopes are present. Acceptable
  // scopes default to [requiredScope], but a provider can list several when more
  // than one grants the needed access (e.g. GitLab's `api` ⊇ `write_repository`).
  // The warning's copy lives in the provider config
  // (`provider.success.scopeWarningDetail`) and is rendered by AuthSuccess.
  const shouldWarnMissingScope = useCallback((scopes: string[] | undefined): boolean => {
    if (!provider.success.showScopeWarning || !provider.success.requiredScope) return false
    if (!scopes || scopes.length === 0) return false
    const acceptable = provider.success.acceptableScopes ?? [provider.success.requiredScope]
    return !scopes.some((scope) => acceptable.includes(scope))
  }, [provider])

  // Helper to check for credentials from block outputs. A referenced GitAuth
  // block (marked __AUTHENTICATED) is metadata-only — its credential
  // lives in the session env and is resolved MAIN-SIDE via the validate
  // channels' useSessionToken mode.
  const getBlockCredentials = useCallback((blockId: string): { found: boolean; token?: string; isGitAuthBlock?: boolean; error?: string } => {
    const normalizedId = normalizeBlockId(blockId)
    const outputs = blockOutputs[normalizedId]?.values

    if (!outputs) {
      return { found: false, error: `Block "${blockId}" has not been executed yet or has no outputs` }
    }

    const isGitAuthBlock = outputs.__AUTHENTICATED === 'true'
    const token = outputs[provider.env.tokenVar] ||
      provider.env.altTokenVars.map((v) => outputs[v]).find(Boolean)
    if (!token) {
      if (isGitAuthBlock) {
        // The referenced GitAuth block authenticated; its token is in the
        // session env (main-side), not in outputs.
        return { found: true, isGitAuthBlock: true }
      }
      const names = [provider.env.tokenVar, ...provider.env.altTokenVars].join(' or ')
      return { found: false, error: `Block "${blockId}" did not output ${names}` }
    }

    return { found: true, token, isGitAuthBlock }
  }, [blockOutputs, provider])

  // Whether a {block} source should still be waited on. getBlockCredentials'
  // `found: false` conflates "never ran" with "ran, but left no token", so
  // this looks at the outputs directly: no outputs at all means the block has
  // not run. A GitAuth block's pre-auth placeholder also counts as not run —
  // switching its provider (or re-authenticating) registers just
  // GIT_PROVIDER, and a block chained off it must keep waiting for the real
  // auth rather than fall through to later sources.
  const blockPending = useCallback((blockId: string): boolean => {
    const outputs = blockOutputs[normalizeBlockId(blockId)]?.values
    if (outputs === undefined) return true
    const hasToken = [provider.env.tokenVar, ...provider.env.altTokenVars].some((v) => Boolean(outputs[v]))
    return outputs.GIT_PROVIDER !== undefined && outputs.__AUTHENTICATED !== 'true' && !hasToken
  }, [blockOutputs, provider])

  // Register credentials as BLOCK OUTPUTS only (main writes the session
  // env during validation). Used by the PAT path and the non-GitAuth
  // {block:'id'} path, where the renderer legitimately holds the token.
  // GIT_PROVIDER lets a downstream PR/MR block derive its channel;
  // __AUTHENTICATED is the session-env chaining marker.
  const registerCredentials = useCallback((token: string, user: GitUserInfo): void => {
    registerOutputs(id, {
      [provider.env.tokenVar]: token,
      [provider.env.userVar]: user.login,
      GIT_PROVIDER: provider.id,
      __AUTHENTICATED: 'true',
    })
  }, [id, provider, registerOutputs])

  // Metadata-only output registration for the env/cli/oauth/session-chained
  // paths — no raw token ever enters block outputs for these.
  const registerMetadataOutputs = useCallback((user?: GitUserInfo): void => {
    registerOutputs(id, {
      ...(user ? { [provider.env.userVar]: user.login } : {}),
      GIT_PROVIDER: provider.id,
      __AUTHENTICATED: 'true',
    })
  }, [id, provider, registerOutputs])

  // Clear this block's registered outputs. When the user explicitly switches
  // providers, pass `retainProvider` so the new provider's id is written
  // immediately — downstream blocks (e.g. GitPullRequest) need GIT_PROVIDER
  // to derive the right channel even before authentication completes.
  const clearRegisteredOutputs = useCallback((retainProvider?: string) => {
    registerOutputs(id, retainProvider ? { GIT_PROVIDER: retainProvider } : {})
  }, [id, registerOutputs])

  // The host an unreachable card should name: GitHub is single-host; GitLab
  // uses the effective (picked/entered) host. A backend-reported host wins.
  const unreachableHost = useCallback((reportedHost?: string): string => {
    return (
      reportedHost ??
      effectiveHostRef.current ??
      (provider.id === 'github' ? 'github.com' : DEFAULT_GITLAB_HOST)
    )
  }, [provider])

  const markUnreachable = useCallback((errorKind: GitErrorKind, reportedHost?: string, coldReadOk?: boolean) => {
    setUnreachableInfo({ errorKind, host: unreachableHost(reportedHost), coldReadOk })
  }, [unreachableHost])

  // Publish what a validated credential reported to the success card. Shared
  // by every success path (detection, PAT, OAuth) so none of them can drop a
  // field the others show; each field is set outright, so the card reflects
  // exactly this credential.
  const applyCredentialDetails = useCallback((details: CredentialDetails) => {
    const scopes = details.scopes && details.scopes.length > 0 ? details.scopes : null
    setDetectedScopes(scopes)
    setMissingScope(shouldWarnMissingScope(details.scopes))
    setDetectedTokenType(details.tokenType ?? null)
    setSuccessMeta(details.meta ?? null)
    setDivergenceHint(details.divergenceHint ?? null)
    setSessionEnvWarning(details.sessionEnvWarning ?? null)
  }, [shouldWarnMissingScope])

  // Shared success epilogue — every detection source ends a successful
  // detection the same way, and it is the only place detection publishes
  // outputs, so a caller that has checked its run is still current can't
  // publish for a stale one. Outputs are metadata-only, but WITH the user var:
  // downstream blocks read GITHUB_USER/GITLAB_USER regardless of credential
  // source. `token` is for a {block} source whose block output a raw token:
  // the renderer already holds it, so it is published like a PAT.
  const finishAuthenticated = useCallback((
    src: GitDetectionSource,
    user: GitUserInfo,
    details: CredentialDetails,
    opts?: { token?: string },
  ) => {
    setDetectionSource(src)
    setAuthStatus('authenticated')
    setUserInfo(user)
    applyCredentialDetails(details)
    setDetectionStatus('done')
    if (opts?.token) {
      registerCredentials(opts.token, user)
    } else {
      registerMetadataOutputs(user)
    }
  }, [applyCredentialDetails, registerCredentials, registerMetadataOutputs])

  // Validate a token via the provider's API. `registerSession` makes MAIN
  // write the session env on success (the PAT and block paths);
  // `useSessionToken` validates the provider's session credential instead of
  // sending one (the GitAuth-block chaining mode — no token crosses IPC).
  const validateToken = useCallback(async (
    token: string | undefined,
    opts?: { registerSession?: boolean; useSessionToken?: boolean },
  ): Promise<{ valid: boolean; user?: GitUserInfo; scopes?: string[]; tokenType?: GitTokenType; error?: string; errorKind?: GitErrorKind; coldReadOk?: boolean; validatedVia?: 'direct' | 'cli'; sessionEnvWarning?: string }> => {
    try {
      // A manually-entered instance URL takes precedence over the picked host.
      const data = await api.invoke(provider.channels.validate, {
        ...(token !== undefined ? { token } : {}),
        ...(opts?.registerSession ? { registerSession: true } : {}),
        ...(opts?.useSessionToken ? { useSessionToken: true } : {}),
        ...(instanceUrlForIpc
          ? { instanceUrl: instanceUrlForIpc }
          : { host: effectiveHostRef.current }),
      })
      return {
        valid: data.valid,
        user: data.user as GitUserInfo | undefined,
        scopes: data.scopes,
        tokenType: data.tokenType as GitTokenType | undefined,
        error: data.error,
        errorKind: data.errorKind as GitErrorKind | undefined,
        coldReadOk: data.coldReadOk,
        validatedVia: data.validatedVia,
        sessionEnvWarning: data.sessionEnvWarning,
      }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Failed to validate token'
      }
    }
  }, [api, provider, instanceUrlForIpc])

  // Try to detect credentials from environment variables
  const tryEnvCredentials = useCallback(async (options?: { prefix?: string }): Promise<{ success: boolean; user?: GitUserInfo; scopes?: string[]; tokenType?: GitTokenType; error?: string; foundButInvalid?: boolean; warning?: string; envVar?: string; divergenceHint?: string; validatedVia?: 'direct' | 'cli'; sessionEnvWarning?: string; unreachable?: { errorKind: GitErrorKind; host?: string; coldReadOk?: boolean } }> => {
    try {
      const data = await api.invoke(provider.channels.envCredentials, {
        prefix: options?.prefix || '',
        ...(instanceUrlForIpc
          ? { instanceUrl: instanceUrlForIpc }
          : { host: effectiveHostRef.current }),
      }) as unknown as GitCliCredentialsResponse

      if (!data.found) {
        return { success: false, error: data.error }
      }

      if (data.outcome === 'unreachable' && data.errorKind) {
        return {
          success: false,
          error: data.error,
          unreachable: { errorKind: data.errorKind, host: data.host, coldReadOk: data.coldReadOk },
        }
      }

      if (!data.valid) {
        // Token was found but is invalid. `warning` carries main's exact chip
        // copy ("<VAR> is not valid for <host>" — never "expired").
        return { success: false, error: data.error, foundButInvalid: true, warning: data.warning, envVar: data.envVar }
      }

      return {
        success: true,
        user: data.user as GitUserInfo | undefined,
        scopes: data.scopes,
        tokenType: data.tokenType as GitTokenType | undefined,
        divergenceHint: data.divergenceHint,
        envVar: data.envVar,
        validatedVia: data.validatedVia,
        sessionEnvWarning: data.sessionEnvWarning,
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to check env credentials' }
    }
  }, [api, provider, instanceUrlForIpc])

  // Try to detect credentials from the provider's CLI
  const tryCliCredentials = useCallback(async (): Promise<{ success: boolean; user?: GitUserInfo; scopes?: string[]; tokenType?: GitTokenType; error?: string; foundButInvalid?: boolean; warning?: string; hint?: string; host?: string; source?: 'env' | 'cli' | 'config'; validatedVia?: 'direct' | 'cli'; sessionEnvWarning?: string; unreachable?: { errorKind: GitErrorKind; host?: string; coldReadOk?: boolean } }> => {
    try {
      const data = await api.invoke(
        provider.channels.cliCredentials,
        instanceUrlForIpc
          ? { instanceUrl: instanceUrlForIpc }
          : { host: effectiveHostRef.current },
      ) as unknown as GitCliCredentialsResponse

      if (data.outcome === 'unreachable' && data.errorKind) {
        return {
          success: false,
          error: data.error,
          host: data.host,
          unreachable: { errorKind: data.errorKind, host: data.host, coldReadOk: data.coldReadOk },
        }
      }

      if (!isCliAuthFound(data)) {
        // A token WAS found but did not validate (expired OAuth token, wrong
        // host, etc.). Main classifies this authoritatively as outcome
        // 'invalid' (found + !valid); trust that signal rather than re-deriving
        // it from HTTP status codes or error-string matching (a GitLab 401 body
        // reads "401 Unauthorized", not "invalid"/"expired"). Mirrors the env
        // path, which keys off the same outcome.
        const foundButInvalid = data.outcome === 'invalid'
        return { success: false, error: data.error, foundButInvalid, warning: data.warning, hint: data.hint, host: data.host }
      }

      return {
        success: true,
        user: data.user,
        scopes: data.scopes,
        tokenType: data.tokenType,
        host: data.host,
        source: data.source,
        validatedVia: data.validatedVia,
        sessionEnvWarning: data.sessionEnvWarning,
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to check CLI credentials' }
    }
  }, [api, provider, instanceUrlForIpc])

  // Try to detect credentials from block outputs (block-chaining):
  // a referenced GitAuth block resolves against the SESSION env in main
  // (useSessionToken mode — no token crosses IPC); any other block's
  // renderer-held output value flows as today, with main writing the session.
  // Publishes nothing: the caller does, via finishAuthenticated, once it has
  // checked the detection run survived the validation await.
  const tryBlockCredentials = useCallback(async (blockId: string): Promise<{ success: boolean; user?: GitUserInfo; token?: string; scopes?: string[]; tokenType?: GitTokenType; validatedVia?: 'direct' | 'cli'; error?: string; sessionEnvWarning?: string; unreachable?: { errorKind: GitErrorKind; coldReadOk?: boolean } }> => {
    const result = getBlockCredentials(blockId)

    if (!result.found) {
      return { success: false, error: result.error || 'Could not read token from block' }
    }

    const useSessionToken = result.token === undefined && result.isGitAuthBlock === true
    const validation = useSessionToken
      ? await validateToken(undefined, { useSessionToken: true })
      : await validateToken(result.token, { registerSession: true })

    if (!validation.valid || !validation.user) {
      // Transport failure: the block's token was not consumed/judged.
      if (validation.errorKind) {
        return {
          success: false,
          error: validation.error,
          unreachable: { errorKind: validation.errorKind, coldReadOk: validation.coldReadOk },
        }
      }
      return { success: false, error: validation.error || 'Block token is invalid' }
    }

    return {
      success: true,
      user: validation.user,
      // Absent on the session-chained path, whose outputs stay metadata-only.
      token: result.token,
      scopes: validation.scopes,
      tokenType: validation.tokenType,
      validatedVia: validation.validatedVia,
      sessionEnvWarning: validation.sessionEnvWarning,
    }
  }, [getBlockCredentials, validateToken])

  // Discover which GitLab hosts the user is logged into via glab, to drive the
  // host picker. Skipped for GitHub and when the author pinned a `host`. Re-runs
  // on a manual config reload (hostsReloadNonce).
  useEffect(() => {
    if (!hostSelectable || !provider.channels.enumerateHosts) {
      setAvailableHosts(host ? [{ host, sources: [], hasCredential: false }] : [])
      setSelectedHost(host ?? DEFAULT_GITLAB_HOST)
      setHostsReadyFor(provider.id)
      return
    }
    if (!sessionReady) return

    let cancelled = false
    setHostsReadyFor(null)
    const channel = provider.channels.enumerateHosts
    void (async () => {
      try {
        const data = await api.invoke(channel, {})
        if (cancelled) return
        // the enumerate result is the annotated merged union (objects);
        // membership checks compare against hosts.map(h => h.host).
        const hosts = (data.hosts ?? []) as GitLabHostEntry[]
        const hostNames = hosts.map((h) => h.host)
        setAvailableHosts(hosts)
        // Honor the default (persisted pick > env > glab > gitlab.com) on
        // first load; preserve a user's explicit pick (if still present)
        // across a config reload.
        setSelectedHost((prev) =>
          userPickedHostRef.current && hostNames.includes(prev)
            ? prev
            : (data.defaultHost || hostNames[0] || DEFAULT_GITLAB_HOST),
        )
      } catch {
        if (!cancelled) {
          setAvailableHosts([])
          setSelectedHost(DEFAULT_GITLAB_HOST)
        }
      } finally {
        if (!cancelled) setHostsReadyFor(provider.id)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [api, hostSelectable, provider, host, sessionReady, hostsReloadNonce])

  // Walk the detection sources in order, stopping at the first success. A
  // {block} source whose block has not run yet pauses the walk (the author's
  // order is the priority order) and stashes the rest, with the warnings so
  // far, for the block watcher to resume; one that ran without a usable token
  // falls through to the next source. `runId` is the detection run the walk
  // belongs to: every await re-checks it before touching state or outputs, so
  // a provider switch, host change or reload drops the walk.
  const trySourcesInOrder = useCallback(async (sources: GitCredentialSource[], runId: number, priorWarnings: string[] = []) => {
    const cancelled = () => detectionRunRef.current !== runId
    const warnings = [...priorWarnings]

    // 'unreachable': stop the chain WITHOUT consuming later sources —
    // every one of them would hit the same wall. Detection still ends
    // 'done' so the manual UI renders beneath the error card. Warnings
    // accumulated from earlier (genuinely invalid) sources are preserved.
    const stopUnreachable = (info: { errorKind: GitErrorKind; host?: string; coldReadOk?: boolean }) => {
      markUnreachable(info.errorKind, info.host, info.coldReadOk)
      if (warnings.length > 0) {
        setDetectionWarning(warnings.join('; '))
      }
      setDetectionStatus('done')
    }

    for (let i = 0; i < sources.length; i++) {
      const source = sources[i]
      // Check for 'env' (standard env vars) or { env: { prefix: 'PREFIX_' } }
      // (prefixed env vars) — the same channel, differing only in the prefix
      if (source === 'env' || (typeof source === 'object' && 'env' in source)) {
        const prefix = source === 'env' ? undefined : (source.env as { prefix?: string })?.prefix
        const result = await tryEnvCredentials({ prefix })
        if (cancelled()) return
        if (result.unreachable) {
          stopUnreachable(result.unreachable)
          return
        }
        if (result.success && result.user) {
          finishAuthenticated('env', result.user, {
            scopes: result.scopes,
            tokenType: result.tokenType,
            divergenceHint: result.divergenceHint,
            sessionEnvWarning: result.sessionEnvWarning,
            meta: { source: 'env', envVar: result.envVar, validatedVia: result.validatedVia },
          })
          return
        }
        if (result.foundButInvalid) {
          // env-chip copy: "<VAR> is not valid for <host>" — never
          // "expired" (a 401 can't distinguish expired from wrong-host).
          // Main supplies the exact copy; the construction is the fallback.
          warnings.push(result.warning ?? `${result.envVar ?? `${prefix ?? ''}${provider.env.tokenVar}`} is not valid for ${unreachableHost()}`)
        }
      }
      // Check for 'cli' - provider CLI
      else if (source === 'cli') {
        const result = await tryCliCredentials()
        if (cancelled()) return
        if (result.unreachable) {
          stopUnreachable(result.unreachable)
          return
        }
        if (result.hint) {
          // Informational manual-UI hint (e.g. the glab keyring contracts)
          // — distinct from a warning chip by design. Downgrades the
          // host's key icon (the credential exists but is unreadable).
          setDetectionHint(result.hint)
          const downgraded = unreachableHost(result.host)
          setDowngradedHosts((prev) => new Set(prev).add(downgraded))
        }
        if (result.success && result.user) {
          finishAuthenticated('cli', result.user, {
            scopes: result.scopes,
            tokenType: result.tokenType,
            sessionEnvWarning: result.sessionEnvWarning,
            meta: { source: result.source ?? 'cli', validatedVia: result.validatedVia },
          })
          return
        }
        if (result.foundButInvalid) {
          const where = result.host ? ` for ${result.host}` : ''
          warnings.push(result.warning ?? `${provider.cli.label} token${where} is invalid or expired`)
          // downgrade the picked host's key icon for the rest of the
          // session so the dropdown never contradicts the warning chip.
          const downgraded = unreachableHost(result.host)
          setDowngradedHosts((prev) => new Set(prev).add(downgraded))
        }
      }
      // Check for { block: 'id' } - block outputs
      else if (typeof source === 'object' && 'block' in source) {
        const result = await tryBlockCredentials(source.block)
        if (cancelled()) return
        if (result.unreachable) {
          stopUnreachable(result.unreachable)
          return
        }
        if (result.success && result.user) {
          finishAuthenticated('block', result.user, blockCredentialDetails(result), { token: result.token })
          return
        }
        // If the block hasn't run yet, wait for it before trying the
        // lower-priority sources after it.
        if (blockPending(source.block)) {
          pausedWalkRef.current = { sources: sources.slice(i + 1), warnings }
          setWaitingForBlockId(source.block)
          // Don't set detectionStatus to 'done' yet - wait for block
          return
        }
        // The block ran but left no usable token — fall through.
      }
    }

    // Set any warnings from invalid credentials we found
    if (warnings.length > 0) {
      setDetectionWarning(warnings.join('; '))
    }

    // Nothing found
    setDetectionStatus('done')
  }, [provider, markUnreachable, unreachableHost, tryEnvCredentials, tryCliCredentials, tryBlockCredentials, blockPending, finishAuthenticated])

  // Run credential detection when session is ready
  useEffect(() => {
    // Skip if detection is disabled or already attempted
    if (detectCredentials === false || detectionAttemptedRef.current) {
      return
    }

    // Wait for session to be ready before making API calls
    if (!sessionReady) {
      return
    }

    // Wait until the available hosts are known so detection targets the right
    // GitLab instance instead of the gitlab.com default.
    if (!hostsReady) {
      return
    }

    detectionAttemptedRef.current = true

    void trySourcesInOrder(detectCredentials, detectionRunRef.current)
  }, [detectCredentials, sessionReady, hostsReady, detectionNonce, trySourcesInOrder])

  // Probe CLI install state (vcs:cli-status) once detection settles — drives
  // the hint copy and the Windows schannel suggestion. Runs on SUCCESS
  // too: the schannel suggestion lives on the success card, and zero-click
  // detection is its primary path (main caches the probe, so this is cheap).
  // Advisory: failures leave the hint generic.
  useEffect(() => {
    if (detectionStatus !== 'done') return
    let cancelled = false
    void (async () => {
      try {
        const status = await api.invoke('vcs:cli-status')
        if (!cancelled) setCliStatus(status as VcsCliStatusResult)
      } catch {
        /* hint copy is enrichment */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [api, detectionStatus])

  // Resume detection once the block it paused on has run: the walk picks up
  // at that block's source, so its token (or its lack of one, which falls
  // through to the sources after it) is handled exactly as in the walk.
  useEffect(() => {
    if (!waitingForBlockId || authStatus === 'authenticated') {
      return
    }

    if (blockPending(waitingForBlockId)) {
      return // Still waiting
    }

    // Take the paused walk and clear the wait now: blockOutputs changes
    // whenever any block registers outputs, and a re-run of this effect while
    // the block's token is being validated must not resume it a second time.
    const paused = pausedWalkRef.current
    pausedWalkRef.current = null
    setWaitingForBlockId(null)

    void trySourcesInOrder(
      [{ block: waitingForBlockId }, ...(paused?.sources ?? [])],
      detectionRunRef.current,
      paused?.warnings,
    )
  }, [waitingForBlockId, authStatus, blockPending, trySourcesInOrder])

  // Handle PAT submission
  const handlePatSubmit = useCallback(async () => {
    if (!patToken) {
      setErrorMessage('Personal Access Token is required')
      return
    }

    const submit = ++patSubmitRef.current
    setAuthStatus('authenticating')
    setErrorMessage(null)
    setUnreachableInfo(null)

    // registerSession makes MAIN write the session env; the PAT transits
    // renderer→main once.
    const validation = await validateToken(patToken, { registerSession: true })

    // The card was reset (e.g. a provider switch) while main validated.
    if (patSubmitRef.current !== submit) return

    if (!validation.valid || !validation.user) {
      // Transport failure: never report the token as invalid — render
      // the TLS/server-cert/network card instead of an auth failure.
      if (validation.errorKind) {
        markUnreachable(validation.errorKind, undefined, validation.coldReadOk)
        setAuthStatus('pending')
        return
      }
      setAuthStatus('failed')
      setErrorMessage(validation.error || 'Invalid token')
      return
    }

    registerCredentials(patToken, validation.user)
    setAuthStatus('authenticated')
    setUserInfo(validation.user)
    // Scopes come back for GitHub classic PATs (the X-OAuth-Scopes header);
    // fine-grained PATs and GitLab tokens may report none.
    applyCredentialDetails({
      scopes: validation.scopes,
      tokenType: validation.tokenType,
      sessionEnvWarning: validation.sessionEnvWarning,
      meta: validation.validatedVia ? { validatedVia: validation.validatedVia } : null,
    })
  }, [patToken, applyCredentialDetails, validateToken, registerCredentials, markUnreachable])

  // End the current device flow: bump the flow number so every continuation
  // of it stops, and drop its scheduled poll. Shared by cancel, reset and
  // unmount.
  const stopOAuthPolling = useCallback(() => {
    oauthFlowRef.current += 1
    if (oauthPollTimeoutRef.current) {
      clearTimeout(oauthPollTimeoutRef.current)
      oauthPollTimeoutRef.current = null
    }
  }, [])

  // Poll for OAuth completion until the device code expires. GitHub reports
  // `expired_token` itself once it lapses; the deadline is only a backstop.
  // `flow` is the device flow this loop belongs to; once it is no longer the
  // current one the loop stops without touching state or outputs.
  const pollOAuthCompletion = useCallback(async (flow: number, deviceCode: string, interval: number = 5, expiresIn: number = DEFAULT_OAUTH_EXPIRES_IN) => {
    const deadline = Date.now() + expiresIn * 1000
    let currentInterval = Math.max(interval, 5) * 1000 // GitHub requires at least 5 seconds
    const stale = () => oauthFlowRef.current !== flow

    const poll = async () => {
      if (stale()) return

      try {
        const data = await api.invoke('github:oauth-poll', {
          ...(effectiveClientId ? { clientId: effectiveClientId } : {}),
          deviceCode,
        })

        if (stale()) return

        if (data.status === 'pending') {
          if (Date.now() >= deadline) {
            setAuthStatus('failed')
            setErrorMessage(OAUTH_CODE_EXPIRED_MESSAGE)
            return
          }
          // slow_down (RFC 8628 §3.5): add 5 seconds, or wait GitHub's new
          // interval if that is longer, for this and every later poll.
          if (data.slowDown) {
            currentInterval = Math.max(currentInterval + 5000, (data.interval ?? 0) * 1000)
          }
          oauthPollTimeoutRef.current = setTimeout(poll, currentInterval)
        } else if (data.status === 'complete') {
          // Success! The completion is METADATA-ONLY: main already wrote
          // the session env; the token never reaches the renderer.
          const user = data.user as unknown as GitUserInfo
          registerMetadataOutputs(user)
          setAuthStatus('authenticated')
          setUserInfo(user)
          applyCredentialDetails({
            scopes: data.scopes,
            tokenType: data.tokenType as GitTokenType | undefined,
            sessionEnvWarning: data.sessionEnvWarning,
          })
        } else if (data.status === 'expired') {
          setAuthStatus('failed')
          setErrorMessage(OAUTH_CODE_EXPIRED_MESSAGE)
        } else {
          // Denied, or another error main reported
          setAuthStatus('failed')
          setErrorMessage(data.error || 'Authorization failed')
        }
      } catch (error) {
        if (stale()) return
        setAuthStatus('failed')
        setErrorMessage(error instanceof Error ? error.message : 'Failed to check authorization status')
      }
    }

    poll()
  }, [api, effectiveClientId, registerMetadataOutputs, applyCredentialDetails])

  // Start OAuth device flow
  const startOAuth = useCallback(async () => {
    // A new flow supersedes any earlier one, even a poll still in flight.
    stopOAuthPolling()
    const flow = oauthFlowRef.current
    setAuthStatus('authenticating')
    setErrorMessage(null)

    try {
      const data = await api.invoke('github:oauth-start', {
        ...(effectiveClientId ? { clientId: effectiveClientId } : {}),
        scopes: oauthScopes,
      })

      // Cancelled (or reset) while GitHub issued the code.
      if (oauthFlowRef.current !== flow) return

      if (data.error) {
        setAuthStatus('failed')
        setErrorMessage(data.error)
        return
      }

      setOauthUserCode(data.userCode)
      setOauthVerificationUri(data.verificationUri)

      // Start polling for completion (use interval and expiry from GitHub,
      // default 5s and 15 minutes)
      // Note: We don't auto-open the browser - let user see the code first
      const pollInterval = data.interval || 5
      pollOAuthCompletion(flow, data.deviceCode, pollInterval, data.expiresIn || DEFAULT_OAUTH_EXPIRES_IN)
    } catch (error) {
      if (oauthFlowRef.current !== flow) return
      setAuthStatus('failed')
      setErrorMessage(error instanceof Error ? error.message : 'Failed to start OAuth flow')
    }
  }, [api, effectiveClientId, oauthScopes, pollOAuthCompletion, stopOAuthPolling])

  // Cancel OAuth polling
  const cancelOAuth = useCallback(() => {
    stopOAuthPolling()
    setAuthStatus('pending')
    setOauthUserCode(null)
    setOauthVerificationUri(null)
  }, [stopOAuthPolling])

  // Cleanup on unmount: cancel any pending OAuth polling
  useEffect(() => stopOAuthPolling, [stopOAuthPolling])

  // Clear the credential-detection display state (status, user, source badges,
  // scopes, warnings, hints, success meta). Shared by resetAuth and the
  // redetect entry points so a new detection field only has to be cleared once.
  const clearDetectionState = useCallback(() => {
    setAuthStatus('pending')
    setUserInfo(null)
    setDetectionSource(null)
    setDetectedScopes(null)
    setDetectedTokenType(null)
    setMissingScope(false)
    setDetectionWarning(null)
    setUnreachableInfo(null)
    setDetectionHint(null)
    setDivergenceHint(null)
    setSuccessMeta(null)
    setSessionStale(false)
    setSessionEnvWarning(null)
  }, [])

  // Reset the card to the sign-in form. Leaves the block's outputs alone:
  // a provider switch writes the new GIT_PROVIDER before calling this, and
  // reAuthenticate withdraws the old credential itself.
  const resetAuth = useCallback(() => {
    // End any device flow, including a poll still in flight, and drop a PAT
    // validation still in flight.
    stopOAuthPolling()
    patSubmitRef.current += 1
    clearDetectionState()
    setErrorMessage(null)
    setPatToken('')
    setOauthUserCode(null)
    setOauthVerificationUri(null)
  }, [clearDetectionState, stopOAuthPolling])

  // "Re-authenticate" on the success card. The card going back to the form
  // takes the block's outputs with it (GIT_PROVIDER stays for downstream
  // PR/MR blocks), so an `*AuthId` step stays gated until the new sign-in
  // instead of running with the replaced credential. The session env keeps
  // the old token until the next sign-in replaces it; this does not clear it.
  // Focus re-detection stays off until the user asks for a check: it would
  // sign straight back in with the ambient env/CLI credential the user is
  // trying to replace, e.g. while they are away creating a new token.
  const reAuthenticate = useCallback(() => {
    clearRegisteredOutputs(provider.id)
    setRedetectSuppressed(true)
    resetAuth()
  }, [clearRegisteredOutputs, provider.id, resetAuth])

  // Reset detection so it re-runs for a freshly-selected provider. Setting
  // detectionStatus back to 'pending' (when detection is enabled) shows the
  // "Checking…" state instead of flashing the manual form, and clearing
  // detectionAttemptedRef lets the detection effect fire again. Every
  // explicit re-detection (beginRedetect) and a provider switch pass through
  // here, so this is also what re-arms focus re-detection after reAuthenticate.
  const resetDetectionState = useCallback(() => {
    detectionRunRef.current += 1 // invalidate any in-flight detection loop
    detectionAttemptedRef.current = false
    pausedWalkRef.current = null
    setWaitingForBlockId(null)
    setRedetectSuppressed(false)
    setDetectionStatus(detectCredentials === false ? 'done' : 'pending')
  }, [detectCredentials])

  // Clear transient auth/detection state and arm the detection effect to fire
  // again. Shared by host switching and the manual config reload.
  const beginRedetect = useCallback(() => {
    clearDetectionState()
    resetDetectionState()
  }, [clearDetectionState, resetDetectionState])

  // Flush main's per-(binary,host) CLI read cache (invalidation) so an
  // explicit re-detection observes a terminal `gh auth switch`/`glab auth
  // login` immediately instead of after the 5-minute TTL. Fire-and-forget.
  const invalidateMainCache = useCallback(() => {
    void api.invoke('vcs:invalidate-cache').catch(() => {})
  }, [api])

  // The success card's "Apply" for the Windows schannel suggestion: main sets
  // git's http.sslBackend to schannel. Fire-and-forget, like the suggestion.
  const applySchannel = useCallback(() => {
    void api.invoke('vcs:apply-git-schannel').catch(() => {})
  }, [api])

  // Switch the selected GitLab host and re-detect against it. Compares with
  // the host the picker shows (effectiveHost), not the internal pick: once an
  // instance URL is entered the two differ, and picking the previously picked
  // host must still take effect.
  const changeHost = useCallback((nextHost: string) => {
    if (nextHost === effectiveHostRef.current) return
    userPickedHostRef.current = true
    invalidateMainCache()
    // Persist the explicit pick (any source) so it survives restart.
    void api.invoke('gitlab:host-picked', { host: nextHost }).catch(() => {})
    // A pick supersedes an entered or prop-seeded instance URL, which would
    // otherwise keep overriding effectiveHost and every IPC call.
    setGitlabInstanceUrl('')
    setSelectedHost(nextHost)
    beginRedetect()
    setDetectionNonce((n) => n + 1)
  }, [api, beginRedetect, invalidateMainCache])

  // HostSelect onChange wrapper: the "Other instance…" row uses a sentinel
  // value intercepted BEFORE changeHost. When authenticated it leaves the
  // success card (it is "Re-authenticate") so the PAT form, which
  // carries the instance-URL field, renders; either way that field is then
  // focused. It does NOT alter selectedHost or run detection; the controlled
  // select snaps back to its prior value on the next render.
  const handleHostSelect = useCallback((value: string) => {
    if (value === OTHER_INSTANCE_SENTINEL) {
      // Only when authenticated: resetting a pending form would also wipe a
      // typed token and the current host's unreachable card.
      if (authStatus === 'authenticated') reAuthenticate()
      setAuthMethod('pat')
      setInstanceFieldFocusNonce((n) => n + 1)
      return
    }
    changeHost(value)
  }, [authStatus, reAuthenticate, changeHost])

  // Re-read glab's config (hosts may have changed after a `glab auth login`) and
  // re-run detection for the current host. Backs the "Reload" button.
  //
  // Only bump hostsReloadNonce — NOT detectionNonce. Re-enumeration flips
  // hostsReady false→true, and that transition (with detectionAttemptedRef
  // already cleared by beginRedetect) drives a single detection against the
  // freshly-resolved host. Bumping detectionNonce too would fire detection
  // immediately against the *pre-reload* host and then lock detectionAttemptedRef,
  // so a changed glab default would never be re-detected.
  const reloadDetection = useCallback(() => {
    // Reload re-enumerates, flushes the CLI token cache, clears
    // the transport-degraded flags (both via vcs:invalidate-cache), resets
    // the key-icon downgrades, and re-runs trust install + detection.
    invalidateMainCache()
    setDowngradedHosts(new Set())
    beginRedetect()
    setHostsReloadNonce((n) => n + 1)
  }, [beginRedetect, invalidateMainCache])

  // The unreachable card's Retry and the "Check again" control:
  // clears the card, flushes main's CLI cache, and re-runs detection. The
  // backend re-runs the cold-read trust refresh automatically on the next
  // TLS-classified failure, so a CA installed mid-session is picked up without
  // an app restart. Bumps detectionNonce directly (unlike reloadDetection's
  // hostsReady round-trip) so it works for host-less providers (GitHub) too.
  const retryUnreachable = useCallback(() => {
    invalidateMainCache()
    beginRedetect()
    setDetectionNonce((n) => n + 1)
  }, [beginRedetect, invalidateMainCache])

  // Track which host this block authenticated against, and watch for another
  // block replacing the provider's single session credential.
  useEffect(() => {
    if (authStatus === 'authenticated') {
      authenticatedHostRef.current =
        provider.id === 'github' ? 'github.com' : (effectiveHostRef.current ?? DEFAULT_GITLAB_HOST)
    } else {
      authenticatedHostRef.current = undefined
      setSessionStale(false)
    }
  }, [authStatus, provider])

  useEffect(() => {
    const unsubscribe = api.on('vcs:session-changed', (payload) => {
      if (payload.provider !== provider.id) return
      const myHost = authenticatedHostRef.current
      if (myHost && payload.host !== myHost) {
        setSessionStale(true)
      }
    })
    return unsubscribe
  }, [api, provider])

  // re-run detection automatically on window focus
  // while sitting IDLE in the manual UI — makes the terminal-`gh auth login`
  // flow genuinely zero-click. Debounced. Armed ONLY in 'pending': the OAuth
  // device flow guarantees a focus round-trip ('authenticating' — a redetect
  // would unmount the code panel mid-flow), and a redetect after 'failed'
  // would wipe the failure UI the user is reading. After an explicit
  // Re-authenticate, re-detection is user-initiated only (Check again, Retry,
  // Reload), as AwsAuth's and GoogleAuth's "Try auto-detection again" is.
  const focusRedetectArmed =
    detectCredentials !== false && detectionStatus === 'done' && authStatus === 'pending' && !redetectSuppressed
  useEffect(() => {
    if (!focusRedetectArmed) return
    let lastRun = 0
    const onFocus = () => {
      const now = Date.now()
      if (now - lastRun < 2_000) return
      lastRun = now
      retryUnreachable()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [focusRedetectArmed, retryUnreachable])

  const oauthUnavailableReason =
    provider.supportsOAuth &&
    unreachableInfo &&
    (unreachableInfo.errorKind === 'network' || unreachableInfo.errorKind === 'tls')
      ? `${unreachableInfo.host} is unreachable — fix connectivity first`
      : null

  // Manual-UI hint line: a main-supplied contract copy (keyring
  // cases) wins; otherwise the vcs:cli-status-driven default. Suppressed when
  // a warning chip already explains the situation.
  const manualHint = (() => {
    if (detectionHint) return detectionHint
    if (detectionWarning || unreachableInfo) return null
    const providerCliStatus = cliStatus?.[provider.cli.binary]
    if (!providerCliStatus) return null
    const lead = `No existing credentials found. Sign in below, set ${provider.env.tokenVar}, or`
    return providerCliStatus.installed
      ? `${lead} run '${provider.cli.loginCmd}'.`
      : `${lead} install the ${provider.label} CLI (${provider.cli.binary}).`
  })()

  return {
    // Auth state
    authMethod,
    setAuthMethod,
    authStatus,
    errorMessage,
    userInfo,

    // Detection state
    detectionStatus,
    detectionSource,
    detectedScopes,
    detectedTokenType,
    missingScope,
    detectionWarning,
    sessionEnvWarning,
    waitingForBlockId,

    // Tri-state unreachable outcome
    unreachableInfo,
    retryUnreachable,
    oauthUnavailableReason,

    // Manual-UI hint + diagnostics
    manualHint,
    divergenceHint,
    cliStatus,
    successMeta,
    sessionStale,

    // Host selection (GitLab)
    hostSelectable,
    availableHosts,
    selectedHost: effectiveHost ?? selectedHost,
    changeHost,
    handleHostSelect,
    downgradedHosts,
    reloadDetection,

    // PAT form
    patToken,
    setPatToken,
    showPatToken,
    setShowPatToken,
    handlePatSubmit,
    gitlabInstanceUrl,
    setGitlabInstanceUrl,
    instanceFieldFocusNonce,

    // OAuth
    effectiveClientId,
    isCustomClientId,
    oauthUserCode,
    oauthVerificationUri,
    startOAuth,
    cancelOAuth,

    // Actions
    resetAuth,
    reAuthenticate,
    resetDetectionState,
    clearRegisteredOutputs,
    applySchannel,
  }
}
