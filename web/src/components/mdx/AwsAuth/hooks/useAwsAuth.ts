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
  PrefillStatus,
  PrefilledCredentials,
  PrefilledCredentialsType,
} from "../types"

interface UseAwsAuthOptions {
  id: string
  ssoStartUrl?: string
  ssoRegion: string
  ssoAccountId?: string
  ssoRoleName?: string
  defaultRegion: string
  prefilledCredentials?: PrefilledCredentials
  allowOverridePrefilled?: boolean
}

export function useAwsAuth({
  id,
  ssoStartUrl,
  ssoRegion,
  ssoAccountId,
  ssoRoleName,
  defaultRegion,
  prefilledCredentials,
}: UseAwsAuthOptions) {
  const { registerOutputs, blockOutputs } = useRunbookContext()
  const { getAuthHeader } = useSession()

  // Core auth state
  const [authMethod, setAuthMethod] = useState<AuthMethod>('credentials')
  const [authStatus, setAuthStatus] = useState<AuthStatus>('pending')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [warningMessage, setWarningMessage] = useState<string | null>(null)
  const [accountInfo, setAccountInfo] = useState<AccountInfo | null>(null)
  
  // Prefill state
  const [prefillStatus, setPrefillStatus] = useState<PrefillStatus>(
    prefilledCredentials ? 'pending' : 'not-configured'
  )
  const [prefillError, setPrefillError] = useState<string | null>(null)
  const [prefillSource, setPrefillSource] = useState<PrefilledCredentialsType | null>(null)
  const prefillAttemptedRef = useRef(false)
  const [prefillRetryCount, setPrefillRetryCount] = useState(0)
  // Track if we're waiting for a block to produce outputs (vs actively checking)
  const [waitingForBlockId, setWaitingForBlockId] = useState<string | null>(
    prefilledCredentials?.type === 'block' ? prefilledCredentials.blockId : null
  )

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

  // Helper to check for prefilled credentials from block outputs
  const getBlockCredentials = useCallback((blockId: string): { found: boolean; creds?: Partial<AwsCredentials>; error?: string } => {
    // Normalize block ID (hyphens to underscores) to match how they're stored
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
    // Register as outputs so other blocks can reference them via awsAuthId
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

  // Attempt to prefill credentials from block outputs
  const attemptBlockPrefill = useCallback(async (blockId: string) => {
    const result = getBlockCredentials(blockId)
    
    if (!result.found || !result.creds) {
      return { success: false, error: result.error || 'Could not read credentials from block' }
    }

    // Validate and register the credentials
    const creds: AwsCredentials = {
      accessKeyId: result.creds.accessKeyId!,
      secretAccessKey: result.creds.secretAccessKey!,
      sessionToken: result.creds.sessionToken,
      region: result.creds.region || defaultRegion,
    }

    // Validate via backend
    const response = await fetch('/api/aws/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(creds)
    })

    const data = await response.json()

    if (!data.valid) {
      return { success: false, error: data.error || 'Block credentials are invalid' }
    }

    // Register credentials
    await registerCredentials(creds)
    
    return { 
      success: true, 
      accountId: data.accountId, 
      arn: data.arn,
      warning: data.warning 
    }
  }, [getBlockCredentials, defaultRegion, registerCredentials])

  // Handle prefilled credentials on mount (for env and static types)
  useEffect(() => {
    // Skip if not configured or if it's block type (handled separately)
    if (!prefilledCredentials || prefilledCredentials.type === 'block') {
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
          const response = await fetch('/api/aws/env-credentials', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...getAuthHeader(),
            },
            body: JSON.stringify({
              prefix: prefilledCredentials.prefix || '',
              awsAuthId: id,
              defaultRegion,
            })
          })

          const data = await response.json()

          if (!data.found) {
            setPrefillStatus('failed')
            setPrefillError(data.error || 'No credentials found in environment')
            return
          }

          if (!data.valid) {
            setPrefillStatus('failed')
            setPrefillError(data.error || 'Environment credentials are invalid')
            return
          }

          // Credentials validated and registered on the server side
          setPrefillStatus('success')
          setPrefillSource('env')
          setAuthStatus('authenticated')
          setAccountInfo({ accountId: data.accountId, arn: data.arn })

          // Note: We do NOT register outputs to RunbookContext for env-prefilled credentials.
          // The actual credentials are stored in the server session environment, and commands
          // will access them from there. Registering placeholder values would break awsAuthId
          // lookups since they'd pass the placeholders instead of real credentials.

          if (data.warning) {
            setWarningMessage(data.warning)
          }
        } else if (prefilledCredentials.type === 'static') {
          // Use static values directly
          if (!prefilledCredentials.accessKeyId || !prefilledCredentials.secretAccessKey) {
            setPrefillStatus('failed')
            setPrefillError('Static credentials missing accessKeyId or secretAccessKey')
            return
          }

          const creds: AwsCredentials = {
            accessKeyId: prefilledCredentials.accessKeyId,
            secretAccessKey: prefilledCredentials.secretAccessKey,
            sessionToken: prefilledCredentials.sessionToken,
            region: prefilledCredentials.region || defaultRegion,
          }

          // Validate via backend
          const response = await fetch('/api/aws/validate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(creds)
          })

          const data = await response.json()

          if (!data.valid) {
            setPrefillStatus('failed')
            setPrefillError(data.error || 'Static credentials are invalid')
            return
          }

          // Register credentials
          await registerCredentials(creds)
          
          setPrefillStatus('success')
          setPrefillSource('static')
          setAuthStatus('authenticated')
          setAccountInfo({ accountId: data.accountId, arn: data.arn })

          if (data.warning) {
            setWarningMessage(data.warning)
          }
        }
      } catch (error) {
        setPrefillStatus('failed')
        setPrefillError(error instanceof Error ? error.message : 'Failed to prefill credentials')
      }
    }

    attemptPrefill()
  }, [prefilledCredentials, id, defaultRegion, getAuthHeader, registerCredentials, prefillRetryCount])

  // Handle block-based credential prefill - watches for block outputs to become available
  useEffect(() => {
    // Only handle block type prefill
    if (prefilledCredentials?.type !== 'block') {
      return
    }
    
    // Don't retry if already authenticated
    if (authStatus === 'authenticated') {
      return
    }
    
    // Don't auto-prefill if user opted for manual auth
    if (prefillStatus === 'not-configured') {
      return
    }

    // Don't auto-retry on failure - user must explicitly retry
    if (prefillStatus === 'failed') {
      return
    }

    // Check if the source block has outputs
    const result = getBlockCredentials(prefilledCredentials.blockId)
    
    if (!result.found) {
      // Block hasn't produced outputs yet - show waiting state
      setWaitingForBlockId(prefilledCredentials.blockId)
      if (prefillStatus !== 'pending') {
        setPrefillStatus('pending')
        setPrefillError(null)
      }
      return
    }

    // Block has outputs - clear waiting state and attempt to authenticate
    setWaitingForBlockId(null)
    
    const doAuth = async () => {
      setPrefillStatus('pending')
      setPrefillError(null)
      
      try {
        const authResult = await attemptBlockPrefill(prefilledCredentials.blockId)
        
        if (authResult.success) {
          setPrefillStatus('success')
          setPrefillSource('block')
          setAuthStatus('authenticated')
          setAccountInfo({ accountId: authResult.accountId, arn: authResult.arn })
          if (authResult.warning) {
            setWarningMessage(authResult.warning)
          }
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
        setAccountInfo({ accountId: data.accountId, arn: data.arn })
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

      try {
        const response = await fetch('/api/aws/sso/poll', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...getAuthHeader(),
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
          setAccountInfo({ accountId: data.accountId, arn: data.arn })
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

    setAuthStatus('authenticating')

    try {
      const response = await fetch('/api/aws/sso/complete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeader(),
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
        setAccountInfo({ accountId: data.accountId, arn: data.arn })
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

    setAuthStatus('authenticating')
    setErrorMessage(null)

    try {
      const response = await fetch('/api/aws/profile', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeader(),
        },
        body: JSON.stringify({ profile: selectedProfile.name })
      })

      const data = await response.json()
      
      if (response.ok && data.valid) {
        setAuthStatus('authenticated')
        setAccountInfo({ accountId: data.accountId, arn: data.arn })
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

  // Retry prefilled credentials (re-read from env, re-check block outputs, etc.)
  const handleRetryPrefill = useCallback(() => {
    setAuthStatus('pending')
    setErrorMessage(null)
    setWarningMessage(null)
    setAccountInfo(null)
    setPrefillStatus('pending')
    setPrefillError(null)
    // Reset the attempt flag and increment retry count to trigger the effect
    prefillAttemptedRef.current = false
    setPrefillRetryCount(c => c + 1)
  }, [])

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
    // Clear prefill state so manual auth UI shows
    setPrefillStatus('not-configured')
    setPrefillSource(null)
    setPrefillError(null)
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

    // Prefill state
    prefillStatus,
    prefillError,
    prefillSource,
    waitingForBlockId,

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
    
    handleRetryPrefill,
    handleManualAuth,
    handleCancelSsoAuth,
  }
}
