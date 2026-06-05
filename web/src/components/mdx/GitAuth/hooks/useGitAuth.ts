import { useState, useCallback, useRef, useEffect } from "react"
import { useRunbookContext } from "@/contexts/useRunbook"
import { useSession } from "@/contexts/useSession"
import { normalizeBlockId } from "@/lib/utils"
import type {
  GitAuthMethod,
  GitAuthStatus,
  GitDetectionStatus,
  GitDetectionSource,
  GitUserInfo,
  GitCredentialSource,
  GitCliCredentialsResponse,
  GitTokenType,
} from "../types"
import { isCliAuthFound } from "../types"
import type { ProviderConfig } from "../providers"

// Default GitHub OAuth client ID (Gruntwork's registered app)
// This is a public identifier, not a secret
const DEFAULT_GITHUB_OAUTH_CLIENT_ID = "Ov23liDbtds8EmGws3np"

interface UseGitAuthOptions {
  id: string
  provider: ProviderConfig
  oauthClientId?: string
  oauthScopes?: string[]
  detectCredentials?: false | GitCredentialSource[]
}

export function useGitAuth({
  id,
  provider,
  oauthClientId,
  oauthScopes = ['repo'],
  detectCredentials = ['env', 'cli'],
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
  const detectionAttemptedRef = useRef(false)

  // For block-based detection, track which block we're waiting for
  const [waitingForBlockId, setWaitingForBlockId] = useState<string | null>(null)

  // PAT form state
  const [patToken, setPatToken] = useState('')
  const [showPatToken, setShowPatToken] = useState(false)

  // OAuth state
  const [oauthUserCode, setOauthUserCode] = useState<string | null>(null)
  const [oauthVerificationUri, setOauthVerificationUri] = useState<string | null>(null)
  const oauthPollingCancelledRef = useRef(false)
  const oauthPollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Determine the effective client ID (GitHub OAuth only)
  const effectiveClientId = oauthClientId || DEFAULT_GITHUB_OAUTH_CLIENT_ID
  const isCustomClientId = oauthClientId !== undefined && oauthClientId !== '' && oauthClientId !== DEFAULT_GITHUB_OAUTH_CLIENT_ID

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

  // Helper to check for credentials from block outputs
  const getBlockCredentials = useCallback((blockId: string): { found: boolean; token?: string; error?: string } => {
    const normalizedId = normalizeBlockId(blockId)
    const outputs = blockOutputs[normalizedId]?.values

    if (!outputs) {
      return { found: false, error: `Block "${blockId}" has not been executed yet or has no outputs` }
    }

    const token = outputs[provider.env.tokenVar] ||
      provider.env.altTokenVars.map((v) => outputs[v]).find(Boolean)
    if (!token) {
      const names = [provider.env.tokenVar, ...provider.env.altTokenVars].join(' or ')
      return { found: false, error: `Block "${blockId}" did not output ${names}` }
    }

    return { found: true, token }
  }, [blockOutputs, provider])

  // Register credentials as outputs and set session environment
  // Returns { authenticated: true, sessionEnvSynced: boolean } to indicate partial success
  // Sets sessionEnvWarning if the session env sync fails
  const registerCredentials = useCallback(async (token: string, user: GitUserInfo): Promise<{ authenticated: true; sessionEnvSynced: boolean }> => {
    const outputs: Record<string, string> = {
      [provider.env.tokenVar]: token,
      [provider.env.userVar]: user.login,
    }

    // GIT_PROVIDER is a BLOCK OUTPUT only, so a downstream Git PR/MR block can
    // derive which instance this auth block is for ("github" | "gitlab"). It is
    // intentionally excluded from the session:set-env payload below — it's
    // metadata, not a credential, and nothing shell-side consumes it.
    registerOutputs(id, { ...outputs, GIT_PROVIDER: provider.id })

    // Also set in session environment for blocks that don't reference this block
    try {
      await window.api.invoke('session:set-env', { env: outputs })
      setSessionEnvWarning(null)
      return { authenticated: true, sessionEnvSynced: true }
    } catch (error) {
      const message = 'Credentials saved, but session sync failed. Blocks without an explicit auth reference may not receive credentials.'
      console.warn('Failed to set session environment variables:', error)
      setSessionEnvWarning(message)
      return { authenticated: true, sessionEnvSynced: false }
    }
  }, [id, provider, registerOutputs])

  // Clear this block's registered outputs (used when switching providers so the
  // prior provider's token/user don't linger under this block id).
  const clearRegisteredOutputs = useCallback(() => {
    registerOutputs(id, {})
  }, [id, registerOutputs])

  // Validate a token via the provider's API
  const validateToken = useCallback(async (token: string): Promise<{ valid: boolean; user?: GitUserInfo; scopes?: string[]; tokenType?: GitTokenType; error?: string }> => {
    try {
      const data = await window.api.invoke(provider.channels.validate, { token })
      return {
        valid: data.valid,
        user: data.user as GitUserInfo | undefined,
        scopes: data.scopes,
        tokenType: data.tokenType as GitTokenType | undefined,
        error: data.error
      }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Failed to validate token'
      }
    }
  }, [provider])

  // Try to detect credentials from environment variables
  const tryEnvCredentials = useCallback(async (options?: { prefix?: string }): Promise<{ success: boolean; user?: GitUserInfo; scopes?: string[]; tokenType?: GitTokenType; error?: string; foundButInvalid?: boolean }> => {
    try {
      const data = await window.api.invoke(provider.channels.envCredentials, {
        envVar: '',
        prefix: options?.prefix || '',
        githubAuthId: id,
      })

      if (!data.found) {
        return { success: false, error: data.error }
      }

      if (!data.valid) {
        // Token was found but is invalid
        return { success: false, error: data.error, foundButInvalid: true }
      }

      return { success: true, user: data.user as GitUserInfo | undefined, scopes: data.scopes, tokenType: data.tokenType as GitTokenType | undefined }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to check env credentials' }
    }
  }, [id, provider])

  // Try to detect credentials from the provider's CLI
  const tryCliCredentials = useCallback(async (): Promise<{ success: boolean; user?: GitUserInfo; scopes?: string[]; error?: string; foundButInvalid?: boolean }> => {
    try {
      const data = await window.api.invoke(provider.channels.cliCredentials, {} as Record<string, never>) as unknown as GitCliCredentialsResponse

      if (!isCliAuthFound(data)) {
        // Check if token was found but invalid (error contains "invalid")
        const foundButInvalid = data.error?.toLowerCase().includes('invalid') ||
                                data.error?.toLowerCase().includes('expired')
        return { success: false, error: data.error, foundButInvalid }
      }

      return { success: true, user: data.user, scopes: data.scopes }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to check CLI credentials' }
    }
  }, [provider])

  // Try to detect credentials from block outputs
  const tryBlockCredentials = useCallback(async (blockId: string): Promise<{ success: boolean; user?: GitUserInfo; error?: string }> => {
    const result = getBlockCredentials(blockId)

    if (!result.found || !result.token) {
      return { success: false, error: result.error || 'Could not read token from block' }
    }

    // Validate the token
    const validation = await validateToken(result.token)
    if (!validation.valid || !validation.user) {
      return { success: false, error: validation.error || 'Block token is invalid' }
    }

    // Register credentials
    await registerCredentials(result.token, validation.user)

    return { success: true, user: validation.user }
  }, [getBlockCredentials, validateToken, registerCredentials])

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

    detectionAttemptedRef.current = true

    const runDetection = async () => {
      const warnings: string[] = []

      for (const source of detectCredentials) {
        // Check for 'env' - standard env vars
        if (source === 'env') {
          const result = await tryEnvCredentials()
          if (result.success && result.user) {
            setDetectionSource('env')
            setAuthStatus('authenticated')
            setUserInfo(result.user)
            if (result.tokenType) {
              setDetectedTokenType(result.tokenType)
            }
            if (result.scopes && result.scopes.length > 0) {
              setDetectedScopes(result.scopes)
              if (shouldWarnMissingScope(result.scopes)) {
                setScopeWarning(`Missing "${provider.success.requiredScope}" scope - some operations may fail`)
              }
            }
            setDetectionStatus('done')
            registerOutputs(id, { __AUTHENTICATED: 'true', GIT_PROVIDER: provider.id })
            return
          }
          if (result.foundButInvalid) {
            warnings.push(`${provider.env.tokenVar} is invalid or expired`)
          }
        }
        // Check for { env: { prefix: 'PREFIX_' } } - prefixed env vars
        else if (typeof source === 'object' && 'env' in source) {
          const prefix = (source.env as { prefix?: string })?.prefix
          const result = await tryEnvCredentials({ prefix })
          if (result.success && result.user) {
            setDetectionSource('env')
            setAuthStatus('authenticated')
            setUserInfo(result.user)
            if (result.tokenType) {
              setDetectedTokenType(result.tokenType)
            }
            if (result.scopes && result.scopes.length > 0) {
              setDetectedScopes(result.scopes)
              if (shouldWarnMissingScope(result.scopes)) {
                setScopeWarning(`Missing "${provider.success.requiredScope}" scope - some operations may fail`)
              }
            }
            setDetectionStatus('done')
            registerOutputs(id, { __AUTHENTICATED: 'true', GIT_PROVIDER: provider.id })
            return
          }
          if (result.foundButInvalid) {
            warnings.push(`${prefix}${provider.env.tokenVar} is invalid or expired`)
          }
        }
        // Check for 'cli' - provider CLI
        else if (source === 'cli') {
          const result = await tryCliCredentials()
          if (result.success && result.user) {
            setDetectionSource('cli')
            setAuthStatus('authenticated')
            setUserInfo(result.user)
            setDetectedScopes(result.scopes ?? null)
            if (shouldWarnMissingScope(result.scopes)) {
              setScopeWarning(`Missing "${provider.success.requiredScope}" scope - some operations may fail`)
            }
            setDetectionStatus('done')
            registerOutputs(id, { __AUTHENTICATED: 'true', GIT_PROVIDER: provider.id })
            return
          }
          if (result.foundButInvalid) {
            warnings.push(`${provider.cli.label} token is invalid or expired`)
          }
        }
        // Check for { block: 'id' } - block outputs
        else if ('block' in source) {
          const result = await tryBlockCredentials(source.block)
          if (result.success && result.user) {
            setDetectionSource('block')
            setAuthStatus('authenticated')
            setUserInfo(result.user)
            setDetectionStatus('done')
            registerOutputs(id, { __AUTHENTICATED: 'true', GIT_PROVIDER: provider.id })
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
  }, [detectCredentials, id, provider, sessionReady, shouldWarnMissingScope, tryEnvCredentials, tryCliCredentials, tryBlockCredentials, getBlockCredentials, registerOutputs])

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
      const authResult = await tryBlockCredentials(waitingForBlockId)
      if (authResult.success && authResult.user) {
        setDetectionSource('block')
        setAuthStatus('authenticated')
        setUserInfo(authResult.user)
        setDetectionStatus('done')
        setWaitingForBlockId(null)
        registerOutputs(id, { __AUTHENTICATED: 'true', GIT_PROVIDER: provider.id })
      } else {
        // Block auth failed, continue to manual auth
        setDetectionStatus('done')
        setWaitingForBlockId(null)
      }
    }

    doAuth()
  }, [waitingForBlockId, authStatus, blockOutputs, getBlockCredentials, tryBlockCredentials, id, registerOutputs])

  // Handle PAT submission
  const handlePatSubmit = useCallback(async () => {
    if (!patToken) {
      setErrorMessage('Personal Access Token is required')
      return
    }

    setAuthStatus('authenticating')
    setErrorMessage(null)

    const validation = await validateToken(patToken)

    if (!validation.valid || !validation.user) {
      setAuthStatus('failed')
      setErrorMessage(validation.error || 'Invalid token')
      return
    }

    await registerCredentials(patToken, validation.user)
    setAuthStatus('authenticated')
    setUserInfo(validation.user)

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
  }, [patToken, provider, shouldWarnMissingScope, validateToken, registerCredentials])

  // Poll for OAuth completion
  const pollOAuthCompletion = useCallback(async (deviceCode: string, interval: number = 5) => {
    const maxAttempts = 24 // ~2 minutes with 5s interval
    let attempts = 0
    let currentInterval = Math.max(interval, 5) * 1000 // GitHub requires at least 5 seconds

    const poll = async () => {
      if (oauthPollingCancelledRef.current) return

      try {
        const data = await window.api.invoke('github:oauth-poll', {
          clientId: effectiveClientId,
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
          // Success!
          await registerCredentials(data.accessToken!, data.user as unknown as GitUserInfo)
          if (oauthPollingCancelledRef.current) return
          setAuthStatus('authenticated')
          setUserInfo(data.user as unknown as GitUserInfo)
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
  }, [effectiveClientId, registerCredentials])

  // Start OAuth device flow
  const startOAuth = useCallback(async () => {
    if (!effectiveClientId) {
      setErrorMessage('No OAuth client ID configured')
      return
    }

    setAuthStatus('authenticating')
    setErrorMessage(null)
    oauthPollingCancelledRef.current = false

    try {
      const data = await window.api.invoke('github:oauth-start', {
        clientId: effectiveClientId,
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
    setSessionEnvWarning(null)
    setDetectionWarning(null)
    oauthPollingCancelledRef.current = false
  }, [])

  // Reset detection so it re-runs for a freshly-selected provider. Setting
  // detectionStatus back to 'pending' (when detection is enabled) shows the
  // "Checking…" state instead of flashing the manual form, and clearing
  // detectionAttemptedRef lets the detection effect fire again.
  const resetDetectionState = useCallback(() => {
    detectionAttemptedRef.current = false
    setWaitingForBlockId(null)
    setDetectionStatus(detectCredentials === false ? 'done' : 'pending')
  }, [detectCredentials])

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
    detectionAttemptedRef,

    // PAT form
    patToken,
    setPatToken,
    showPatToken,
    setShowPatToken,
    handlePatSubmit,

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
