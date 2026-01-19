import { useState, useCallback, useRef } from "react"
import { useBlockVariables } from "@/contexts/useBlockVariables"
import { useSession } from "@/contexts/useSession"
import { BoilerplateVariableType } from "@/types/boilerplateVariable"
import type { BoilerplateConfig } from "@/types/boilerplateConfig"
import type {
  AuthMethod,
  AuthStatus,
  AccountInfo,
  AwsCredentials,
  SSOAccount,
  SSORole,
  ProfileInfo,
} from "../types"

// Create a minimal boilerplate config for registering credentials as inputs
const createAwsCredentialsConfig = (): BoilerplateConfig => ({
  variables: [
    { name: 'AWS_ACCESS_KEY_ID', type: BoilerplateVariableType.String, description: 'AWS Access Key ID', default: '', required: true },
    { name: 'AWS_SECRET_ACCESS_KEY', type: BoilerplateVariableType.String, description: 'AWS Secret Access Key', default: '', required: true },
    { name: 'AWS_SESSION_TOKEN', type: BoilerplateVariableType.String, description: 'AWS Session Token (optional)', default: '', required: false },
    { name: 'AWS_REGION', type: BoilerplateVariableType.String, description: 'AWS Region', default: '', required: true },
  ],
})

interface UseAwsAuthOptions {
  id: string
  ssoStartUrl?: string
  ssoRegion: string
  ssoAccountId?: string
  ssoRoleName?: string
  defaultRegion: string
}

export function useAwsAuth({
  id,
  ssoStartUrl,
  ssoRegion,
  ssoAccountId,
  ssoRoleName,
  defaultRegion,
}: UseAwsAuthOptions) {
  const { registerInputs } = useBlockVariables()
  const { getAuthHeader } = useSession()

  // Core auth state
  const [authMethod, setAuthMethod] = useState<AuthMethod>('credentials')
  const [authStatus, setAuthStatus] = useState<AuthStatus>('pending')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [warningMessage, setWarningMessage] = useState<string | null>(null)
  const [accountInfo, setAccountInfo] = useState<AccountInfo | null>(null)

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

  // Register credentials with BlockVariables and session environment
  const registerCredentials = useCallback(async (creds: AwsCredentials) => {
    const values: Record<string, unknown> = {
      AWS_ACCESS_KEY_ID: creds.accessKeyId,
      AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
      AWS_REGION: creds.region,
      AWS_SESSION_TOKEN: creds.sessionToken || '',
    }
    
    registerInputs(id, values, createAwsCredentialsConfig())
    
    try {
      const envVars: Record<string, string> = {
        AWS_ACCESS_KEY_ID: creds.accessKeyId,
        AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
        AWS_REGION: creds.region,
        AWS_SESSION_TOKEN: creds.sessionToken || '',
      }
      
      await fetch('/api/session/env', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeader(),
        },
        body: JSON.stringify({ env: envVars }),
      })
    } catch (error) {
      console.error('Failed to set session environment variables:', error)
    }

    await checkRegionStatus(creds)
  }, [id, registerInputs, getAuthHeader, checkRegionStatus])

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
          headers: { 'Content-Type': 'application/json' },
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
  }, [ssoRegion, ssoAccountId, ssoRoleName, selectedDefaultRegion, registerCredentials])

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
        headers: { 'Content-Type': 'application/json' },
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
  }, [selectedSsoAccount, selectedSsoRole, ssoAccessToken, ssoRegion, selectedDefaultRegion, registerCredentials])

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
        headers: { 'Content-Type': 'application/json' },
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
  }, [selectedProfile, selectedDefaultRegion, registerCredentials])

  // Reset authentication state
  const handleReset = useCallback(() => {
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
    handleReset,
    handleCancelSsoAuth,
  }
}
