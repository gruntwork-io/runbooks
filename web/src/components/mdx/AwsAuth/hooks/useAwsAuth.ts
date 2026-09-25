import { useState, useCallback, useRef, useEffect } from "react"
import { useApi } from "@/contexts/ApiContext"
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
import { resolveDefaultAuthMethod } from "../utils"

interface UseAwsAuthOptions {
  id: string
  ssoStartUrl?: string
  ssoRegion: string
  ssoAccountId?: string
  ssoRoleName?: string
  defaultRegion: string
  detectCredentials?: false | AwsCredentialSource[]
  /** Tab to open on; validated by resolveDefaultAuthMethod. */
  defaultTab?: string
}

export function useAwsAuth({
  id,
  ssoStartUrl,
  ssoRegion,
  ssoAccountId,
  ssoRoleName,
  defaultRegion,
  detectCredentials = ['env'],  // Default: auto-detect from env vars
  defaultTab,
}: UseAwsAuthOptions) {
  const api = useApi()
  const { registerOutputs, blockOutputs } = useRunbookContext()
  const { isReady: sessionReady } = useSession()

  // Core auth state
  // The starting tab is the author's `defaultTab` (validated), not a constant.
  // Only the initial value is taken from the prop — the user's tab clicks own
  // it from then on.
  const [authMethod, setAuthMethod] = useState<AuthMethod>(() => resolveDefaultAuthMethod(defaultTab))
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
  // Remaining credential sources to try if a higher-priority block source fails.
  // When detection pauses to wait for a block, the sources that come after it in
  // the priority list are stashed here so they can be tried if the block fails.
  const remainingSourcesRef = useRef<AwsCredentialSource[]>([])

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

  // SSO polling. Each sign-in attempt runs under its own flow number, and its
  // poll loop acts only while that number is current. stopSsoPolling bumps the
  // number and clears the pending timer, so cancel, re-auth, retry and unmount
  // end the loop even with a poll in flight, and a later attempt can't revive it.
  const ssoFlowRef = useRef(0)
  const ssoPollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const stopSsoPolling = useCallback(() => {
    ssoFlowRef.current++
    if (ssoPollTimeoutRef.current) {
      clearTimeout(ssoPollTimeoutRef.current)
      ssoPollTimeoutRef.current = null
    }
  }, [])

  // Cleanup on unmount: an abandoned loop would otherwise keep polling and,
  // on approval, register credentials from a block that is no longer shown.
  useEffect(() => {
    return () => {
      stopSsoPolling()
    }
  }, [stopSsoPolling])

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
      const data = await api.invoke('aws:check-region', {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
        region: creds.region,
      })
      if (data.warning) {
        setWarningMessage(data.warning)
      }
    } catch (error) {
      console.error('Failed to check region status:', error)
    }
  }, [api])

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
      await api.invoke('session:set-env', { env: outputs })
    } catch (error) {
      console.error('Failed to set session environment variables:', error)
    }

    await checkRegionStatus(creds)
  }, [api, id, registerOutputs, checkRegionStatus])

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
      // Read-only detection - credentials are NOT registered to session until
      // user confirms via handleConfirmDetected
      const data = await api.invoke('aws:env-credentials', {
        prefix: options?.prefix || '',
        defaultRegion: defaultRegion || '',
      })

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
  }, [api, defaultRegion])

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
      const data = await api.invoke('aws:validate', {
        accessKeyId: result.creds.accessKeyId,
        secretAccessKey: result.creds.secretAccessKey,
        sessionToken: result.creds.sessionToken,
        region: result.creds.region || defaultRegion,
      })

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
  }, [api, getBlockCredentials, defaultRegion])

  // Try credential sources in priority order. Stops at the first success or
  // at an unexecuted block source (waiting for it before trying lower-priority
  // sources). Extracted as a callback so both the initial detection effect and
  // the block-watcher can reuse the same logic.
  const trySourcesInOrder = useCallback(async (
    sources: AwsCredentialSource[],
    isRetry: boolean
  ) => {
    const warnings: string[] = []

    for (let i = 0; i < sources.length; i++) {
      const source = sources[i]

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
      else if (typeof source === 'object' && 'env' in source) {
        const prefix = (source.env as { prefix?: string })?.prefix
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
        // Check if block has actually executed (has any outputs at all, even
        // if they don't contain AWS credentials)
        const normalizedBlockId = normalizeBlockId(source.block)
        const blockHasExecuted = blockOutputs[normalizedBlockId]?.values !== undefined
        if (!blockHasExecuted) {
          // Block hasn't executed yet - wait for it before trying lower-priority
          // sources. This respects the author's intended priority ordering:
          // if a block source is listed before env, the block takes precedence.
          remainingSourcesRef.current = sources.slice(i + 1)
          setWaitingForBlockId(source.block)
          return
        }
        // Block executed but credentials invalid/missing - continue to next source
      }
      // Note: 'default-profile' detection was intentionally not implemented.
      // Profile-based auth is available via the Profile tab in manual authentication.
      // Auto-detecting the default profile is complex due to AWS config precedence rules.
    }

    // No source succeeded
    if (warnings.length > 0) {
      setDetectionWarning(warnings.join('; '))
    }

    // Nothing found - show feedback if this was a user-initiated retry
    if (isRetry) {
      setRetryFoundNothing(true)
    }
    setDetectionStatus('done')
  }, [tryEnvCredentials, tryBlockCredentials, blockOutputs, defaultRegion])

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

    trySourcesInOrder(detectCredentials, detectionAttempt > 0)
  }, [detectCredentials, sessionReady, trySourcesInOrder, detectionAttempt])

  // Watch for block outputs when waiting for a block
  useEffect(() => {
    if (!waitingForBlockId || detectionStatus === 'detected' || authStatus === 'authenticated') {
      return
    }

    // Check if the block has executed (has any outputs at all, even if they
    // don't contain AWS credentials). This is more precise than getBlockCredentials
    // which returns found:false for both "not executed" and "no AWS keys".
    const normalizedId = normalizeBlockId(waitingForBlockId)
    const hasExecuted = blockOutputs[normalizedId]?.values !== undefined
    if (!hasExecuted) {
      return // Block hasn't executed yet, still waiting
    }

    // Block has outputs now, try to validate credentials
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
        // Block executed but credentials invalid/missing.
        // Try remaining lower-priority sources before falling back to manual auth.
        setWaitingForBlockId(null)
        const remaining = remainingSourcesRef.current
        remainingSourcesRef.current = []
        if (remaining.length > 0) {
          await trySourcesInOrder(remaining, false)
        } else {
          setDetectionStatus('done')
        }
      }
    }

    doDetection()
  }, [waitingForBlockId, detectionStatus, authStatus, blockOutputs, tryBlockCredentials, trySourcesInOrder, defaultRegion])

  // User confirms detected credentials - register them to session and authenticate
  const handleConfirmDetected = useCallback(async () => {
    if (!detectedCredentials) return

    setAuthStatus('authenticating')

    // For env-detected credentials, call the confirm endpoint to register them to session
    if (detectedCredentials.source === 'env') {
      try {
        const data = await api.invoke('aws:env-credentials-confirm', {
          prefix: detectedCredentials.envPrefix || '',
          defaultRegion: defaultRegion || '',
        })

        if (!data.valid) {
          setAuthStatus('failed')
          setErrorMessage(data.error || 'Failed to register credentials')
          return
        }

        setAuthStatus('authenticated')
        // Use the confirmed response payload (not detectedCredentials) to avoid
        // TOCTOU: credentials may have changed between detection and confirmation.
        setAccountInfo({
          accountId: data.accountId,
          accountName: data.accountName,
          arn: data.arn,
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
  }, [api, detectedCredentials, detectionWarning, detectCredentials, getBlockCredentials, defaultRegion, registerCredentials, registerOutputs, id])

  // User rejects detected credentials - show manual auth
  // Note: credentials are not in session until confirmed, so no need to clear them
  const handleRejectDetected = useCallback(() => {
    // Reset to manual auth state
    setDetectedCredentials(null)
    setDetectionWarning(null)
    setDetectionStatus('done')
    setAuthStatus('pending')
  }, [])

  // Retry credential detection (after user rejected and wants to go back).
  // The link is shown while an SSO sign-in may be in progress, so stop it.
  const handleRetryDetection = useCallback(() => {
    stopSsoPolling()
    // Reset detection state so the effect will re-run
    setDetectedCredentials(null)
    setDetectionWarning(null)
    setDetectionStatus('pending')
    setAuthStatus('pending')
    setErrorMessage(null)
    setWarningMessage(null)
    setRetryFoundNothing(false)
    remainingSourcesRef.current = []
    // Reset the ref so detection effect will run again
    detectionAttemptedRef.current = false
    // Increment the attempt counter to trigger the effect to re-run
    setDetectionAttempt(prev => prev + 1)
  }, [stopSsoPolling])

  // Load AWS profiles from local machine
  const loadAwsProfiles = useCallback(async () => {
    setLoadingProfiles(true)
    try {
      const data = await api.invoke('aws:profiles', {} as Record<string, never>)
      const profileList: ProfileInfo[] = data.profiles ?? []
      setProfiles(profileList)
      // Keep the user's pick across a refresh while it is still listed and
      // usable (taking the fresh entry, whose type may have changed); otherwise
      // the first usable profile, or nothing, so a stale pick can't be used.
      const usable = (p: ProfileInfo) => p.authType === 'static' || p.authType === 'assume_role'
      setSelectedProfile(prev =>
        (prev && profileList.find(p => p.name === prev.name && usable(p))) ?? profileList.find(usable) ?? null)
    } catch (error) {
      console.error('Failed to load AWS profiles:', error)
      setProfiles([])
      setSelectedProfile(null)
    } finally {
      setLoadingProfiles(false)
    }
  }, [api])

  // Validate credentials by calling STS GetCallerIdentity
  const validateCredentials = useCallback(async (creds: AwsCredentials) => {
    setAuthStatus('authenticating')
    setErrorMessage(null)
    setWarningMessage(null)

    try {
      const data = await api.invoke('aws:validate', creds)

      if (data.valid) {
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
  }, [api, registerCredentials])

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

  // Poll for SSO authentication completion. `flow` is the attempt this loop
  // belongs to; once it is no longer current the loop stops without touching state.
  const pollSsoCompletion = useCallback(async (deviceCode: string, clientId: string, clientSecret: string, flow: number) => {
    const maxAttempts = 60
    let attempts = 0
    const stale = () => ssoFlowRef.current !== flow

    const poll = async () => {
      if (stale()) return

      try {
        const data = await api.invoke('aws:sso-poll', {
          deviceCode,
          clientId,
          clientSecret,
          region: ssoRegion,
          accountId: ssoAccountId,
          roleName: ssoRoleName,
        })

        if (stale()) return

        if (data.status === 'pending' && attempts < maxAttempts) {
          attempts++
          ssoPollTimeoutRef.current = setTimeout(poll, 2000)
        } else if (data.status === 'select_account') {
          setSsoAccessToken(data.accessToken ?? null)
          setSsoAccounts((data.accounts ?? []) as unknown as SSOAccount[])
          setAuthStatus('select_account')
        } else if (data.status === 'success') {
          setAuthStatus('authenticated')
          setAccountInfo({ accountId: data.accountId, accountName: data.accountName, arn: data.arn })
          registerCredentials({
            accessKeyId: data.accessKeyId!,
            secretAccessKey: data.secretAccessKey!,
            sessionToken: data.sessionToken,
            region: selectedDefaultRegion
          })
        } else {
          setAuthStatus('failed')
          setErrorMessage(data.error || 'SSO authentication timed out or failed')
        }
      } catch (error) {
        if (stale()) return
        setAuthStatus('failed')
        setErrorMessage(error instanceof Error ? error.message : 'Failed to poll SSO status')
      }
    }

    poll()
  }, [api, ssoRegion, ssoAccountId, ssoRoleName, selectedDefaultRegion, registerCredentials])

  // Handle SSO authentication
  const handleSsoAuth = useCallback(async () => {
    if (!ssoStartUrl) {
      setErrorMessage('SSO Start URL is required for SSO authentication')
      return
    }

    // End any earlier attempt; this one runs under a fresh flow number.
    stopSsoPolling()
    const flow = ssoFlowRef.current
    setAuthStatus('authenticating')
    setErrorMessage(null)

    try {
      const data = await api.invoke('aws:sso-start', {
        startUrl: ssoStartUrl,
        region: ssoRegion,
        accountId: ssoAccountId,
        roleName: ssoRoleName,
      })

      // Cancelled (or superseded) while the device flow was starting: don't
      // open the browser or start polling for an attempt the user abandoned.
      if (ssoFlowRef.current !== flow) return

      if (data.verificationUri) {
        window.open(data.verificationUri, '_blank')
        pollSsoCompletion(data.deviceCode, data.clientId, data.clientSecret, flow)
      } else {
        setAuthStatus('failed')
        setErrorMessage(data.error || 'Failed to start SSO authentication')
      }
    } catch (error) {
      if (ssoFlowRef.current !== flow) return
      setAuthStatus('failed')
      setErrorMessage(error instanceof Error ? error.message : 'Failed to connect to server')
    }
  }, [api, ssoStartUrl, ssoRegion, ssoAccountId, ssoRoleName, pollSsoCompletion, stopSsoPolling])

  // Handle SSO account selection - load roles for selected account
  const handleSsoAccountSelect = useCallback(async (account: SSOAccount) => {
    setSelectedSsoAccount(account)
    setLoadingRoles(true)
    setSelectedSsoRole('')
    setSsoRoles([])

    try {
      const data = await api.invoke('aws:sso-roles', {
        accessToken: ssoAccessToken!,
        accountId: account.accountId,
        region: ssoRegion,
      })

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
  }, [api, ssoAccessToken, ssoRegion])

  // Complete SSO authentication with selected account and role
  const handleSsoComplete = useCallback(async () => {
    if (!selectedSsoAccount || !selectedSsoRole || !ssoAccessToken) {
      setErrorMessage('Please select an account and role')
      return
    }

    setAuthStatus('authenticating')

    try {
      const data = await api.invoke('aws:sso-complete', {
        accessToken: ssoAccessToken!,
        accountId: selectedSsoAccount.accountId,
        roleName: selectedSsoRole,
        region: ssoRegion,
      })

      if (data.accessKeyId) {
        setAuthStatus('authenticated')
        setAccountInfo({ accountId: data.accountId, accountName: data.accountName, arn: data.arn })
        registerCredentials({
          accessKeyId: data.accessKeyId!,
          secretAccessKey: data.secretAccessKey!,
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
  }, [api, selectedSsoAccount, selectedSsoRole, ssoAccessToken, ssoRegion, selectedDefaultRegion, registerCredentials])

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
      const data = await api.invoke('aws:profile-auth', { profileName: selectedProfile.name, profile: selectedProfile.name })

      if (data.valid) {
        setAuthStatus('authenticated')
        setAccountInfo({ accountId: data.accountId, accountName: data.accountName, arn: data.arn })
        registerCredentials({
          accessKeyId: data.accessKeyId!,
          secretAccessKey: data.secretAccessKey!,
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
  }, [api, selectedProfile, selectedDefaultRegion, registerCredentials])

  // Reset to manual authentication (show auth tabs). Also "Re-authenticate".
  const handleManualAuth = useCallback(() => {
    stopSsoPolling()
    // Withdraw the block's outputs so `awsAuthId` steps stop using the
    // credential this reset exists to replace (GoogleAuth does the same).
    // registerOutputs replaces the whole map. The session env keeps the old
    // AWS_* values until the next sign-in overwrites them.
    registerOutputs(id, { __AUTHENTICATED: 'false' })
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
    setWaitingForBlockId(null)
    remainingSourcesRef.current = []
  }, [stopSsoPolling, registerOutputs, id])

  // Cancel SSO authentication
  const handleCancelSsoAuth = useCallback(() => {
    stopSsoPolling()
    setAuthStatus('pending')
    setErrorMessage(null)
  }, [stopSsoPolling])

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
