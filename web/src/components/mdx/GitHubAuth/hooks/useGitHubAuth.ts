import { useState, useCallback, useRef, useEffect } from "react"
import { useRunbookContext } from "@/contexts/useRunbook"
import { useSession } from "@/contexts/useSession"
import { normalizeBlockId } from "@/lib/utils"
import type {
  GitHubAuthMethod,
  GitHubAuthStatus,
  GitHubPrefillStatus,
  GitHubUserInfo,
  PrefilledGitHubCredentials,
} from "../types"

// Default GitHub OAuth client ID (Gruntwork's registered app)
// This is a public identifier, not a secret
const DEFAULT_GITHUB_OAUTH_CLIENT_ID = "Ov23liDbtds8EmGws3np"

interface UseGitHubAuthOptions {
  id: string
  oauthClientId?: string
  oauthScopes?: string[]
  prefilledCredentials?: PrefilledGitHubCredentials
  allowOverridePrefilled?: boolean
}

export function useGitHubAuth({
  id,
  oauthClientId,
  oauthScopes = ['repo'],
  prefilledCredentials,
}: UseGitHubAuthOptions) {
  const { registerOutputs, blockOutputs } = useRunbookContext()
  const { getAuthHeader } = useSession()

  // Core auth state
  const [authMethod, setAuthMethod] = useState<GitHubAuthMethod>('oauth')
  const [authStatus, setAuthStatus] = useState<GitHubAuthStatus>('pending')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [userInfo, setUserInfo] = useState<GitHubUserInfo | null>(null)

  // Prefill state
  const [prefillStatus, setPrefillStatus] = useState<GitHubPrefillStatus>(
    prefilledCredentials ? 'pending' : 'not-configured'
  )
  const [prefillError, setPrefillError] = useState<string | null>(null)
  const [prefillSource, setPrefillSource] = useState<'env' | 'outputs' | 'static' | null>(null)
  const prefillAttemptedRef = useRef(false)
  const [prefillRetryCount, setPrefillRetryCount] = useState(0)
  const [waitingForBlockId, setWaitingForBlockId] = useState<string | null>(
    prefilledCredentials?.type === 'outputs' ? prefilledCredentials.blockId : null
  )

  // PAT form state
  const [patToken, setPatToken] = useState('')
  const [showPatToken, setShowPatToken] = useState(false)

  // OAuth state
  const [oauthUserCode, setOauthUserCode] = useState<string | null>(null)
  const [oauthVerificationUri, setOauthVerificationUri] = useState<string | null>(null)
  const oauthPollingCancelledRef = useRef(false)

  // Determine the effective client ID
  const effectiveClientId = oauthClientId || DEFAULT_GITHUB_OAUTH_CLIENT_ID
  const isCustomClientId = oauthClientId !== undefined && oauthClientId !== '' && oauthClientId !== DEFAULT_GITHUB_OAUTH_CLIENT_ID

  // Helper to check for credentials from block outputs
  const getBlockCredentials = useCallback((blockId: string): { found: boolean; token?: string; error?: string } => {
    const normalizedId = normalizeBlockId(blockId)
    const outputs = blockOutputs[normalizedId]?.values

    if (!outputs) {
      return { found: false, error: `Block "${blockId}" has not been executed yet or has no outputs` }
    }

    const token = outputs.GITHUB_TOKEN || outputs.GH_TOKEN
    if (!token) {
      return { found: false, error: `Block "${blockId}" did not output GITHUB_TOKEN or GH_TOKEN` }
    }

    return { found: true, token }
  }, [blockOutputs])

  // Register credentials as outputs and set session environment
  const registerCredentials = useCallback(async (token: string, user: GitHubUserInfo) => {
    const outputs: Record<string, string> = {
      GITHUB_TOKEN: token,
      GITHUB_USER: user.login,
    }

    registerOutputs(id, outputs)

    // Also set in session environment for blocks that don't specify githubAuthId
    try {
      await fetch('/api/session/env', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeader(),
        },
        body: JSON.stringify({ env: outputs }),
      })
    } catch (error) {
      console.error('Failed to set session environment variables:', error)
    }
  }, [id, registerOutputs, getAuthHeader])

  // Validate a token via the GitHub API
  const validateToken = useCallback(async (token: string): Promise<{ valid: boolean; user?: GitHubUserInfo; error?: string }> => {
    try {
      const response = await fetch('/api/github/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      })

      const data = await response.json()
      return {
        valid: data.valid,
        user: data.user,
        error: data.error
      }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Failed to validate token'
      }
    }
  }, [])

  // Attempt to prefill credentials from block outputs
  const attemptBlockPrefill = useCallback(async (blockId: string) => {
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

  // Handle prefilled credentials on mount (for env and static types)
  useEffect(() => {
    // Skip if not configured or if it's outputs type (handled separately)
    if (!prefilledCredentials || prefilledCredentials.type === 'outputs') {
      return
    }

    // Only attempt prefill once per retry cycle
    if (prefillAttemptedRef.current) {
      return
    }

    prefillAttemptedRef.current = true

    const attemptPrefill = async () => {
      setPrefillStatus('pending')
      setPrefillError(null)

      try {
        if (prefilledCredentials.type === 'env') {
          // Call backend to read and validate credentials from environment
          const response = await fetch('/api/github/env-credentials', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...getAuthHeader(),
            },
            body: JSON.stringify({
              prefix: prefilledCredentials.prefix || '',
              envVar: prefilledCredentials.envVar || '',
              githubAuthId: id,
            })
          })

          const data = await response.json()

          if (!data.found) {
            setPrefillStatus('failed')
            setPrefillError(data.error || 'No GitHub token found in environment')
            return
          }

          if (!data.valid) {
            setPrefillStatus('failed')
            setPrefillError(data.error || 'Environment token is invalid')
            return
          }

          // Credentials validated and registered on the server side
          setPrefillStatus('success')
          setPrefillSource('env')
          setAuthStatus('authenticated')
          setUserInfo(data.user)

          // Register marker for dependency checking
          registerOutputs(id, { __AUTHENTICATED: 'true' })
        } else if (prefilledCredentials.type === 'static') {
          if (!prefilledCredentials.token) {
            setPrefillStatus('failed')
            setPrefillError('Static credentials missing token')
            return
          }

          // Validate the token
          const validation = await validateToken(prefilledCredentials.token)

          if (!validation.valid || !validation.user) {
            setPrefillStatus('failed')
            setPrefillError(validation.error || 'Static token is invalid')
            return
          }

          // Register credentials
          await registerCredentials(prefilledCredentials.token, validation.user)

          setPrefillStatus('success')
          setPrefillSource('static')
          setAuthStatus('authenticated')
          setUserInfo(validation.user)
        }
      } catch (error) {
        setPrefillStatus('failed')
        setPrefillError(error instanceof Error ? error.message : 'Failed to prefill credentials')
      }
    }

    attemptPrefill()
  }, [prefilledCredentials, id, getAuthHeader, registerCredentials, validateToken, prefillRetryCount, registerOutputs])

  // Handle outputs-based credential prefill - watches for block outputs
  useEffect(() => {
    if (prefilledCredentials?.type !== 'outputs') {
      return
    }

    if (authStatus === 'authenticated') {
      return
    }

    if (prefillStatus === 'not-configured' || prefillStatus === 'failed') {
      return
    }

    const result = getBlockCredentials(prefilledCredentials.blockId)

    if (!result.found) {
      setWaitingForBlockId(prefilledCredentials.blockId)
      if (prefillStatus !== 'pending') {
        setPrefillStatus('pending')
        setPrefillError(null)
      }
      return
    }

    setWaitingForBlockId(null)

    const doAuth = async () => {
      setPrefillStatus('pending')
      setPrefillError(null)

      try {
        const authResult = await attemptBlockPrefill(prefilledCredentials.blockId)

        if (authResult.success && authResult.user) {
          setPrefillStatus('success')
          setPrefillSource('outputs')
          setAuthStatus('authenticated')
          setUserInfo(authResult.user)
        } else {
          setPrefillStatus('failed')
          setPrefillError(authResult.error || 'Failed to authenticate with block credentials')
        }
      } catch (error) {
        setPrefillStatus('failed')
        setPrefillError(error instanceof Error ? error.message : 'Failed to prefill credentials')
      }
    }

    doAuth()
  }, [prefilledCredentials, authStatus, blockOutputs, getBlockCredentials, attemptBlockPrefill, prefillStatus])

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
  }, [patToken, validateToken, registerCredentials])

  // Poll for OAuth completion
  const pollOAuthCompletion = useCallback(async (deviceCode: string, interval: number = 5) => {
    const maxAttempts = 24 // ~2 minutes with 5s interval
    let attempts = 0
    let currentInterval = Math.max(interval, 5) * 1000 // GitHub requires at least 5 seconds

    const poll = async () => {
      if (oauthPollingCancelledRef.current) return

      const authHeader = getAuthHeader()
      if (!authHeader.Authorization) {
        setAuthStatus('failed')
        setErrorMessage('Session not ready. Please wait a moment and try again.')
        return
      }

      try {
        const response = await fetch('/api/github/oauth/poll', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeader,
          },
          body: JSON.stringify({
            clientId: effectiveClientId,
            deviceCode,
          })
        })

        if (oauthPollingCancelledRef.current) return

        const data = await response.json()

        if (data.status === 'pending' && attempts < maxAttempts) {
          attempts++
          // If we got slow_down, increase interval by 5 seconds
          if (data.slowDown) {
            currentInterval += 5000
          }
          setTimeout(poll, currentInterval)
        } else if (data.status === 'complete') {
          // Success!
          await registerCredentials(data.accessToken, data.user)
          setAuthStatus('authenticated')
          setUserInfo(data.user)
        } else if (data.status === 'expired') {
          setAuthStatus('failed')
          setErrorMessage('Authorization request expired. Please try again.')
        } else {
          // Error or max attempts reached
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
  }, [effectiveClientId, getAuthHeader, registerCredentials])

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
      const response = await fetch('/api/github/oauth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: effectiveClientId,
          scopes: oauthScopes,
        })
      })

      const data = await response.json()

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
    setAuthStatus('pending')
    setOauthUserCode(null)
    setOauthVerificationUri(null)
  }, [])

  // Reset to allow re-authentication
  const resetAuth = useCallback(() => {
    setAuthStatus('pending')
    setErrorMessage(null)
    setUserInfo(null)
    setPatToken('')
    setOauthUserCode(null)
    setOauthVerificationUri(null)
    oauthPollingCancelledRef.current = false
  }, [])

  // Retry prefill
  const retryPrefill = useCallback(() => {
    prefillAttemptedRef.current = false
    setPrefillStatus('pending')
    setPrefillError(null)
    setPrefillRetryCount(c => c + 1)
  }, [])

  // Switch to manual authentication (bypass prefill)
  const switchToManualAuth = useCallback(() => {
    setPrefillStatus('not-configured')
    setPrefillError(null)
    setWaitingForBlockId(null)
  }, [])

  return {
    // Auth state
    authMethod,
    setAuthMethod,
    authStatus,
    errorMessage,
    userInfo,
    
    // Prefill state
    prefillStatus,
    prefillError,
    prefillSource,
    waitingForBlockId,
    
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
    retryPrefill,
    switchToManualAuth,
  }
}
