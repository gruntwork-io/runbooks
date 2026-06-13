import { useState, useCallback, useRef, useEffect } from "react"
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

interface UseGitAuthOptions {
  id: string
  provider: ProviderConfig
  /** Self-hosted GitLab instance URL (GitLab only); seeds the editable field. */
  instanceUrl?: string
  oauthClientId?: string
  oauthScopes?: string[]
  detectCredentials?: false | GitCredentialSource[]
  /** GitLab only: an authored host that pins the instance and hides the picker. */
  host?: string
}

const DEFAULT_GITLAB_HOST = 'gitlab.com'

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
}: UseGitAuthOptions) {
  const { registerOutputs, blockOutputs } = useRunbookContext()
  const { isReady: sessionReady } = useSession()

  // Core auth state. The default manual method depends on the provider: GitHub
  // defaults to OAuth, GitLab (no OAuth) to PAT.
  const [authMethod, setAuthMethod] = useState<GitAuthMethod>(
    provider.supportsOAuth ? 'oauth' : 'pat'
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
  const [scopeWarning, setScopeWarning] = useState<string | null>(null)
  const [detectionWarning, setDetectionWarning] = useState<string | null>(null)
  const [sessionEnvWarning, setSessionEnvWarning] = useState<string | null>(null)
  const [unreachableInfo, setUnreachableInfo] = useState<GitUnreachableInfo | null>(null)
  // Manual-UI hint copy from main (e.g. the glab keyring contracts, §7) —
  // informational, distinct from any warning chip.
  const [detectionHint, setDetectionHint] = useState<string | null>(null)
  // §2.1 both-set-and-differ env hint, shown on the success card.
  const [divergenceHint, setDivergenceHint] = useState<string | null>(null)
  const [cliStatus, setCliStatus] = useState<VcsCliStatusResult | null>(null)
  const [successMeta, setSuccessMeta] = useState<GitSuccessMeta | null>(null)
  // §4 item 9: set when another block's auth replaced this provider's single
  // session credential with a different host (vcs:session-changed).
  const [sessionStale, setSessionStale] = useState(false)
  const authenticatedHostRef = useRef<string | undefined>(undefined)
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
  // session (§4: the dropdown must never contradict the warning chip).
  const [downgradedHosts, setDowngradedHosts] = useState<ReadonlySet<string>>(new Set())
  const [hostsReady, setHostsReady] = useState<boolean>(!hostSelectable)
  // Bumped to force the detection effect to re-run (host change / manual reload).
  const [detectionNonce, setDetectionNonce] = useState(0)
  // Bumped to force re-enumeration of glab hosts (manual "reload config").
  const [hostsReloadNonce, setHostsReloadNonce] = useState(0)
  // True once the user explicitly picks a host, so a config reload preserves it
  // instead of snapping back to glab's default.
  const userPickedHostRef = useRef(false)

  // For block-based detection, track which block we're waiting for
  const [waitingForBlockId, setWaitingForBlockId] = useState<string | null>(null)

  // PAT form state
  const [patToken, setPatToken] = useState('')
  const [showPatToken, setShowPatToken] = useState(false)

  // GitLab self-hosted instance URL, seeded from the prop and editable in the
  // PAT form. Only meaningful for the GitLab provider; sent with the token so
  // validation/detection targets the right instance (empty → gitlab.com).
  const [gitlabInstanceUrl, setGitlabInstanceUrl] = useState(instanceUrl ?? '')

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
  const oauthPollingCancelledRef = useRef(false)
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
  const shouldWarnMissingScope = useCallback((scopes: string[] | undefined): boolean => {
    if (!provider.success.showScopeWarning || !provider.success.requiredScope) return false
    if (!scopes || scopes.length === 0) return false
    const acceptable = provider.success.acceptableScopes ?? [provider.success.requiredScope]
    return !scopes.some((scope) => acceptable.includes(scope))
  }, [provider])

  // Helper to check for credentials from block outputs. A referenced GitAuth
  // block (marked __AUTHENTICATED) is metadata-only as of §8 — its credential
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

  // Register credentials as BLOCK OUTPUTS only (§8: main writes the session
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
  // paths — no raw token ever enters block outputs for these (§8).
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

  // Shared success epilogue — every detection source ends a successful
  // detection the same way; per-source extras (meta, hints, scopes) are set
  // before the call. Outputs are metadata-only, but WITH the user var:
  // downstream blocks read GITHUB_USER/GITLAB_USER regardless of credential
  // source. Pass `registerOutputs: false` when the path already registered the
  // full outputs map (user/token vars included) — re-registering the bare
  // metadata here would REPLACE it and wipe those values.
  const finishAuthenticated = useCallback((
    src: GitDetectionSource,
    user: GitUserInfo,
    sessionEnvWarning?: string,
    opts?: { registerOutputs?: boolean },
  ) => {
    setDetectionSource(src)
    setAuthStatus('authenticated')
    setUserInfo(user)
    if (sessionEnvWarning) {
      setSessionEnvWarning(sessionEnvWarning)
    }
    setDetectionStatus('done')
    if (opts?.registerOutputs !== false) {
      registerMetadataOutputs(user)
    }
  }, [registerMetadataOutputs])

  // Validate a token via the provider's API. `registerSession` makes MAIN
  // write the session env on success (§8 — the PAT and block paths);
  // `useSessionToken` validates the provider's session credential instead of
  // sending one (the GitAuth-block chaining mode — no token crosses IPC).
  const validateToken = useCallback(async (
    token: string | undefined,
    opts?: { registerSession?: boolean; useSessionToken?: boolean },
  ): Promise<{ valid: boolean; user?: GitUserInfo; scopes?: string[]; tokenType?: GitTokenType; error?: string; errorKind?: GitErrorKind; coldReadOk?: boolean; validatedVia?: 'direct' | 'cli'; sessionEnvWarning?: string }> => {
    try {
      // A manually-entered instance URL takes precedence over the picked host.
      const data = await window.api.invoke(provider.channels.validate, {
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
  }, [provider, instanceUrlForIpc])

  // Try to detect credentials from environment variables
  const tryEnvCredentials = useCallback(async (options?: { prefix?: string }): Promise<{ success: boolean; user?: GitUserInfo; scopes?: string[]; tokenType?: GitTokenType; error?: string; foundButInvalid?: boolean; warning?: string; envVar?: string; divergenceHint?: string; validatedVia?: 'direct' | 'cli'; sessionEnvWarning?: string; unreachable?: { errorKind: GitErrorKind; host?: string; coldReadOk?: boolean } }> => {
    try {
      const data = await window.api.invoke(provider.channels.envCredentials, {
        envVar: '',
        prefix: options?.prefix || '',
        githubAuthId: id,
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
        // copy ("<VAR> is not valid for <host>" — never "expired", §2.0).
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
  }, [id, provider, instanceUrlForIpc])

  // Try to detect credentials from the provider's CLI
  const tryCliCredentials = useCallback(async (): Promise<{ success: boolean; user?: GitUserInfo; scopes?: string[]; error?: string; foundButInvalid?: boolean; warning?: string; hint?: string; host?: string; source?: 'env' | 'cli' | 'config'; validatedVia?: 'direct' | 'cli'; sessionEnvWarning?: string; unreachable?: { errorKind: GitErrorKind; host?: string; coldReadOk?: boolean } }> => {
    try {
      const data = await window.api.invoke(
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
        // host, etc.). The backend signals this with `found: true` and/or an
        // HTTP status; rely on those rather than fragile error-string matching
        // (a GitLab 401 body reads "401 Unauthorized", not "invalid"/"expired").
        const error = data.error?.toLowerCase()
        const foundButInvalid =
          data.found === true ||
          data.status === 401 ||
          data.status === 403 ||
          error?.includes('invalid') ||
          error?.includes('expired') ||
          error?.includes('unauthorized') ||
          error?.includes('forbidden')
        return { success: false, error: data.error, foundButInvalid, warning: data.warning, hint: data.hint, host: data.host }
      }

      return {
        success: true,
        user: data.user,
        scopes: data.scopes,
        host: data.host,
        source: data.source,
        validatedVia: data.validatedVia,
        sessionEnvWarning: data.sessionEnvWarning,
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to check CLI credentials' }
    }
  }, [provider, instanceUrlForIpc])

  // Try to detect credentials from block outputs (§8 block-chaining):
  // a referenced GitAuth block resolves against the SESSION env in main
  // (useSessionToken mode — no token crosses IPC); any other block's
  // renderer-held output value flows as today, with main writing the session.
  const tryBlockCredentials = useCallback(async (blockId: string): Promise<{ success: boolean; user?: GitUserInfo; error?: string; sessionEnvWarning?: string; unreachable?: { errorKind: GitErrorKind; coldReadOk?: boolean } }> => {
    const result = getBlockCredentials(blockId)

    if (!result.found) {
      return { success: false, error: result.error || 'Could not read token from block' }
    }

    const useSessionToken = result.token === undefined && result.isGitAuthBlock === true
    const validation = useSessionToken
      ? await validateToken(undefined, { useSessionToken: true })
      : await validateToken(result.token, { registerSession: true })

    if (!validation.valid || !validation.user) {
      // Transport failure (§2.0): the block's token was not consumed/judged.
      if (validation.errorKind) {
        return {
          success: false,
          error: validation.error,
          unreachable: { errorKind: validation.errorKind, coldReadOk: validation.coldReadOk },
        }
      }
      return { success: false, error: validation.error || 'Block token is invalid' }
    }

    // Register outputs: the session-chained path stays metadata-only.
    if (useSessionToken || !result.token) {
      registerMetadataOutputs(validation.user)
    } else {
      registerCredentials(result.token, validation.user)
    }

    return { success: true, user: validation.user, sessionEnvWarning: validation.sessionEnvWarning }
  }, [getBlockCredentials, validateToken, registerCredentials, registerMetadataOutputs])

  // Discover which GitLab hosts the user is logged into via glab, to drive the
  // host picker. Skipped for GitHub and when the author pinned a `host`. Re-runs
  // on a manual config reload (hostsReloadNonce).
  useEffect(() => {
    if (!hostSelectable || !provider.channels.enumerateHosts) {
      setAvailableHosts(host ? [{ host, sources: [], hasCredential: false }] : [])
      setSelectedHost(host ?? DEFAULT_GITLAB_HOST)
      setHostsReady(true)
      return
    }
    if (!sessionReady) return

    let cancelled = false
    setHostsReady(false)
    const channel = provider.channels.enumerateHosts
    void (async () => {
      try {
        const data = await window.api.invoke(channel, {})
        if (cancelled) return
        // §4: the enumerate result is the annotated merged union (objects);
        // membership checks compare against hosts.map(h => h.host).
        const hosts = (data.hosts ?? []) as GitLabHostEntry[]
        const hostNames = hosts.map((h) => h.host)
        setAvailableHosts(hosts)
        // Honor the §4 default (persisted pick > env > glab > gitlab.com) on
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
        if (!cancelled) setHostsReady(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [hostSelectable, provider, host, sessionReady, hostsReloadNonce])

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

    const runDetection = async () => {
      const runId = detectionRunRef.current
      const cancelled = () => detectionRunRef.current !== runId
      const warnings: string[] = []

      // §2.0 'unreachable': stop the chain WITHOUT consuming later sources —
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

      for (const source of detectCredentials) {
        // Check for 'env' - standard env vars
        if (source === 'env') {
          const result = await tryEnvCredentials()
          if (cancelled()) return
          if (result.unreachable) {
            stopUnreachable(result.unreachable)
            return
          }
          if (result.success && result.user) {
            setSuccessMeta({ source: 'env', envVar: result.envVar, validatedVia: result.validatedVia })
            if (result.divergenceHint) {
              setDivergenceHint(result.divergenceHint)
            }
            if (result.tokenType) {
              setDetectedTokenType(result.tokenType)
            }
            if (result.scopes && result.scopes.length > 0) {
              setDetectedScopes(result.scopes)
              if (shouldWarnMissingScope(result.scopes)) {
                setScopeWarning(`Missing "${provider.success.requiredScope}" scope - some operations may fail`)
              }
            }
            finishAuthenticated('env', result.user, result.sessionEnvWarning)
            return
          }
          if (result.foundButInvalid) {
            // §2.0 env-chip copy: "<VAR> is not valid for <host>" — never
            // "expired" (a 401 can't distinguish expired from wrong-host).
            // Main supplies the exact copy; the construction is the fallback.
            warnings.push(result.warning ?? `${result.envVar ?? provider.env.tokenVar} is not valid for ${unreachableHost()}`)
          }
        }
        // Check for { env: { prefix: 'PREFIX_' } } - prefixed env vars
        else if (typeof source === 'object' && 'env' in source) {
          const prefix = (source.env as { prefix?: string })?.prefix
          const result = await tryEnvCredentials({ prefix })
          if (cancelled()) return
          if (result.unreachable) {
            stopUnreachable(result.unreachable)
            return
          }
          if (result.success && result.user) {
            if (result.tokenType) {
              setDetectedTokenType(result.tokenType)
            }
            if (result.scopes && result.scopes.length > 0) {
              setDetectedScopes(result.scopes)
              if (shouldWarnMissingScope(result.scopes)) {
                setScopeWarning(`Missing "${provider.success.requiredScope}" scope - some operations may fail`)
              }
            }
            finishAuthenticated('env', result.user, result.sessionEnvWarning)
            return
          }
          if (result.foundButInvalid) {
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
            // Informational manual-UI hint (e.g. the glab keyring contracts,
            // §7) — distinct from a warning chip by design. Downgrades the
            // host's key icon (the credential exists but is unreadable).
            setDetectionHint(result.hint)
            const downgraded = unreachableHost(result.host)
            setDowngradedHosts((prev) => new Set(prev).add(downgraded))
          }
          if (result.success && result.user) {
            setSuccessMeta({ source: result.source ?? 'cli', validatedVia: result.validatedVia })
            setDetectedScopes(result.scopes ?? null)
            if (shouldWarnMissingScope(result.scopes)) {
              setScopeWarning(`Missing "${provider.success.requiredScope}" scope - some operations may fail`)
            }
            finishAuthenticated('cli', result.user, result.sessionEnvWarning)
            return
          }
          if (result.foundButInvalid) {
            const where = result.host ? ` for ${result.host}` : ''
            warnings.push(result.warning ?? `${provider.cli.label} token${where} is invalid or expired`)
            // §4: downgrade the picked host's key icon for the rest of the
            // session so the dropdown never contradicts the warning chip.
            const downgraded = unreachableHost(result.host)
            setDowngradedHosts((prev) => new Set(prev).add(downgraded))
          }
        }
        // Check for { block: 'id' } - block outputs
        else if ('block' in source) {
          const result = await tryBlockCredentials(source.block)
          if (cancelled()) return
          if (result.unreachable) {
            stopUnreachable(result.unreachable)
            return
          }
          if (result.success && result.user) {
            // tryBlockCredentials already registered the full outputs map.
            finishAuthenticated('block', result.user, result.sessionEnvWarning, { registerOutputs: false })
            return
          }
          // If block hasn't run yet, we need to wait for it
          const blockResult = getBlockCredentials(source.block)
          if (!blockResult.found) {
            setWaitingForBlockId(source.block)
            // Don't set detectionStatus to 'done' yet - wait for block
            return
          }
        }
      }

      // Set any warnings from invalid credentials we found
      if (warnings.length > 0) {
        setDetectionWarning(warnings.join('; '))
      }

      // Nothing found
      setDetectionStatus('done')
    }

    runDetection()
  }, [detectCredentials, id, provider, sessionReady, hostsReady, detectionNonce, shouldWarnMissingScope, markUnreachable, unreachableHost, tryEnvCredentials, tryCliCredentials, tryBlockCredentials, getBlockCredentials, finishAuthenticated])

  // Probe CLI install state (vcs:cli-status) once detection settles — drives
  // the §5/§7 hint copy and the Windows schannel suggestion. Runs on SUCCESS
  // too: the schannel suggestion lives on the success card, and zero-click
  // detection is its primary path (main caches the probe, so this is cheap).
  // Advisory: failures leave the hint generic.
  useEffect(() => {
    if (detectionStatus !== 'done') return
    let cancelled = false
    void (async () => {
      try {
        const status = await window.api.invoke('vcs:cli-status')
        if (!cancelled) setCliStatus(status as VcsCliStatusResult)
      } catch {
        /* hint copy is enrichment */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [detectionStatus])

  // Watch for block outputs when waiting for a block
  useEffect(() => {
    if (!waitingForBlockId || authStatus === 'authenticated') {
      return
    }

    const result = getBlockCredentials(waitingForBlockId)
    if (!result.found) {
      return // Still waiting
    }

    // Block has outputs now, try to authenticate
    const doAuth = async () => {
      const runId = detectionRunRef.current
      const authResult = await tryBlockCredentials(waitingForBlockId)
      // Context changed mid-flight (provider switch / host change / reload).
      if (detectionRunRef.current !== runId) return
      if (authResult.success && authResult.user) {
        // tryBlockCredentials already registered the full outputs map.
        finishAuthenticated('block', authResult.user, authResult.sessionEnvWarning, { registerOutputs: false })
      } else {
        // Block auth failed, continue to manual auth
        setDetectionStatus('done')
      }
      setWaitingForBlockId(null)
    }

    doAuth()
  }, [waitingForBlockId, authStatus, blockOutputs, getBlockCredentials, tryBlockCredentials, finishAuthenticated])

  // Handle PAT submission
  const handlePatSubmit = useCallback(async () => {
    if (!patToken) {
      setErrorMessage('Personal Access Token is required')
      return
    }

    setAuthStatus('authenticating')
    setErrorMessage(null)
    setUnreachableInfo(null)

    // §8: registerSession makes MAIN write the session env; the PAT transits
    // renderer→main once.
    const validation = await validateToken(patToken, { registerSession: true })

    if (!validation.valid || !validation.user) {
      // Transport failure (§2.0): never report the token as invalid — render
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
    setUnreachableInfo(null)
    setSuccessMeta(validation.validatedVia ? { validatedVia: validation.validatedVia } : null)
    setSessionEnvWarning(validation.sessionEnvWarning ?? null)

    // Set token type if available
    if (validation.tokenType) {
      setDetectedTokenType(validation.tokenType)
    }

    // Set scopes if available (GitHub classic PATs return scopes from
    // X-OAuth-Scopes header; fine-grained PATs and GitLab tokens do not).
    if (validation.scopes && validation.scopes.length > 0) {
      setDetectedScopes(validation.scopes)
      if (shouldWarnMissingScope(validation.scopes)) {
        setScopeWarning(`Missing "${provider.success.requiredScope}" scope - some operations may fail`)
      }
    }
  }, [patToken, provider, shouldWarnMissingScope, validateToken, registerCredentials, markUnreachable])

  // Poll for OAuth completion
  const pollOAuthCompletion = useCallback(async (deviceCode: string, interval: number = 5) => {
    const maxAttempts = 24 // ~2 minutes with 5s interval
    let attempts = 0
    let currentInterval = Math.max(interval, 5) * 1000 // GitHub requires at least 5 seconds

    const poll = async () => {
      if (oauthPollingCancelledRef.current) return

      try {
        const data = await window.api.invoke('github:oauth-poll', {
          ...(effectiveClientId ? { clientId: effectiveClientId } : {}),
          deviceCode,
        })

        if (oauthPollingCancelledRef.current) return

        if (data.status === 'pending' && attempts < maxAttempts) {
          attempts++
          // If we got slow_down, increase interval by 5 seconds
          if (data.slowDown) {
            currentInterval += 5000
          }
          oauthPollTimeoutRef.current = setTimeout(poll, currentInterval)
        } else if (data.status === 'complete') {
          // Success! The completion is METADATA-ONLY (§8): main already wrote
          // the session env; the token never reaches the renderer.
          const user = data.user as unknown as GitUserInfo
          registerMetadataOutputs(user)
          if (oauthPollingCancelledRef.current) return
          setAuthStatus('authenticated')
          setUserInfo(user)
          if (data.sessionEnvWarning) {
            setSessionEnvWarning(data.sessionEnvWarning)
          }
          if (data.scopes && data.scopes.length > 0) {
            setDetectedScopes(data.scopes)
            if (shouldWarnMissingScope(data.scopes)) {
              setScopeWarning(`Missing "${provider.success.requiredScope}" scope - some operations may fail`)
            }
          }
          if (data.tokenType) {
            setDetectedTokenType(data.tokenType as GitTokenType)
          }
        } else if (data.status === 'expired') {
          if (oauthPollingCancelledRef.current) return
          setAuthStatus('failed')
          setErrorMessage('Authorization request expired. Please try again.')
        } else {
          // Error or max attempts reached
          if (oauthPollingCancelledRef.current) return
          setAuthStatus('failed')
          setErrorMessage(data.error || 'Authorization failed')
        }
      } catch (error) {
        if (!oauthPollingCancelledRef.current) {
          setAuthStatus('failed')
          setErrorMessage(error instanceof Error ? error.message : 'Failed to check authorization status')
        }
      }
    }

    poll()
  }, [effectiveClientId, provider, registerMetadataOutputs, shouldWarnMissingScope])

  // Start OAuth device flow
  const startOAuth = useCallback(async () => {
    setAuthStatus('authenticating')
    setErrorMessage(null)
    oauthPollingCancelledRef.current = false

    try {
      const data = await window.api.invoke('github:oauth-start', {
        ...(effectiveClientId ? { clientId: effectiveClientId } : {}),
        scopes: oauthScopes,
      })

      if (data.error) {
        setAuthStatus('failed')
        setErrorMessage(data.error)
        return
      }

      setOauthUserCode(data.userCode)
      setOauthVerificationUri(data.verificationUri)

      // Start polling for completion (use interval from GitHub, default 5s)
      // Note: We don't auto-open the browser - let user see the code first
      const pollInterval = data.interval || 5
      pollOAuthCompletion(data.deviceCode, pollInterval)
    } catch (error) {
      setAuthStatus('failed')
      setErrorMessage(error instanceof Error ? error.message : 'Failed to start OAuth flow')
    }
  }, [effectiveClientId, oauthScopes, pollOAuthCompletion])

  // Cancel OAuth polling
  const cancelOAuth = useCallback(() => {
    oauthPollingCancelledRef.current = true
    if (oauthPollTimeoutRef.current) {
      clearTimeout(oauthPollTimeoutRef.current)
      oauthPollTimeoutRef.current = null
    }
    setAuthStatus('pending')
    setOauthUserCode(null)
    setOauthVerificationUri(null)
  }, [])

  // Cleanup on unmount: cancel any pending OAuth polling
  useEffect(() => {
    return () => {
      oauthPollingCancelledRef.current = true
      if (oauthPollTimeoutRef.current) {
        clearTimeout(oauthPollTimeoutRef.current)
        oauthPollTimeoutRef.current = null
      }
    }
  }, [])

  // Reset to allow re-authentication
  const resetAuth = useCallback(() => {
    // Clear any pending polling before resetting
    if (oauthPollTimeoutRef.current) {
      clearTimeout(oauthPollTimeoutRef.current)
      oauthPollTimeoutRef.current = null
    }
    setAuthStatus('pending')
    setErrorMessage(null)
    setUserInfo(null)
    setPatToken('')
    setOauthUserCode(null)
    setOauthVerificationUri(null)
    setDetectionSource(null)
    setDetectedScopes(null)
    setDetectedTokenType(null)
    setScopeWarning(null)
    setDetectionWarning(null)
    setUnreachableInfo(null)
    setDetectionHint(null)
    setDivergenceHint(null)
    setSuccessMeta(null)
    setSessionStale(false)
    setSessionEnvWarning(null)
    oauthPollingCancelledRef.current = false
  }, [])

  // Reset detection so it re-runs for a freshly-selected provider. Setting
  // detectionStatus back to 'pending' (when detection is enabled) shows the
  // "Checking…" state instead of flashing the manual form, and clearing
  // detectionAttemptedRef lets the detection effect fire again.
  const resetDetectionState = useCallback(() => {
    detectionRunRef.current += 1 // invalidate any in-flight detection loop
    detectionAttemptedRef.current = false
    setWaitingForBlockId(null)
    setDetectionStatus(detectCredentials === false ? 'done' : 'pending')
  }, [detectCredentials])

  // Clear transient auth/detection state and arm the detection effect to fire
  // again. Shared by host switching and the manual config reload.
  const beginRedetect = useCallback(() => {
    detectionRunRef.current += 1 // invalidate any in-flight detection loop
    detectionAttemptedRef.current = false
    setAuthStatus('pending')
    setUserInfo(null)
    setDetectionSource(null)
    setDetectedScopes(null)
    setDetectedTokenType(null)
    setScopeWarning(null)
    setDetectionWarning(null)
    setUnreachableInfo(null)
    setDetectionHint(null)
    setDivergenceHint(null)
    setSuccessMeta(null)
    setSessionStale(false)
    setSessionEnvWarning(null)
    setWaitingForBlockId(null)
    setDetectionStatus(detectCredentials === false ? 'done' : 'pending')
  }, [detectCredentials])

  // Flush main's per-(binary,host) CLI read cache (§2.3 invalidation) so an
  // explicit re-detection observes a terminal `gh auth switch`/`glab auth
  // login` immediately instead of after the 5-minute TTL. Fire-and-forget.
  const invalidateMainCache = useCallback(() => {
    void window.api.invoke('vcs:invalidate-cache').catch(() => {})
  }, [])

  // Switch the selected GitLab host and re-detect against it.
  const changeHost = useCallback((nextHost: string) => {
    if (nextHost === selectedHost) return
    userPickedHostRef.current = true
    invalidateMainCache()
    // Persist the explicit pick (any source) so it survives restart (§4).
    void window.api.invoke('gitlab:host-picked', { host: nextHost }).catch(() => {})
    setSelectedHost(nextHost)
    beginRedetect()
    setDetectionNonce((n) => n + 1)
  }, [selectedHost, beginRedetect, invalidateMainCache])

  // HostSelect onChange wrapper: the "Other instance…" row uses a sentinel
  // value intercepted BEFORE changeHost (§4 item 3) — it reveals the
  // instance-URL field (the PAT form carries it), does NOT alter
  // selectedHost, and does NOT run detection; the controlled select snaps
  // back to its prior value on the next render.
  const handleHostSelect = useCallback((value: string) => {
    if (value === OTHER_INSTANCE_SENTINEL) {
      setAuthMethod('pat')
      return
    }
    changeHost(value)
  }, [changeHost])

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
    // §4 item 5: Reload re-enumerates, flushes the CLI token cache, clears
    // the transport-degraded flags (both via vcs:invalidate-cache), resets
    // the key-icon downgrades, and re-runs trust install + detection.
    invalidateMainCache()
    setDowngradedHosts(new Set())
    beginRedetect()
    setHostsReloadNonce((n) => n + 1)
  }, [beginRedetect, invalidateMainCache])

  // The unreachable card's Retry (§7) and the "Check again" control (§5):
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
  // block replacing the provider's single session credential (§4 item 9).
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
    const unsubscribe = window.api.on('vcs:session-changed', (payload) => {
      if (payload.provider !== provider.id) return
      const myHost = authenticatedHostRef.current
      if (myHost && payload.host !== myHost) {
        setSessionStale(true)
      }
    })
    return unsubscribe
  }, [provider])

  // §5 item 7 (recommended): re-run detection automatically on window focus
  // while sitting IDLE in the manual UI — makes the terminal-`gh auth login`
  // flow genuinely zero-click. Debounced. Armed ONLY in 'pending': the OAuth
  // device flow guarantees a focus round-trip ('authenticating' — a redetect
  // would unmount the code panel mid-flow), and a redetect after 'failed'
  // would wipe the failure UI the user is reading.
  const focusRedetectArmed =
    detectCredentials !== false && detectionStatus === 'done' && authStatus === 'pending'
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

  // Manual-UI hint line (§5/§7): a main-supplied contract copy (keyring
  // cases) wins; otherwise the vcs:cli-status-driven default. Suppressed when
  // a warning chip already explains the situation.
  const manualHint = (() => {
    if (detectionHint) return detectionHint
    if (detectionWarning || unreachableInfo) return null
    const providerCliStatus = provider.id === 'github' ? cliStatus?.gh : cliStatus?.glab
    if (!providerCliStatus) return null
    if (provider.id === 'github') {
      return providerCliStatus.installed
        ? "No existing credentials found. Sign in below, set GITHUB_TOKEN, or run 'gh auth login'."
        : "No existing credentials found. Sign in below, set GITHUB_TOKEN, or install the GitHub CLI (gh)."
    }
    return providerCliStatus.installed
      ? "No existing credentials found. Sign in below, set GITLAB_TOKEN, or run 'glab auth login'."
      : "No existing credentials found. Sign in below, set GITLAB_TOKEN, or install the GitLab CLI (glab)."
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
    scopeWarning,
    detectionWarning,
    sessionEnvWarning,
    waitingForBlockId,

    // Tri-state unreachable outcome (§2.0)
    unreachableInfo,
    retryUnreachable,
    oauthUnavailableReason,

    // Manual-UI hint + diagnostics (§5)
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

    // OAuth
    effectiveClientId,
    isCustomClientId,
    oauthUserCode,
    oauthVerificationUri,
    startOAuth,
    cancelOAuth,

    // Actions
    resetAuth,
    resetDetectionState,
    clearRegisteredOutputs,
  }
}
