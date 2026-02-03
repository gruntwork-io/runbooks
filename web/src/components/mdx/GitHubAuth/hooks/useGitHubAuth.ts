import { useState, useCallback, useRef, useEffect } from "react"
import { useRunbookContext } from "@/contexts/useRunbook"
import { useSession } from "@/contexts/useSession"
import { normalizeBlockId } from "@/lib/utils"
import type {
  GitHubAuthMethod,
  GitHubAuthStatus,
  GitHubDetectionStatus,
  GitHubDetectionSource,
  GitHubUserInfo,
  GitHubCredentialSource,
  GitHubCliCredentialsResponse,
  GitHubTokenType,
} from "../types"
import { isCliAuthFound, hasRepoScope } from "../types"

// Default GitHub OAuth client ID (Gruntwork's registered app)
// This is a public identifier, not a secret
const DEFAULT_GITHUB_OAUTH_CLIENT_ID = "Ov23liDbtds8EmGws3np"

interface UseGitHubAuthOptions {
  id: string
  oauthClientId?: string
  oauthScopes?: string[]
  detectCredentials?: false | GitHubCredentialSource[]
}

export function useGitHubAuth({
  id,
  oauthClientId,
  oauthScopes = ['repo'],
  detectCredentials = ['env', 'cli'],
}: UseGitHubAuthOptions) {
  const { registerOutputs, blockOutputs } = useRunbookContext()
  const { getAuthHeader, isReady: sessionReady } = useSession()

  // Core auth state
  const [authMethod, setAuthMethod] = useState<GitHubAuthMethod>('oauth')
  const [authStatus, setAuthStatus] = useState<GitHubAuthStatus>('pending')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [userInfo, setUserInfo] = useState<GitHubUserInfo | null>(null)

  // Detection state
  const [detectionStatus, setDetectionStatus] = useState<GitHubDetectionStatus>(
    detectCredentials === false ? 'done' : 'pending'
  )
  const [detectionSource, setDetectionSource] = useState<GitHubDetectionSource>(null)
  const [detectedScopes, setDetectedScopes] = useState<string[] | null>(null)
  const [detectedTokenType, setDetectedTokenType] = useState<GitHubTokenType | null>(null)
  const [scopeWarning, setScopeWarning] = useState<string | null>(null)
  const [detectionWarning, setDetectionWarning] = useState<string | null>(null)
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
  const validateToken = useCallback(async (token: string): Promise<{ valid: boolean; user?: GitHubUserInfo; scopes?: string[]; tokenType?: GitHubTokenType; error?: string }> => {
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
        scopes: data.scopes,
        tokenType: data.tokenType,
        error: data.error
      }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Failed to validate token'
      }
    }
  }, [])

  // Try to detect credentials from environment variables
  const tryEnvCredentials = useCallback(async (options?: { prefix?: string }): Promise<{ success: boolean; user?: GitHubUserInfo; scopes?: string[]; tokenType?: GitHubTokenType; error?: string; foundButInvalid?: boolean }> => {
    try {
      const response = await fetch('/api/github/env-credentials', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeader(),
        },
        body: JSON.stringify({
          envVar: '',
          prefix: options?.prefix || '',
          githubAuthId: id,
        })
      })

      const data = await response.json()

      if (!data.found) {
        return { success: false, error: data.error }
      }

      if (!data.valid) {
        // Token was found but is invalid
        return { success: false, error: data.error, foundButInvalid: true }
      }

      return { success: true, user: data.user, scopes: data.scopes, tokenType: data.tokenType }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to check env credentials' }
    }
  }, [getAuthHeader, id])

  // Try to detect credentials from GitHub CLI
  const tryCliCredentials = useCallback(async (): Promise<{ success: boolean; user?: GitHubUserInfo; scopes?: string[]; error?: string; foundButInvalid?: boolean }> => {
    try {
      const response = await fetch('/api/github/cli-credentials', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeader(),
        },
      })

      const data: GitHubCliCredentialsResponse = await response.json()

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
  }, [getAuthHeader])

  // Try to detect credentials from block outputs
  const tryBlockCredentials = useCallback(async (blockId: string): Promise<{ success: boolean; user?: GitHubUserInfo; error?: string }> => {
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
              if (!result.scopes.includes('repo')) {
                setScopeWarning('Missing "repo" scope - some operations may fail')
              }
            }
            setDetectionStatus('done')
            registerOutputs(id, { __AUTHENTICATED: 'true' })
            return
          }
          if (result.foundButInvalid) {
            warnings.push('GITHUB_TOKEN is invalid or expired')
          }
        }
        // Check for { env: { prefix: 'PREFIX_' } } - prefixed env vars
        else if (typeof source === 'object' && 'env' in source && typeof source.env === 'object' && 'prefix' in source.env) {
          const prefix = source.env.prefix
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
              if (!result.scopes.includes('repo')) {
                setScopeWarning('Missing "repo" scope - some operations may fail')
              }
            }
            setDetectionStatus('done')
            registerOutputs(id, { __AUTHENTICATED: 'true' })
            return
          }
          if (result.foundButInvalid) {
            warnings.push(`${prefix}GITHUB_TOKEN is invalid or expired`)
          }
        }
        // Check for 'cli' - GitHub CLI
        else if (source === 'cli') {
          const result = await tryCliCredentials()
          if (result.success && result.user) {
            setDetectionSource('cli')
            setAuthStatus('authenticated')
            setUserInfo(result.user)
            setDetectedScopes(result.scopes ?? null)
            if (!hasRepoScope({ user: result.user, scopes: result.scopes })) {
              setScopeWarning('Missing "repo" scope - some operations may fail')
            }
            setDetectionStatus('done')
            registerOutputs(id, { __AUTHENTICATED: 'true' })
            return
          }
          if (result.foundButInvalid) {
            warnings.push('GitHub CLI token is invalid or expired')
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
            registerOutputs(id, { __AUTHENTICATED: 'true' })
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
  }, [detectCredentials, id, sessionReady, tryEnvCredentials, tryCliCredentials, tryBlockCredentials, getBlockCredentials, registerOutputs])

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
        registerOutputs(id, { __AUTHENTICATED: 'true' })
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
    
    // Set scopes if available (classic PATs return scopes from X-OAuth-Scopes header)
    // Fine-grained PATs don't return scopes via the header
    if (validation.scopes && validation.scopes.length > 0) {
      setDetectedScopes(validation.scopes)
      if (!validation.scopes.includes('repo')) {
        setScopeWarning('Missing "repo" scope - some operations may fail')
      }
    }
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
    setDetectionSource(null)
    setDetectedScopes(null)
    setDetectedTokenType(null)
    setScopeWarning(null)
    oauthPollingCancelledRef.current = false
  }, [])

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
  }
}
