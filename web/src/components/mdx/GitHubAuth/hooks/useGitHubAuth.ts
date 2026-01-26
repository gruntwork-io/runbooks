import { useState, useCallback, useRef, useEffect } from "react"
import { useRunbookContext } from "@/contexts/useRunbook"
import { useSession } from "@/contexts/useSession"
import type {
  GitHubAuthMethod,
  GitHubAuthStatus,
  GitHubUser,
  GitHubPrefillStatus,
  DeviceFlowResponse,
} from "../types"

interface UseGitHubAuthOptions {
  id: string
  scopes?: string[]
}

export function useGitHubAuth({
  id,
  scopes = ['repo'],
}: UseGitHubAuthOptions) {
  const { registerOutputs } = useRunbookContext()
  const { getAuthHeader } = useSession()

  // Core auth state
  const [authMethod, setAuthMethod] = useState<GitHubAuthMethod>('token')
  const [authStatus, setAuthStatus] = useState<GitHubAuthStatus>('pending')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [user, setUser] = useState<GitHubUser | null>(null)

  // Prefill state (for GITHUB_TOKEN env var)
  const [prefillStatus, setPrefillStatus] = useState<GitHubPrefillStatus>('pending')
  const [prefillError, setPrefillError] = useState<string | null>(null)
  const prefillAttemptedRef = useRef(false)

  // Token form state
  const [token, setToken] = useState('')
  const [showToken, setShowToken] = useState(false)

  // Device flow state
  const [deviceFlow, setDeviceFlow] = useState<DeviceFlowResponse | null>(null)
  const devicePollingCancelledRef = useRef(false)

  // Register GitHub auth outputs for other blocks to use
  const registerGitHubAuth = useCallback((userInfo: GitHubUser) => {
    const outputs: Record<string, string> = {
      GITHUB_AUTHENTICATED: 'true',
      GITHUB_USERNAME: userInfo.login,
      GITHUB_USER_NAME: userInfo.name || '',
      GITHUB_USER_EMAIL: userInfo.email || '',
    }
    registerOutputs(id, outputs)
  }, [id, registerOutputs])

  // Validate token and get user info
  const validateToken = useCallback(async (tokenValue: string): Promise<{ valid: boolean; user?: GitHubUser; error?: string }> => {
    try {
      const response = await fetch('/api/github/auth/validate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeader(),
        },
        body: JSON.stringify({ token: tokenValue })
      })

      const data = await response.json()

      if (response.ok && data.valid) {
        return {
          valid: true,
          user: {
            login: data.login,
            name: data.name,
            avatarUrl: data.avatarUrl,
            email: data.email,
          }
        }
      } else {
        return { valid: false, error: data.error || 'Invalid token' }
      }
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : 'Failed to validate token' }
    }
  }, [getAuthHeader])

  // Check for env var token on mount
  useEffect(() => {
    if (prefillAttemptedRef.current) return
    prefillAttemptedRef.current = true

    const checkEnvToken = async () => {
      setPrefillStatus('pending')
      
      try {
        const response = await fetch('/api/github/auth/env', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...getAuthHeader(),
          },
          body: JSON.stringify({ githubAuthId: id })
        })

        const data = await response.json()

        if (data.found && data.valid) {
          setPrefillStatus('success')
          setAuthStatus('authenticated')
          setUser({
            login: data.login,
            name: data.name,
            avatarUrl: data.avatarUrl,
            email: data.email,
          })
          // Register marker that auth is complete (actual token is stored server-side)
          registerOutputs(id, { GITHUB_AUTHENTICATED: 'true', GITHUB_USERNAME: data.login })
        } else if (data.found && !data.valid) {
          setPrefillStatus('failed')
          setPrefillError(data.error || 'Environment token is invalid')
        } else {
          // No env token found - show manual auth UI
          setPrefillStatus('not-configured')
        }
      } catch (error) {
        setPrefillStatus('failed')
        setPrefillError(error instanceof Error ? error.message : 'Failed to check for environment token')
      }
    }

    checkEnvToken()
  }, [id, getAuthHeader, registerOutputs])

  // Handle token submission
  const handleTokenSubmit = useCallback(async () => {
    if (!token.trim()) {
      setErrorMessage('Personal access token is required')
      return
    }

    setAuthStatus('authenticating')
    setErrorMessage(null)

    const result = await validateToken(token)

    if (result.valid && result.user) {
      setAuthStatus('authenticated')
      setUser(result.user)
      registerGitHubAuth(result.user)

      // Store token in session
      try {
        await fetch('/api/github/auth/token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...getAuthHeader(),
          },
          body: JSON.stringify({ token, githubAuthId: id })
        })
      } catch (error) {
        console.error('Failed to store token in session:', error)
      }
    } else {
      setAuthStatus('failed')
      setErrorMessage(result.error || 'Invalid token')
    }
  }, [token, validateToken, registerGitHubAuth, getAuthHeader, id])

  // Poll for device flow completion
  const pollDeviceFlow = useCallback(async (deviceCode: string, interval: number) => {
    const maxAttempts = 60

    const poll = async (attempts: number) => {
      if (devicePollingCancelledRef.current) return
      if (attempts >= maxAttempts) {
        setAuthStatus('failed')
        setErrorMessage('Device authorization timed out')
        setDeviceFlow(null)
        return
      }

      try {
        const response = await fetch('/api/github/auth/device/poll', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...getAuthHeader(),
          },
          body: JSON.stringify({
            deviceCode,
            githubAuthId: id,
          })
        })

        if (devicePollingCancelledRef.current) return

        const data = await response.json()

        if (data.status === 'pending') {
          // Continue polling
          setTimeout(() => poll(attempts + 1), interval * 1000)
        } else if (data.status === 'success') {
          setAuthStatus('authenticated')
          setUser({
            login: data.login,
            name: data.name,
            avatarUrl: data.avatarUrl,
            email: data.email,
          })
          registerGitHubAuth({
            login: data.login,
            name: data.name,
            avatarUrl: data.avatarUrl,
            email: data.email,
          })
          setDeviceFlow(null)
        } else {
          setAuthStatus('failed')
          setErrorMessage(data.error || 'Device authorization failed')
          setDeviceFlow(null)
        }
      } catch (error) {
        if (devicePollingCancelledRef.current) return
        setAuthStatus('failed')
        setErrorMessage(error instanceof Error ? error.message : 'Failed to poll device status')
        setDeviceFlow(null)
      }
    }

    poll(0)
  }, [getAuthHeader, id, registerGitHubAuth])

  // Start device flow
  const handleDeviceFlowStart = useCallback(async () => {
    devicePollingCancelledRef.current = false
    setAuthStatus('authenticating')
    setErrorMessage(null)

    try {
      const response = await fetch('/api/github/auth/device/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeader(),
        },
        body: JSON.stringify({ scopes })
      })

      const data = await response.json()

      if (response.ok && data.deviceCode) {
        setDeviceFlow({
          deviceCode: data.deviceCode,
          userCode: data.userCode,
          verificationUri: data.verificationUri,
          expiresIn: data.expiresIn,
          interval: data.interval,
        })
        // Open verification URL in new tab
        window.open(data.verificationUri, '_blank')
        // Start polling
        pollDeviceFlow(data.deviceCode, data.interval)
      } else {
        setAuthStatus('failed')
        setErrorMessage(data.error || 'Failed to start device authorization')
      }
    } catch (error) {
      setAuthStatus('failed')
      setErrorMessage(error instanceof Error ? error.message : 'Failed to start device flow')
    }
  }, [scopes, getAuthHeader, pollDeviceFlow])

  // Cancel device flow
  const handleCancelDeviceFlow = useCallback(() => {
    devicePollingCancelledRef.current = true
    setAuthStatus('pending')
    setDeviceFlow(null)
    setErrorMessage(null)
  }, [])

  // Reset to manual auth
  const handleManualAuth = useCallback(() => {
    setAuthStatus('pending')
    setErrorMessage(null)
    setUser(null)
    setDeviceFlow(null)
    setPrefillStatus('not-configured')
    setPrefillError(null)
  }, [])

  // Retry env token check
  const handleRetryEnvAuth = useCallback(() => {
    prefillAttemptedRef.current = false
    setAuthStatus('pending')
    setErrorMessage(null)
    setPrefillStatus('pending')
    setPrefillError(null)
  }, [])

  return {
    // Core state
    authMethod,
    setAuthMethod,
    authStatus,
    errorMessage,
    user,

    // Prefill state
    prefillStatus,
    prefillError,

    // Token form
    token,
    setToken,
    showToken,
    setShowToken,

    // Device flow
    deviceFlow,

    // Handlers
    handleTokenSubmit,
    handleDeviceFlowStart,
    handleCancelDeviceFlow,
    handleManualAuth,
    handleRetryEnvAuth,
  }
}
