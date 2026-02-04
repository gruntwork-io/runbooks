import { useState, useCallback, useRef, useEffect } from "react"
import { useRunbookContext } from "@/contexts/useRunbook"
import { useSession } from "@/contexts/useSession"
import { normalizeBlockId } from "@/lib/utils"
import type {
  AuthMethod,
  AuthStatus,
  AccountInfo,
  AwsCredentials,
  SSOAccount,
  SSORole,
  ProfileInfo,
  AwsDetectionStatus,
  AwsCredentialSource,
  DetectedAwsCredentials,
} from "../types"

interface UseAwsAuthOptions {
  id: string
  ssoStartUrl?: string
  ssoRegion: string
  ssoAccountId?: string
  ssoRoleName?: string
  defaultRegion: string
  detectCredentials?: false | AwsCredentialSource[]
}

export function useAwsAuth({
  id,
  ssoStartUrl,
  ssoRegion,
  ssoAccountId,
  ssoRoleName,
  defaultRegion,
  detectCredentials = ['env'],  // Default: auto-detect from env vars
}: UseAwsAuthOptions) {
  const { registerOutputs, blockOutputs } = useRunbookContext()
  const { getAuthHeader, isReady: sessionReady } = useSession()

  // Core auth state
  const [authMethod, setAuthMethod] = useState<AuthMethod>('credentials')
  const [authStatus, setAuthStatus] = useState<AuthStatus>('pending')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [warningMessage, setWarningMessage] = useState<string | null>(null)
  const [accountInfo, setAccountInfo] = useState<AccountInfo | null>(null)
  
  // Detection state (new pattern matching GitHubAuth)
  const [detectionStatus, setDetectionStatus] = useState<AwsDetectionStatus>(
    detectCredentials === false ? 'done' : 'pending'
  )
  const [detectedCredentials, setDetectedCredentials] = useState<DetectedAwsCredentials | null>(null)
  const [detectionWarning, setDetectionWarning] = useState<string | null>(null)
  const detectionAttemptedRef = useRef(false)
  // Counter to trigger detection re-run when user clicks "Try auto-detection again"
  const [detectionAttempt, setDetectionAttempt] = useState(0)
  // Track if the last retry found nothing (for showing feedback message)
  const [retryFoundNothing, setRetryFoundNothing] = useState(false)

  // Auto-hide the "no credentials found" message after a few seconds
  useEffect(() => {
    if (!retryFoundNothing) return
    const timer = setTimeout(() => setRetryFoundNothing(false), 3000)
    return () => clearTimeout(timer)
  }, [retryFoundNothing])
  
  // For block-based detection, track which block we're waiting for
  const [waitingForBlockId, setWaitingForBlockId] = useState<string | null>(null)

  // Credentials form state
  const [accessKeyId, setAccessKeyId] = useState('')
  const [secretAccessKey, setSecretAccessKey] = useState('')
  const [sessionToken, setSessionToken] = useState('')
  const [selectedDefaultRegion, setSelectedDefaultRegion] = useState(defaultRegion)
  const [showSecretKey, setShowSecretKey] = useState(false)
  const [showSessionToken, setShowSessionToken] = useState(false)

  // Profile state
  const [profiles, setProfiles] = useState<ProfileInfo[]>([])
  const [selectedProfile, setSelectedProfile] = useState<ProfileInfo | null>(null)
  const [loadingProfiles, setLoadingProfiles] = useState(false)
  const [profileSearch, setProfileSearch] = useState('')

  // SSO account/role selection state
  const [ssoAccessToken, setSsoAccessToken] = useState<string | null>(null)
  const [ssoAccounts, setSsoAccounts] = useState<SSOAccount[]>([])
  const [ssoRoles, setSsoRoles] = useState<SSORole[]>([])
  const [selectedSsoAccount, setSelectedSsoAccount] = useState<SSOAccount | null>(null)
  const [selectedSsoRole, setSelectedSsoRole] = useState<string>('')
  const [loadingRoles, setLoadingRoles] = useState(false)
  const [ssoAccountSearch, setSsoAccountSearch] = useState('')
  const [ssoRoleSearch, setSsoRoleSearch] = useState('')

  // SSO polling cancellation
  const ssoPollingCancelledRef = useRef(false)

  // Helper to check for credentials from block outputs
  const getBlockCredentials = useCallback((blockId: string): { found: boolean; creds?: Partial<AwsCredentials>; error?: string } => {
    const normalizedId = normalizeBlockId(blockId)
    const outputs = blockOutputs[normalizedId]?.values
    
    if (!outputs) {
      return { found: false, error: `Block "${blockId}" has not been executed yet or has no outputs` }
    }
    
    const accessKeyId = outputs.AWS_ACCESS_KEY_ID
    const secretAccessKey = outputs.AWS_SECRET_ACCESS_KEY
    
    if (!accessKeyId || !secretAccessKey) {
      return { found: false, error: `Block "${blockId}" did not output AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY` }
    }
    
    return {
      found: true,
      creds: {
        accessKeyId,
        secretAccessKey,
        sessionToken: outputs.AWS_SESSION_TOKEN,
        region: outputs.AWS_REGION || defaultRegion,
      }
    }
  }, [blockOutputs, defaultRegion])

  // Check if a region is enabled for the AWS account
  const checkRegionStatus = useCallback(async (creds: AwsCredentials) => {
    try {
      const response = await fetch('/api/aws/check-region', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretAccessKey,
          sessionToken: creds.sessionToken,
          region: creds.region,
        })
      })
      const data = await response.json()
      if (data.warning) {
        setWarningMessage(data.warning)
      }
    } catch (error) {
      console.error('Failed to check region status:', error)
    }
  }, [])

  // Register credentials as outputs and set session environment
  const registerCredentials = useCallback(async (creds: AwsCredentials) => {
    const outputs: Record<string, string> = {
      AWS_ACCESS_KEY_ID: creds.accessKeyId,
      AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
      AWS_REGION: creds.region,
      AWS_SESSION_TOKEN: creds.sessionToken || '',
    }
    
    registerOutputs(id, outputs)
    
    // Also set in session environment for blocks that don't specify awsAuthId
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

    await checkRegionStatus(creds)
  }, [id, registerOutputs, getAuthHeader, checkRegionStatus])

  // Try to detect credentials from environment variables
  // Returns metadata only - does NOT register credentials (user must confirm first)
  const tryEnvCredentials = useCallback(async (options?: { prefix?: string }): Promise<{
    success: boolean
    accountId?: string
    accountName?: string
    arn?: string
    region?: string
    hasSessionToken?: boolean
    warning?: string
    error?: string
    foundButInvalid?: boolean
  }> => {
    try {
      // Use GET with query params - this is read-only detection, credentials are NOT
      // registered to session until user confirms via handleConfirmDetected
      const params = new URLSearchParams({
        prefix: options?.prefix || '',
        defaultRegion: defaultRegion || '',
      })
      const response = await fetch(`/api/aws/env-credentials?${params}`, {
        method: 'GET',
        headers: {
          ...getAuthHeader(),
        },
      })

      const data = await response.json()

      if (!data.found) {
        return { success: false, error: data.error }
      }

      if (!data.valid) {
        return { success: false, error: data.error, foundButInvalid: true }
      }

      return {
        success: true,
        accountId: data.accountId,
        accountName: data.accountName,
        arn: data.arn,
        region: data.region,
        hasSessionToken: data.hasSessionToken,
        warning: data.warning,
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to check env credentials' }
    }
  }, [getAuthHeader, defaultRegion])

  // Try to detect credentials from block outputs
  const tryBlockCredentials = useCallback(async (blockId: string): Promise<{
    success: boolean
    accountId?: string
    accountName?: string
    arn?: string
    region?: string
    hasSessionToken?: boolean
    error?: string
  }> => {
    const result = getBlockCredentials(blockId)

    if (!result.found || !result.creds) {
      return { success: false, error: result.error || 'Could not read credentials from block' }
    }

    // Validate the credentials via backend (but don't register them yet)
    try {
      const response = await fetch('/api/aws/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accessKeyId: result.creds.accessKeyId,
          secretAccessKey: result.creds.secretAccessKey,
          sessionToken: result.creds.sessionToken,
          region: result.creds.region || defaultRegion,
        })
      })

      const data = await response.json()

      if (!data.valid) {
        return { success: false, error: data.error || 'Block credentials are invalid' }
      }

      return {
        success: true,
        accountId: data.accountId,
        accountName: data.accountName,
        arn: data.arn,
        region: result.creds.region || defaultRegion,
        hasSessionToken: !!result.creds.sessionToken,
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to validate credentials' }
    }
  }, [getBlockCredentials, defaultRegion])

  // Run credential detection when session is ready
  useEffect(() => {
    // Skip if detection is disabled or already attempted (for this attempt)
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
          if (result.success) {
            setDetectedCredentials({
              accountId: result.accountId!,
              accountName: result.accountName,
              arn: result.arn!,
              region: result.region || defaultRegion,
              source: 'env',
              hasSessionToken: result.hasSessionToken || false,
            })
            if (result.warning) {
              setDetectionWarning(result.warning)
            }
            setDetectionStatus('detected')
            return
          }
          if (result.foundButInvalid) {
            warnings.push('AWS credentials in environment are invalid or expired')
          }
        }
        // Check for { env: { prefix: 'PREFIX_' } } - prefixed env vars
        else if (typeof source === 'object' && 'env' in source && typeof source.env === 'object' && 'prefix' in source.env) {
          const prefix = source.env.prefix
          const result = await tryEnvCredentials({ prefix })
          if (result.success) {
            setDetectedCredentials({
              accountId: result.accountId!,
              accountName: result.accountName,
              arn: result.arn!,
              region: result.region || defaultRegion,
              source: 'env',
              hasSessionToken: result.hasSessionToken || false,
              envPrefix: prefix,
            })
            if (result.warning) {
              setDetectionWarning(result.warning)
            }
            setDetectionStatus('detected')
            return
          }
          if (result.foundButInvalid) {
            warnings.push(`${prefix}AWS credentials are invalid or expired`)
          }
        }
        // Check for { block: 'id' } - block outputs
        else if (typeof source === 'object' && 'block' in source) {
          const result = await tryBlockCredentials(source.block)
          if (result.success) {
            setDetectedCredentials({
              accountId: result.accountId!,
              accountName: result.accountName,
              arn: result.arn!,
              region: result.region || defaultRegion,
              source: 'block',
              hasSessionToken: result.hasSessionToken || false,
            })
            setDetectionStatus('detected')
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
        // Note: 'default-profile' detection was intentionally not implemented.
        // Profile-based auth is available via the Profile tab in manual authentication.
        // Auto-detecting the default profile is complex due to AWS config precedence rules.
      }

      // Set any warnings from invalid credentials we found
      if (warnings.length > 0) {
        setDetectionWarning(warnings.join('; '))
      }

      // Nothing found - show feedback if this was a retry attempt
      if (detectionAttempt > 0) {
        setRetryFoundNothing(true)
      }
      setDetectionStatus('done')
    }

    runDetection()
  // eslint-disable-next-line react-hooks/exhaustive-deps -- detectionAttempt triggers re-run on retry
  }, [detectCredentials, sessionReady, tryEnvCredentials, tryBlockCredentials, getBlockCredentials, defaultRegion, detectionAttempt])

  // Watch for block outputs when waiting for a block
  useEffect(() => {
    if (!waitingForBlockId || detectionStatus === 'detected' || authStatus === 'authenticated') {
      return
    }

    const result = getBlockCredentials(waitingForBlockId)
    if (!result.found) {
      return // Still waiting
    }

    // Block has outputs now, try to detect credentials
    const doDetection = async () => {
      const authResult = await tryBlockCredentials(waitingForBlockId)
      if (authResult.success) {
        setDetectedCredentials({
          accountId: authResult.accountId!,
          accountName: authResult.accountName,
          arn: authResult.arn!,
          region: authResult.region || defaultRegion,
          source: 'block',
          hasSessionToken: authResult.hasSessionToken || false,
        })
        setDetectionStatus('detected')
        setWaitingForBlockId(null)
      } else {
        // Block auth failed, continue to manual auth
        setDetectionStatus('done')
        setWaitingForBlockId(null)
      }
    }

    doDetection()
  }, [waitingForBlockId, detectionStatus, authStatus, blockOutputs, getBlockCredentials, tryBlockCredentials, defaultRegion])

  // User confirms detected credentials - register them to session and authenticate
  const handleConfirmDetected = useCallback(async () => {
    if (!detectedCredentials) return

    setAuthStatus('authenticating')

    // For env-detected credentials, call the confirm endpoint to register them to session
    if (detectedCredentials.source === 'env') {
      try {
        const response = await fetch('/api/aws/env-credentials/confirm', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...getAuthHeader(),
          },
          body: JSON.stringify({
            prefix: detectedCredentials.envPrefix || '',
            defaultRegion: defaultRegion || '',
          })
        })

        const data = await response.json()

        if (!data.valid) {
          setAuthStatus('failed')
          setErrorMessage(data.error || 'Failed to register credentials')
          return
        }

        setAuthStatus('authenticated')
        setAccountInfo({
          accountId: detectedCredentials.accountId,
          accountName: detectedCredentials.accountName,
          arn: detectedCredentials.arn,
        })
        
        // Register credentials per-block for awsAuthId support
        // The confirm endpoint now returns credentials so we can store them
        if (data.accessKeyId && data.secretAccessKey) {
          const outputs: Record<string, string> = {
            AWS_ACCESS_KEY_ID: data.accessKeyId,
            AWS_SECRET_ACCESS_KEY: data.secretAccessKey,
            AWS_REGION: data.region || defaultRegion,
            AWS_SESSION_TOKEN: data.sessionToken || '',
          }
          registerOutputs(id, outputs)
        } else {
          // Fallback: register marker if credentials weren't returned (shouldn't happen)
          registerOutputs(id, { __AUTHENTICATED: 'true' })
        }
        
        if (detectionWarning) {
          setWarningMessage(detectionWarning)
        }
        setDetectionStatus('done')
        return
      } catch (error) {
        setAuthStatus('failed')
        setErrorMessage(error instanceof Error ? error.message : 'Failed to register credentials')
        return
      }
    }

    // For block-detected credentials, we need to register them
    if (detectedCredentials.source === 'block') {
      // Find the block source in detectCredentials
      const blockSource = Array.isArray(detectCredentials) 
        ? detectCredentials.find(s => typeof s === 'object' && 'block' in s) as { block: string } | undefined
        : undefined
      
      if (blockSource) {
        const blockResult = getBlockCredentials(blockSource.block)
        if (blockResult.found && blockResult.creds) {
          const creds: AwsCredentials = {
            accessKeyId: blockResult.creds.accessKeyId!,
            secretAccessKey: blockResult.creds.secretAccessKey!,
            sessionToken: blockResult.creds.sessionToken,
            region: blockResult.creds.region || defaultRegion,
          }
          await registerCredentials(creds)
          setAuthStatus('authenticated')
          setAccountInfo({
            accountId: detectedCredentials.accountId,
            accountName: detectedCredentials.accountName,
            arn: detectedCredentials.arn,
          })
          setDetectionStatus('done')
          return
        }
      }
    }

    // Fallback - shouldn't reach here normally
    setAuthStatus('failed')
    setErrorMessage('Failed to confirm detected credentials')
  }, [detectedCredentials, detectionWarning, detectCredentials, getBlockCredentials, defaultRegion, registerCredentials, registerOutputs, id, getAuthHeader])

  // User rejects detected credentials - show manual auth
  // Note: credentials are not in session until confirmed, so no need to clear them
  const handleRejectDetected = useCallback(() => {
    // Reset to manual auth state
    setDetectedCredentials(null)
    setDetectionWarning(null)
    setDetectionStatus('done')
    setAuthStatus('pending')
  }, [])

  // Retry credential detection (after user rejected and wants to go back)
  const handleRetryDetection = useCallback(() => {
    // Reset detection state so the effect will re-run
    setDetectedCredentials(null)
    setDetectionWarning(null)
    setDetectionStatus('pending')
    setAuthStatus('pending')
    setErrorMessage(null)
    setWarningMessage(null)
    setRetryFoundNothing(false)
    // Reset the ref so detection effect will run again
    detectionAttemptedRef.current = false
    // Increment the attempt counter to trigger the effect to re-run
    setDetectionAttempt(prev => prev + 1)
  }, [])

  // Load AWS profiles from local machine
  const loadAwsProfiles = useCallback(async () => {
    setLoadingProfiles(true)
    try {
      const response = await fetch('/api/aws/profiles')
      if (response.ok) {
        const data = await response.json()
        const profileList: ProfileInfo[] = data.profiles || []
        setProfiles(profileList)
        const firstUsable = profileList.find(p => p.authType === 'static' || p.authType === 'assume_role')
        if (firstUsable) {
          setSelectedProfile(firstUsable)
        }
      } else {
        setProfiles([])
      }
    } catch (error) {
      console.error('Failed to load AWS profiles:', error)
      setProfiles([])
    } finally {
      setLoadingProfiles(false)
    }
  }, [])

  // Validate credentials by calling STS GetCallerIdentity
  const validateCredentials = useCallback(async (creds: AwsCredentials) => {
    setAuthStatus('authenticating')
    setErrorMessage(null)
    setWarningMessage(null)

    try {
      const response = await fetch('/api/aws/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(creds)
      })

      const data = await response.json()
      
      if (response.ok && data.valid) {
        setAuthStatus('authenticated')
        setAccountInfo({ accountId: data.accountId, accountName: data.accountName, arn: data.arn })
        registerCredentials(creds)
      } else {
        setAuthStatus('failed')
        setErrorMessage(data.error || 'Failed to validate credentials')
      }
    } catch (error) {
      setAuthStatus('failed')
      setErrorMessage(error instanceof Error ? error.message : 'Failed to connect to server')
    }
  }, [registerCredentials])

  // Handle static credentials submission
  const handleCredentialsSubmit = useCallback(() => {
    if (!accessKeyId || !secretAccessKey) {
      setErrorMessage('Access Key ID and Secret Access Key are required')
      return
    }
    validateCredentials({
      accessKeyId,
      secretAccessKey,
      sessionToken: sessionToken || undefined,
      region: selectedDefaultRegion
    })
  }, [accessKeyId, secretAccessKey, sessionToken, selectedDefaultRegion, validateCredentials])

  // Poll for SSO authentication completion
  const pollSsoCompletion = useCallback(async (deviceCode: string, clientId: string, clientSecret: string) => {
    const maxAttempts = 60
    let attempts = 0

    const poll = async () => {
      if (ssoPollingCancelledRef.current) return

      const authHeader = getAuthHeader()
      if (!authHeader.Authorization) {
        setAuthStatus('failed')
        setErrorMessage('Session not ready. Please wait a moment and try again.')
        return
      }

      try {
        const response = await fetch('/api/aws/sso/poll', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeader,
          },
          body: JSON.stringify({ 
            deviceCode, 
            clientId, 
            clientSecret,
            region: ssoRegion,
            accountId: ssoAccountId,
            roleName: ssoRoleName,
          })
        })

        if (ssoPollingCancelledRef.current) return

        const data = await response.json()

        if (data.status === 'pending' && attempts < maxAttempts) {
          attempts++
          setTimeout(poll, 2000)
        } else if (data.status === 'select_account') {
          setSsoAccessToken(data.accessToken)
          setSsoAccounts(data.accounts || [])
          setAuthStatus('select_account')
        } else if (data.status === 'success') {
          setAuthStatus('authenticated')
          setAccountInfo({ accountId: data.accountId, accountName: data.accountName, arn: data.arn })
          registerCredentials({
            accessKeyId: data.accessKeyId,
            secretAccessKey: data.secretAccessKey,
            sessionToken: data.sessionToken,
            region: selectedDefaultRegion
          })
        } else {
          setAuthStatus('failed')
          setErrorMessage(data.error || 'SSO authentication timed out or failed')
        }
      } catch (error) {
        if (ssoPollingCancelledRef.current) return
        setAuthStatus('failed')
        setErrorMessage(error instanceof Error ? error.message : 'Failed to poll SSO status')
      }
    }

    poll()
  }, [ssoRegion, ssoAccountId, ssoRoleName, selectedDefaultRegion, registerCredentials, getAuthHeader])

  // Handle SSO authentication
  const handleSsoAuth = useCallback(async () => {
    if (!ssoStartUrl) {
      setErrorMessage('SSO Start URL is required for SSO authentication')
      return
    }

    ssoPollingCancelledRef.current = false
    setAuthStatus('authenticating')
    setErrorMessage(null)

    try {
      const response = await fetch('/api/aws/sso/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startUrl: ssoStartUrl,
          region: ssoRegion,
          accountId: ssoAccountId,
          roleName: ssoRoleName,
        })
      })

      const data = await response.json()
      
      if (response.ok && data.verificationUri) {
        window.open(data.verificationUri, '_blank')
        pollSsoCompletion(data.deviceCode, data.clientId, data.clientSecret)
      } else {
        setAuthStatus('failed')
        setErrorMessage(data.error || 'Failed to start SSO authentication')
      }
    } catch (error) {
      setAuthStatus('failed')
      setErrorMessage(error instanceof Error ? error.message : 'Failed to connect to server')
    }
  }, [ssoStartUrl, ssoRegion, ssoAccountId, ssoRoleName, pollSsoCompletion])

  // Handle SSO account selection - load roles for selected account
  const handleSsoAccountSelect = useCallback(async (account: SSOAccount) => {
    setSelectedSsoAccount(account)
    setLoadingRoles(true)
    setSelectedSsoRole('')
    setSsoRoles([])

    try {
      const response = await fetch('/api/aws/sso/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accessToken: ssoAccessToken,
          accountId: account.accountId,
          region: ssoRegion,
        })
      })

      const data = await response.json()

      if (data.roles && data.roles.length > 0) {
        setSsoRoles(data.roles)
        if (data.roles.length === 1) {
          setSelectedSsoRole(data.roles[0].roleName)
        }
        setAuthStatus('select_role')
      } else {
        setErrorMessage(data.error || 'No roles available for this account')
        setAuthStatus('failed')
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to load roles')
      setAuthStatus('failed')
    } finally {
      setLoadingRoles(false)
    }
  }, [ssoAccessToken, ssoRegion])

  // Complete SSO authentication with selected account and role
  const handleSsoComplete = useCallback(async () => {
    if (!selectedSsoAccount || !selectedSsoRole || !ssoAccessToken) {
      setErrorMessage('Please select an account and role')
      return
    }

    const authHeader = getAuthHeader()
    if (!authHeader.Authorization) {
      setErrorMessage('Session not ready. Please wait a moment and try again.')
      return
    }

    setAuthStatus('authenticating')

    try {
      const response = await fetch('/api/aws/sso/complete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeader,
        },
        body: JSON.stringify({
          accessToken: ssoAccessToken,
          accountId: selectedSsoAccount.accountId,
          roleName: selectedSsoRole,
          region: ssoRegion,
        })
      })

      const data = await response.json()

      if (data.accessKeyId) {
        setAuthStatus('authenticated')
        setAccountInfo({ accountId: data.accountId, accountName: data.accountName, arn: data.arn })
        registerCredentials({
          accessKeyId: data.accessKeyId,
          secretAccessKey: data.secretAccessKey,
          sessionToken: data.sessionToken,
          region: selectedDefaultRegion
        })
      } else {
        setAuthStatus('failed')
        setErrorMessage(data.error || 'Failed to complete SSO authentication')
      }
    } catch (error) {
      setAuthStatus('failed')
      setErrorMessage(error instanceof Error ? error.message : 'Failed to complete SSO')
    }
  }, [selectedSsoAccount, selectedSsoRole, ssoAccessToken, ssoRegion, selectedDefaultRegion, registerCredentials, getAuthHeader])

  // Go back to account selection
  const handleBackToAccountSelection = useCallback(() => {
    setSelectedSsoAccount(null)
    setSelectedSsoRole('')
    setSsoRoles([])
    setSsoRoleSearch('')
    setAuthStatus('select_account')
  }, [])

  // Handle profile authentication
  const handleProfileAuth = useCallback(async () => {
    if (!selectedProfile) {
      setErrorMessage('Please select a profile')
      return
    }

    if (selectedProfile.authType === 'unsupported') {
      setErrorMessage('This authentication method is not supported')
      return
    }

    const authHeader = getAuthHeader()
    if (!authHeader.Authorization) {
      setErrorMessage('Session not ready. Please wait a moment and try again.')
      return
    }

    setAuthStatus('authenticating')
    setErrorMessage(null)

    try {
      const response = await fetch('/api/aws/profile', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeader,
        },
        body: JSON.stringify({ profile: selectedProfile.name })
      })

      const data = await response.json()
      
      if (response.ok && data.valid) {
        setAuthStatus('authenticated')
        setAccountInfo({ accountId: data.accountId, accountName: data.accountName, arn: data.arn })
        registerCredentials({
          accessKeyId: data.accessKeyId,
          secretAccessKey: data.secretAccessKey,
          sessionToken: data.sessionToken,
          region: selectedDefaultRegion
        })
      } else {
        setAuthStatus('failed')
        setErrorMessage(data.error || 'Failed to authenticate with profile')
      }
    } catch (error) {
      setAuthStatus('failed')
      setErrorMessage(error instanceof Error ? error.message : 'Failed to connect to server')
    }
  }, [selectedProfile, selectedDefaultRegion, registerCredentials, getAuthHeader])

  // Reset to manual authentication (show auth tabs)
  const handleManualAuth = useCallback(() => {
    setAuthStatus('pending')
    setErrorMessage(null)
    setWarningMessage(null)
    setAccountInfo(null)
    setSsoAccessToken(null)
    setSsoAccounts([])
    setSsoRoles([])
    setSelectedSsoAccount(null)
    setSelectedSsoRole('')
    setSsoAccountSearch('')
    setSsoRoleSearch('')
    setDetectedCredentials(null)
    setDetectionWarning(null)
    setDetectionStatus('done')
  }, [])

  // Cancel SSO authentication
  const handleCancelSsoAuth = useCallback(() => {
    ssoPollingCancelledRef.current = true
    setAuthStatus('pending')
    setErrorMessage(null)
  }, [])

  return {
    // Core state
    authMethod,
    setAuthMethod,
    authStatus,
    errorMessage,
    warningMessage,
    accountInfo,

    // Detection state (new pattern)
    detectionStatus,
    detectedCredentials,
    detectionWarning,
    waitingForBlockId,
    retryFoundNothing,
    clearRetryMessage: () => setRetryFoundNothing(false),

    // Credentials form
    accessKeyId,
    setAccessKeyId,
    secretAccessKey,
    setSecretAccessKey,
    sessionToken,
    setSessionToken,
    selectedDefaultRegion,
    setSelectedDefaultRegion,
    showSecretKey,
    setShowSecretKey,
    showSessionToken,
    setShowSessionToken,

    // Profile state
    profiles,
    selectedProfile,
    setSelectedProfile,
    loadingProfiles,
    profileSearch,
    setProfileSearch,
    loadAwsProfiles,

    // SSO state
    ssoAccounts,
    ssoRoles,
    selectedSsoAccount,
    selectedSsoRole,
    setSelectedSsoRole,
    loadingRoles,
    ssoAccountSearch,
    setSsoAccountSearch,
    ssoRoleSearch,
    setSsoRoleSearch,

    // Handlers
    handleCredentialsSubmit,
    handleSsoAuth,
    handleSsoAccountSelect,
    handleSsoComplete,
    handleBackToAccountSelection,
    handleProfileAuth,
    
    // Detection handlers (new)
    handleConfirmDetected,
    handleRejectDetected,
    handleRetryDetection,
    handleManualAuth,
    handleCancelSsoAuth,
  }
}
