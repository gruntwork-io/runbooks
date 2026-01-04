import { useState, useEffect, useCallback } from "react"
import { CheckCircle, XCircle, Loader2, KeyRound, ExternalLink, User, Eye, EyeOff, AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { InlineMarkdown } from "@/components/mdx/_shared/components/InlineMarkdown"
import { useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { useTelemetry } from "@/contexts/useTelemetry"
import { useBlockVariables } from "@/contexts/useBlockVariables"
import type { BoilerplateConfig } from "@/types/boilerplateConfig"
import { BoilerplateVariableType } from "@/types/boilerplateVariable"

type AuthMethod = 'credentials' | 'sso' | 'profile'
type AuthStatus = 'pending' | 'authenticating' | 'authenticated' | 'failed'

interface AwsAuthProps {
  id: string
  title?: string
  description?: string
  /** AWS SSO start URL for SSO authentication */
  ssoStartUrl?: string
  /** AWS SSO region */
  ssoRegion?: string
  /** AWS SSO account ID to select after authentication */
  ssoAccountId?: string
  /** AWS SSO role name to assume */
  ssoRoleName?: string
  /** Default AWS region for authenticated session */
  region?: string
  /** Enable static credentials input */
  enableCredentials?: boolean
  /** Enable AWS SSO authentication */
  enableSso?: boolean
  /** Enable profile selection */
  enableProfile?: boolean
}

// Create a minimal boilerplate config for registering credentials as inputs
const createAwsCredentialsConfig = (): BoilerplateConfig => ({
  variables: [
    { name: 'AWS_ACCESS_KEY_ID', type: BoilerplateVariableType.String, description: 'AWS Access Key ID', default: '', required: true },
    { name: 'AWS_SECRET_ACCESS_KEY', type: BoilerplateVariableType.String, description: 'AWS Secret Access Key', default: '', required: true },
    { name: 'AWS_SESSION_TOKEN', type: BoilerplateVariableType.String, description: 'AWS Session Token (optional)', default: '', required: false },
    { name: 'AWS_REGION', type: BoilerplateVariableType.String, description: 'AWS Region', default: '', required: true },
  ],
  rawYaml: '', // Not needed for programmatic config
})

function AwsAuth({
  id,
  title = "AWS Authentication",
  description,
  ssoStartUrl,
  ssoRegion = "us-east-1",
  ssoAccountId,
  ssoRoleName,
  region = "us-east-1",
  enableCredentials = true,
  enableSso = true,
  enableProfile = true,
}: AwsAuthProps) {
  // Check for duplicate component IDs
  const { isDuplicate } = useComponentIdRegistry(id, 'AwsAuth')
  
  // Error reporting context
  const { reportError, clearError } = useErrorReporting()
  
  // Telemetry context
  const { trackBlockRender } = useTelemetry()

  // Block variables context for sharing credentials with other blocks
  const { registerInputs } = useBlockVariables()

  // State
  const [authMethod, setAuthMethod] = useState<AuthMethod>('credentials')
  const [authStatus, setAuthStatus] = useState<AuthStatus>('pending')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [accountInfo, setAccountInfo] = useState<{ accountId?: string; arn?: string } | null>(null)

  // Credentials form state
  const [accessKeyId, setAccessKeyId] = useState('')
  const [secretAccessKey, setSecretAccessKey] = useState('')
  const [sessionToken, setSessionToken] = useState('')
  const [selectedRegion, setSelectedRegion] = useState(region)
  const [showSecretKey, setShowSecretKey] = useState(false)
  const [showSessionToken, setShowSessionToken] = useState(false)

  // Profile state
  const [profiles, setProfiles] = useState<string[]>([])
  const [selectedProfile, setSelectedProfile] = useState<string>('')
  const [loadingProfiles, setLoadingProfiles] = useState(false)

  // Track block render on mount
  useEffect(() => {
    trackBlockRender('AwsAuth')
  }, [trackBlockRender])

  // Load available profiles when profile tab is selected
  useEffect(() => {
    if (authMethod === 'profile' && profiles.length === 0) {
      loadAwsProfiles()
    }
  }, [authMethod, profiles.length])

  // Report errors
  useEffect(() => {
    if (isDuplicate) {
      reportError({
        componentId: id,
        componentType: 'AwsAuth',
        severity: 'error',
        message: `Duplicate component ID: ${id}`
      })
    } else if (authStatus === 'failed' && errorMessage) {
      reportError({
        componentId: id,
        componentType: 'AwsAuth',
        severity: 'error',
        message: errorMessage
      })
    } else {
      clearError(id)
    }
  }, [id, isDuplicate, authStatus, errorMessage, reportError, clearError])

  // Register credentials with BlockVariables when authenticated
  const registerCredentials = useCallback((creds: {
    accessKeyId: string
    secretAccessKey: string
    sessionToken?: string
    region: string
  }) => {
    const values: Record<string, unknown> = {
      AWS_ACCESS_KEY_ID: creds.accessKeyId,
      AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
      AWS_REGION: creds.region,
    }
    if (creds.sessionToken) {
      values.AWS_SESSION_TOKEN = creds.sessionToken
    }
    registerInputs(id, values, createAwsCredentialsConfig())
  }, [id, registerInputs])

  // Load AWS profiles from local machine
  const loadAwsProfiles = async () => {
    setLoadingProfiles(true)
    try {
      const response = await fetch('/api/aws/profiles')
      if (response.ok) {
        const data = await response.json()
        setProfiles(data.profiles || [])
        if (data.profiles?.length > 0) {
          setSelectedProfile(data.profiles[0])
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
  }

  // Validate credentials by calling STS GetCallerIdentity
  const validateCredentials = async (creds: {
    accessKeyId: string
    secretAccessKey: string
    sessionToken?: string
    region: string
  }) => {
    setAuthStatus('authenticating')
    setErrorMessage(null)

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
  }

  // Handle static credentials submission
  const handleCredentialsSubmit = () => {
    if (!accessKeyId || !secretAccessKey) {
      setErrorMessage('Access Key ID and Secret Access Key are required')
      return
    }
    validateCredentials({
      accessKeyId,
      secretAccessKey,
      sessionToken: sessionToken || undefined,
      region: selectedRegion
    })
  }

  // Handle SSO authentication
  const handleSsoAuth = async () => {
    if (!ssoStartUrl) {
      setErrorMessage('SSO Start URL is required for SSO authentication')
      return
    }

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
        // Open browser for user to authenticate
        window.open(data.verificationUri, '_blank')
        
        // Poll for authentication completion
        pollSsoCompletion(data.deviceCode, data.clientId, data.clientSecret)
      } else {
        setAuthStatus('failed')
        setErrorMessage(data.error || 'Failed to start SSO authentication')
      }
    } catch (error) {
      setAuthStatus('failed')
      setErrorMessage(error instanceof Error ? error.message : 'Failed to connect to server')
    }
  }

  // Poll for SSO authentication completion
  const pollSsoCompletion = async (deviceCode: string, clientId: string, clientSecret: string) => {
    const maxAttempts = 60
    let attempts = 0

    const poll = async () => {
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

        const data = await response.json()

        if (data.status === 'pending' && attempts < maxAttempts) {
          attempts++
          setTimeout(poll, 2000)
        } else if (data.status === 'success') {
          setAuthStatus('authenticated')
          setAccountInfo({ accountId: data.accountId, arn: data.arn })
          registerCredentials({
            accessKeyId: data.accessKeyId,
            secretAccessKey: data.secretAccessKey,
            sessionToken: data.sessionToken,
            region: ssoRegion
          })
        } else {
          setAuthStatus('failed')
          setErrorMessage(data.error || 'SSO authentication timed out or failed')
        }
      } catch (error) {
        setAuthStatus('failed')
        setErrorMessage(error instanceof Error ? error.message : 'Failed to poll SSO status')
      }
    }

    poll()
  }

  // Handle profile selection
  const handleProfileAuth = async () => {
    if (!selectedProfile) {
      setErrorMessage('Please select a profile')
      return
    }

    setAuthStatus('authenticating')
    setErrorMessage(null)

    try {
      const response = await fetch('/api/aws/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: selectedProfile })
      })

      const data = await response.json()
      
      if (response.ok && data.valid) {
        setAuthStatus('authenticated')
        setAccountInfo({ accountId: data.accountId, arn: data.arn })
        registerCredentials({
          accessKeyId: data.accessKeyId,
          secretAccessKey: data.secretAccessKey,
          sessionToken: data.sessionToken,
          region: data.region || selectedRegion
        })
      } else {
        setAuthStatus('failed')
        setErrorMessage(data.error || 'Failed to authenticate with profile')
      }
    } catch (error) {
      setAuthStatus('failed')
      setErrorMessage(error instanceof Error ? error.message : 'Failed to connect to server')
    }
  }

  // Reset authentication state
  const handleReset = () => {
    setAuthStatus('pending')
    setErrorMessage(null)
    setAccountInfo(null)
  }

  // Get status-based styling
  const getStatusClasses = () => {
    const statusMap = {
      authenticated: 'bg-green-50 border-green-200',
      failed: 'bg-red-50 border-red-200',
      authenticating: 'bg-amber-50 border-amber-200',
      pending: 'bg-amber-50/50 border-amber-200',
    }
    return statusMap[authStatus]
  }

  const getStatusIcon = () => {
    const iconMap = {
      authenticated: CheckCircle,
      failed: XCircle,
      authenticating: Loader2,
      pending: KeyRound,
    }
    return iconMap[authStatus]
  }

  const getStatusIconClasses = () => {
    const colorMap = {
      authenticated: 'text-green-600',
      failed: 'text-red-600',
      authenticating: 'text-amber-600',
      pending: 'text-amber-600',
    }
    return colorMap[authStatus]
  }

  // Count enabled methods
  const enabledMethods = [enableCredentials, enableSso, enableProfile].filter(Boolean)

  // Early return for duplicate ID
  if (isDuplicate) {
    return (
      <div className="relative rounded-sm border bg-red-50 border-red-200 mb-5 p-4">
        <div className="flex items-center text-red-600">
          <XCircle className="size-6 mr-4 flex-shrink-0" />
          <div className="text-md">
            <strong>Duplicate Component ID:</strong><br />
            Another <code className="bg-red-100 px-1 rounded">{"<AwsAuth>"}</code> component with id <code className="bg-red-100 px-1 rounded">{`"${id}"`}</code> already exists.
          </div>
        </div>
      </div>
    )
  }

  const IconComponent = getStatusIcon()
  const statusClasses = getStatusClasses()
  const iconClasses = getStatusIconClasses()

  return (
    <div className={`relative rounded-sm border ${statusClasses} mb-5 p-4`}>
      {/* Header with AWS Logo */}
      <div className="flex items-start gap-4 @container">
        <div className="border-r border-amber-300 pr-3 mr-2">
          <IconComponent className={`size-6 ${iconClasses} ${authStatus === 'authenticating' ? 'animate-spin' : ''}`} />
        </div>

        <div className="flex-1">
          {/* Title row with AWS logo */}
          <div className="flex items-center gap-3 mb-2">
            <img src="/aws-logo.svg" alt="AWS" className="h-6" />
            <div className="text-md font-bold text-gray-700">
              <InlineMarkdown>{title}</InlineMarkdown>
            </div>
          </div>
          
          {description && (
            <div className="text-md text-gray-600 mb-4">
              <InlineMarkdown>{description}</InlineMarkdown>
            </div>
          )}

          {/* Success state */}
          {authStatus === 'authenticated' && accountInfo && (
            <div className="mb-4">
              <div className="text-green-700 font-semibold text-sm mb-2">
                ✓ Authenticated to AWS
              </div>
              <div className="bg-green-100/50 rounded p-3 text-sm">
                <div className="text-gray-700">
                  <span className="font-medium">Account:</span> {accountInfo.accountId}
                </div>
                {accountInfo.arn && (
                  <div className="text-gray-600 text-xs mt-1 font-mono truncate" title={accountInfo.arn}>
                    {accountInfo.arn}
                  </div>
                )}
              </div>
              <Button 
                variant="outline" 
                size="sm" 
                onClick={handleReset}
                className="mt-3"
              >
                Re-authenticate
              </Button>
            </div>
          )}

          {/* Error state */}
          {authStatus === 'failed' && errorMessage && (
            <div className="mb-4 text-red-600 text-sm flex items-start gap-2">
              <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
              <div>
                <strong>Authentication failed:</strong> {errorMessage}
              </div>
            </div>
          )}

          {/* Authentication form (only show when not authenticated) */}
          {authStatus !== 'authenticated' && (
            <>
              {/* Method tabs (only if multiple methods enabled) */}
              {enabledMethods.length > 1 && (
                <div className="flex gap-1 mb-4 border-b border-amber-200">
                  {enableCredentials && (
                    <button
                      onClick={() => setAuthMethod('credentials')}
                      className={`px-4 py-2 text-sm font-medium transition-colors ${
                        authMethod === 'credentials'
                          ? 'text-amber-700 border-b-2 border-amber-500 -mb-px'
                          : 'text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      <KeyRound className="size-4 inline mr-2" />
                      Static Credentials
                    </button>
                  )}
                  {enableSso && (
                    <button
                      onClick={() => setAuthMethod('sso')}
                      className={`px-4 py-2 text-sm font-medium transition-colors ${
                        authMethod === 'sso'
                          ? 'text-amber-700 border-b-2 border-amber-500 -mb-px'
                          : 'text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      <ExternalLink className="size-4 inline mr-2" />
                      AWS SSO
                    </button>
                  )}
                  {enableProfile && (
                    <button
                      onClick={() => setAuthMethod('profile')}
                      className={`px-4 py-2 text-sm font-medium transition-colors ${
                        authMethod === 'profile'
                          ? 'text-amber-700 border-b-2 border-amber-500 -mb-px'
                          : 'text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      <User className="size-4 inline mr-2" />
                      Local Profile
                    </button>
                  )}
                </div>
              )}

              {/* Static Credentials Form */}
              {authMethod === 'credentials' && enableCredentials && (
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Access Key ID <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={accessKeyId}
                      onChange={(e) => setAccessKeyId(e.target.value)}
                      placeholder="AKIAIOSFODNN7EXAMPLE"
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-500 font-mono text-sm"
                      disabled={authStatus === 'authenticating'}
                    />
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Secret Access Key <span className="text-red-500">*</span>
                    </label>
                    <div className="relative">
                      <input
                        type={showSecretKey ? 'text' : 'password'}
                        value={secretAccessKey}
                        onChange={(e) => setSecretAccessKey(e.target.value)}
                        placeholder="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-500 font-mono text-sm pr-10"
                        disabled={authStatus === 'authenticating'}
                      />
                      <button
                        type="button"
                        onClick={() => setShowSecretKey(!showSecretKey)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                      >
                        {showSecretKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                      </button>
                    </div>
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Session Token <span className="text-gray-400">(optional)</span>
                    </label>
                    <div className="relative">
                      <input
                        type={showSessionToken ? 'text' : 'password'}
                        value={sessionToken}
                        onChange={(e) => setSessionToken(e.target.value)}
                        placeholder="For temporary credentials only"
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-500 font-mono text-sm pr-10"
                        disabled={authStatus === 'authenticating'}
                      />
                      <button
                        type="button"
                        onClick={() => setShowSessionToken(!showSessionToken)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                      >
                        {showSessionToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                      </button>
                    </div>
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Region
                    </label>
                    <select
                      value={selectedRegion}
                      onChange={(e) => setSelectedRegion(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-500"
                      disabled={authStatus === 'authenticating'}
                    >
                      <option value="us-east-1">US East (N. Virginia)</option>
                      <option value="us-east-2">US East (Ohio)</option>
                      <option value="us-west-1">US West (N. California)</option>
                      <option value="us-west-2">US West (Oregon)</option>
                      <option value="eu-west-1">Europe (Ireland)</option>
                      <option value="eu-west-2">Europe (London)</option>
                      <option value="eu-central-1">Europe (Frankfurt)</option>
                      <option value="ap-northeast-1">Asia Pacific (Tokyo)</option>
                      <option value="ap-southeast-1">Asia Pacific (Singapore)</option>
                      <option value="ap-southeast-2">Asia Pacific (Sydney)</option>
                    </select>
                  </div>

                  <Button
                    onClick={handleCredentialsSubmit}
                    disabled={authStatus === 'authenticating' || !accessKeyId || !secretAccessKey}
                    className="bg-amber-600 hover:bg-amber-700 text-white"
                  >
                    {authStatus === 'authenticating' ? (
                      <>
                        <Loader2 className="size-4 mr-2 animate-spin" />
                        Validating...
                      </>
                    ) : (
                      'Authenticate'
                    )}
                  </Button>
                </div>
              )}

              {/* SSO Authentication */}
              {authMethod === 'sso' && enableSso && (
                <div className="space-y-4">
                  {ssoStartUrl ? (
                    <>
                      <div className="bg-amber-100/50 rounded p-3 text-sm text-gray-700">
                        <p className="mb-2">
                          Click the button below to open AWS SSO in your browser. After authenticating, you'll be redirected back here.
                        </p>
                        <div className="font-mono text-xs text-gray-500 truncate">
                          {ssoStartUrl}
                        </div>
                      </div>
                      
                      <Button
                        onClick={handleSsoAuth}
                        disabled={authStatus === 'authenticating'}
                        className="bg-amber-600 hover:bg-amber-700 text-white"
                      >
                        {authStatus === 'authenticating' ? (
                          <>
                            <Loader2 className="size-4 mr-2 animate-spin" />
                            Waiting for browser authentication...
                          </>
                        ) : (
                          <>
                            <ExternalLink className="size-4 mr-2" />
                            Sign in with AWS SSO
                          </>
                        )}
                      </Button>
                    </>
                  ) : (
                    <div className="text-amber-700 text-sm flex items-start gap-2">
                      <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
                      <div>
                        SSO Start URL is not configured. Add <code className="bg-amber-100 px-1 rounded">ssoStartUrl</code> prop to enable SSO authentication.
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Profile Selection */}
              {authMethod === 'profile' && enableProfile && (
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Select AWS Profile
                    </label>
                    {loadingProfiles ? (
                      <div className="flex items-center gap-2 text-gray-500 text-sm py-2">
                        <Loader2 className="size-4 animate-spin" />
                        Loading profiles from ~/.aws/credentials...
                      </div>
                    ) : profiles.length > 0 ? (
                      <select
                        value={selectedProfile}
                        onChange={(e) => setSelectedProfile(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-500"
                        disabled={authStatus === 'authenticating'}
                      >
                        {profiles.map((profile) => (
                          <option key={profile} value={profile}>
                            {profile}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <div className="text-gray-500 text-sm py-2">
                        No AWS profiles found in ~/.aws/credentials or ~/.aws/config
                      </div>
                    )}
                  </div>
                  
                  <Button
                    onClick={handleProfileAuth}
                    disabled={authStatus === 'authenticating' || !selectedProfile}
                    className="bg-amber-600 hover:bg-amber-700 text-white"
                  >
                    {authStatus === 'authenticating' ? (
                      <>
                        <Loader2 className="size-4 mr-2 animate-spin" />
                        Authenticating...
                      </>
                    ) : (
                      'Use Selected Profile'
                    )}
                  </Button>
                  
                  <button
                    onClick={loadAwsProfiles}
                    className="text-sm text-amber-600 hover:text-amber-700 hover:underline"
                    disabled={loadingProfiles}
                  >
                    Refresh profiles
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// Set displayName for React DevTools and component detection
AwsAuth.displayName = 'AwsAuth'

export default AwsAuth

