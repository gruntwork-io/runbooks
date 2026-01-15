import { useState, useEffect, useCallback, useRef } from "react"
import { CheckCircle, XCircle, Loader2, KeyRound, ExternalLink, User, Eye, EyeOff, AlertTriangle, Check, ChevronsUpDown, Info } from "lucide-react"
import { Button } from "@/components/ui/button"
import { InlineMarkdown } from "@/components/mdx/_shared/components/InlineMarkdown"
import { useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { useTelemetry } from "@/contexts/useTelemetry"
import { useBlockVariables } from "@/contexts/useBlockVariables"
import { useSession } from "@/contexts/useSession"
import type { BoilerplateConfig } from "@/types/boilerplateConfig"
import { BoilerplateVariableType } from "@/types/boilerplateVariable"
import { cn } from "@/lib/utils"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

// Complete list of AWS regions
const AWS_REGIONS = [
  // United States
  { code: "us-east-1", name: "US East (N. Virginia)", geography: "United States" },
  { code: "us-east-2", name: "US East (Ohio)", geography: "United States" },
  { code: "us-west-1", name: "US West (N. California)", geography: "United States" },
  { code: "us-west-2", name: "US West (Oregon)", geography: "United States" },
  // Africa
  { code: "af-south-1", name: "Africa (Cape Town)", geography: "South Africa" },
  // Asia Pacific
  { code: "ap-east-1", name: "Asia Pacific (Hong Kong)", geography: "Hong Kong" },
  { code: "ap-east-2", name: "Asia Pacific (Taipei)", geography: "Taiwan" },
  { code: "ap-south-1", name: "Asia Pacific (Mumbai)", geography: "India" },
  { code: "ap-south-2", name: "Asia Pacific (Hyderabad)", geography: "India" },
  { code: "ap-southeast-1", name: "Asia Pacific (Singapore)", geography: "Singapore" },
  { code: "ap-southeast-2", name: "Asia Pacific (Sydney)", geography: "Australia" },
  { code: "ap-southeast-3", name: "Asia Pacific (Jakarta)", geography: "Indonesia" },
  { code: "ap-southeast-4", name: "Asia Pacific (Melbourne)", geography: "Australia" },
  { code: "ap-southeast-5", name: "Asia Pacific (Malaysia)", geography: "Malaysia" },
  { code: "ap-southeast-6", name: "Asia Pacific (New Zealand)", geography: "New Zealand" },
  { code: "ap-southeast-7", name: "Asia Pacific (Thailand)", geography: "Thailand" },
  { code: "ap-northeast-1", name: "Asia Pacific (Tokyo)", geography: "Japan" },
  { code: "ap-northeast-2", name: "Asia Pacific (Seoul)", geography: "South Korea" },
  { code: "ap-northeast-3", name: "Asia Pacific (Osaka)", geography: "Japan" },
  // Canada
  { code: "ca-central-1", name: "Canada (Central)", geography: "Canada" },
  { code: "ca-west-1", name: "Canada West (Calgary)", geography: "Canada" },
  // Europe
  { code: "eu-central-1", name: "Europe (Frankfurt)", geography: "Germany" },
  { code: "eu-central-2", name: "Europe (Zurich)", geography: "Switzerland" },
  { code: "eu-west-1", name: "Europe (Ireland)", geography: "Ireland" },
  { code: "eu-west-2", name: "Europe (London)", geography: "United Kingdom" },
  { code: "eu-west-3", name: "Europe (Paris)", geography: "France" },
  { code: "eu-south-1", name: "Europe (Milan)", geography: "Italy" },
  { code: "eu-south-2", name: "Europe (Spain)", geography: "Spain" },
  { code: "eu-north-1", name: "Europe (Stockholm)", geography: "Sweden" },
  // Israel
  { code: "il-central-1", name: "Israel (Tel Aviv)", geography: "Israel" },
  // Mexico
  { code: "mx-central-1", name: "Mexico (Central)", geography: "Mexico" },
  // Middle East
  { code: "me-south-1", name: "Middle East (Bahrain)", geography: "Bahrain" },
  { code: "me-central-1", name: "Middle East (UAE)", geography: "United Arab Emirates" },
  // South America
  { code: "sa-east-1", name: "South America (São Paulo)", geography: "Brazil" },
] as const

type AuthMethod = 'credentials' | 'sso' | 'profile'
type AuthStatus = 'pending' | 'authenticating' | 'authenticated' | 'failed' | 'select_account' | 'select_role'

// SSO account and role types
interface SSOAccount {
  accountId: string
  accountName: string
  emailAddress: string
}

interface SSORole {
  roleName: string
}

interface AwsAuthProps {
  id: string
  title?: string
  description?: string
  /** AWS SSO start URL for SSO authentication */
  ssoStartUrl?: string
  /** AWS SSO region - the region where your IAM Identity Center is configured */
  ssoRegion?: string
  /** AWS SSO account ID to select after authentication */
  ssoAccountId?: string
  /** AWS SSO role name to assume */
  ssoRoleName?: string
  /** Default AWS region for CLI commands that don't specify a region */
  defaultRegion?: string
  /** @deprecated Use defaultRegion instead */
  region?: string
  /** Enable static credentials input */
  enableCredentials?: boolean
  /** Enable AWS SSO authentication */
  enableSso?: boolean
  /** Enable profile selection */
  enableProfile?: boolean
}

// Reusable Default Region Picker component with tooltip
interface DefaultRegionPickerProps {
  selectedRegion: string
  setSelectedRegion: (region: string) => void
  disabled?: boolean
}

function DefaultRegionPicker({ selectedRegion, setSelectedRegion, disabled }: DefaultRegionPickerProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const listRef = useRef<HTMLDivElement>(null)
  
  // Scroll to top whenever search changes or popover opens
  useEffect(() => {
    if (open && listRef.current) {
      listRef.current.scrollTo({ top: 0 })
    }
  }, [open, search])
  
  return (
    <div>
      <label className="text-sm font-medium text-gray-700 mb-1 flex items-center gap-1.5">
        Default Region
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className="text-gray-400 hover:text-gray-600 cursor-help">
              <Info className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-[280px]">
            This is the AWS region used by CLI commands that don't explicitly specify a region. This sets the <code>AWS_REGION</code> environment variable.
          </TooltipContent>
        </Tooltip>
      </label>
      <Popover open={open} onOpenChange={(isOpen) => {
        setOpen(isOpen)
        if (!isOpen) setSearch("") // Reset search when closing
      }}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between font-normal bg-white border-gray-300 hover:bg-gray-50"
            disabled={disabled}
          >
            {selectedRegion ? (
              <span className="flex items-center gap-2 truncate">
                <span className="font-mono text-xs text-gray-500">{selectedRegion}</span>
                <span className="text-gray-700">
                  {AWS_REGIONS.find((r) => r.code === selectedRegion)?.name}
                </span>
              </span>
            ) : (
              "Select region..."
            )}
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[400px] p-0" align="start" side="bottom" avoidCollisions={false}>
          <Command>
            <CommandInput 
              placeholder="Search regions..." 
              value={search}
              onValueChange={setSearch}
            />
            <CommandList ref={listRef} className="max-h-[300px]">
              <CommandEmpty>No region found.</CommandEmpty>
              <CommandGroup>
                {AWS_REGIONS.map((region) => (
                  <CommandItem
                    key={region.code}
                    value={`${region.code} ${region.name} ${region.geography}`}
                    onSelect={() => {
                      setSelectedRegion(region.code)
                      setOpen(false)
                    }}
                    className="flex items-center gap-2"
                  >
                    <Check
                      className={cn(
                        "h-4 w-4 shrink-0",
                        selectedRegion === region.code ? "opacity-100" : "opacity-0"
                      )}
                    />
                    <span className="font-mono text-xs text-gray-500 w-[120px] shrink-0">
                      {region.code}
                    </span>
                    <span className="text-gray-700 truncate">
                      {region.name}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
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
  defaultRegion,
  region,
  enableCredentials = true,
  enableSso = true,
  enableProfile = true,
}: AwsAuthProps) {
  // Support both defaultRegion and deprecated region prop
  const effectiveDefaultRegion = defaultRegion ?? region ?? "us-east-1"
  // Check for duplicate component IDs
  const { isDuplicate } = useComponentIdRegistry(id, 'AwsAuth')
  
  // Error reporting context
  const { reportError, clearError } = useErrorReporting()
  
  // Telemetry context
  const { trackBlockRender } = useTelemetry()

  // Block variables context for sharing credentials with other blocks
  const { registerInputs } = useBlockVariables()
  
  // Session context for setting environment variables in the persistent session
  const { getAuthHeader } = useSession()

  // State
  const [authMethod, setAuthMethod] = useState<AuthMethod>('credentials')
  const [authStatus, setAuthStatus] = useState<AuthStatus>('pending')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [accountInfo, setAccountInfo] = useState<{ accountId?: string; arn?: string } | null>(null)

  // Credentials form state
  const [accessKeyId, setAccessKeyId] = useState('')
  const [secretAccessKey, setSecretAccessKey] = useState('')
  const [sessionToken, setSessionToken] = useState('')
  const [selectedDefaultRegion, setSelectedDefaultRegion] = useState(effectiveDefaultRegion)
  const [showSecretKey, setShowSecretKey] = useState(false)
  const [showSessionToken, setShowSessionToken] = useState(false)

  // Profile state
  const [profiles, setProfiles] = useState<string[]>([])
  const [selectedProfile, setSelectedProfile] = useState<string>('')
  const [loadingProfiles, setLoadingProfiles] = useState(false)

  // SSO account/role selection state
  const [ssoAccessToken, setSsoAccessToken] = useState<string | null>(null)
  const [ssoAccounts, setSsoAccounts] = useState<SSOAccount[]>([])
  const [ssoRoles, setSsoRoles] = useState<SSORole[]>([])
  const [selectedSsoAccount, setSelectedSsoAccount] = useState<SSOAccount | null>(null)
  const [selectedSsoRole, setSelectedSsoRole] = useState<string>('')
  const [loadingRoles, setLoadingRoles] = useState(false)

  // SSO polling cancellation
  const ssoPollingCancelledRef = useRef(false)

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

  // Register credentials with BlockVariables and session environment when authenticated
  const registerCredentials = useCallback(async (creds: {
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
    
    // Register with BlockVariables for template variable substitution
    registerInputs(id, values, createAwsCredentialsConfig())
    
    // Also set in session environment so all subsequent scripts have access
    // without needing to use inputsId or template syntax
    try {
      const envVars: Record<string, string> = {
        AWS_ACCESS_KEY_ID: creds.accessKeyId,
        AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
        AWS_REGION: creds.region,
      }
      if (creds.sessionToken) {
        envVars.AWS_SESSION_TOKEN = creds.sessionToken
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
      // Non-critical: log but don't fail auth
      console.error('Failed to set session environment variables:', error)
    }
  }, [id, registerInputs, getAuthHeader])

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
      region: selectedDefaultRegion
    })
  }

  // Handle SSO authentication
  const handleSsoAuth = async () => {
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
      // Check if polling was cancelled
      if (ssoPollingCancelledRef.current) {
        return
      }

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

        // Check again after fetch in case it was cancelled while waiting
        if (ssoPollingCancelledRef.current) {
          return
        }

        const data = await response.json()

        if (data.status === 'pending' && attempts < maxAttempts) {
          attempts++
          setTimeout(poll, 2000)
        } else if (data.status === 'select_account') {
          // User needs to select an account/role
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
        // Don't show error if polling was cancelled
        if (ssoPollingCancelledRef.current) {
          return
        }
        setAuthStatus('failed')
        setErrorMessage(error instanceof Error ? error.message : 'Failed to poll SSO status')
      }
    }

    poll()
  }

  // Handle SSO account selection - load roles for selected account
  const handleSsoAccountSelect = async (account: SSOAccount) => {
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
        // If only one role, auto-select it
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
  }

  // Complete SSO authentication with selected account and role
  const handleSsoComplete = async () => {
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
  }

  // Go back to account selection
  const handleBackToAccountSelection = () => {
    setSelectedSsoAccount(null)
    setSelectedSsoRole('')
    setSsoRoles([])
    setAuthStatus('select_account')
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
          region: data.region || selectedDefaultRegion
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
    // Clear SSO selection state
    setSsoAccessToken(null)
    setSsoAccounts([])
    setSsoRoles([])
    setSelectedSsoAccount(null)
    setSelectedSsoRole('')
  }

  // Cancel SSO authentication
  const handleCancelSsoAuth = () => {
    ssoPollingCancelledRef.current = true
    setAuthStatus('pending')
    setErrorMessage(null)
  }

  // Get status-based styling
  const getStatusClasses = () => {
    const statusMap: Record<AuthStatus, string> = {
      authenticated: 'bg-green-50 border-green-200',
      failed: 'bg-red-50 border-red-200',
      authenticating: 'bg-amber-50 border-amber-200',
      pending: 'bg-amber-50/50 border-amber-200',
      select_account: 'bg-blue-50 border-blue-200',
      select_role: 'bg-blue-50 border-blue-200',
    }
    return statusMap[authStatus]
  }

  const getStatusIcon = () => {
    const iconMap: Record<AuthStatus, typeof CheckCircle> = {
      authenticated: CheckCircle,
      failed: XCircle,
      authenticating: Loader2,
      pending: KeyRound,
      select_account: User,
      select_role: User,
    }
    return iconMap[authStatus]
  }

  const getStatusIconClasses = () => {
    const colorMap: Record<AuthStatus, string> = {
      authenticated: 'text-green-600',
      failed: 'text-red-600',
      authenticating: 'text-amber-600',
      pending: 'text-amber-600',
      select_account: 'text-blue-600',
      select_role: 'text-blue-600',
    }
    return colorMap[authStatus]
  }

  // Count enabled methods
  const enabledMethods = [enableCredentials, enableSso, enableProfile].filter(Boolean)

  // Early return for duplicate ID
  if (isDuplicate) {
    return (
      <div className="runbook-block relative rounded-sm border bg-red-50 border-red-200 mb-5 p-4">
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
    <div className={`runbook-block relative rounded-sm border ${statusClasses} mb-5 p-4`}>
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

          {/* Authentication form (only show when not authenticated and not in account/role selection) */}
          {authStatus !== 'authenticated' && (
            <>
              {/* Method tabs (only if multiple methods enabled and not in account/role selection) */}
              {enabledMethods.length > 1 && authStatus !== 'select_account' && authStatus !== 'select_role' && (
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
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-500 font-mono text-sm placeholder-gray-400"
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
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-500 font-mono text-sm pr-10 placeholder-gray-400"
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
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-500 font-mono text-sm pr-10 placeholder-gray-400"
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
                  
                  <DefaultRegionPicker
                    selectedRegion={selectedDefaultRegion}
                    setSelectedRegion={setSelectedDefaultRegion}
                    disabled={authStatus === 'authenticating'}
                  />

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
              {authMethod === 'sso' && enableSso && authStatus !== 'select_account' && authStatus !== 'select_role' && (
                <div className="space-y-4">
                  {ssoStartUrl ? (
                    <>
                      <div className="bg-amber-100/50 rounded p-3 text-sm text-gray-700">
                        {authStatus === 'authenticating' ? (
                            <p>
                              Complete the authorization request in the applicable browser tab.<br/>
                              <span className="text-gray-500 text-xs mt-1 block">
                                Note: If you cancelled on AWS, click the Cancel button below — AWS doesn't notify this page when you cancel.
                              </span>
                            </p>                        
                        ) : (
                          <>
                            <p className="mb-2">
                              Click the button below to open AWS IAM Identity Center (formerly AWS SSO) in your browser. After authenticating, you'll be redirected back here.
                            </p>
                            <div className="font-mono text-xs text-gray-500 truncate">
                              {ssoStartUrl}
                            </div>
                          </>
                        )}
                      </div>

                      <DefaultRegionPicker
                        selectedRegion={selectedDefaultRegion}
                        setSelectedRegion={setSelectedDefaultRegion}
                        disabled={authStatus === 'authenticating'}
                      />
                      
                      <div className="flex gap-2">
                        <Button
                          onClick={handleSsoAuth}
                          disabled={authStatus === 'authenticating'}
                          className="bg-amber-600 hover:bg-amber-700 text-white"
                        >
                          {authStatus === 'authenticating' ? (
                            <>
                              <Loader2 className="size-4 animate-spin" />
                              Waiting for browser authentication...
                            </>
                          ) : (
                            <>
                              <ExternalLink className="size-4" />
                              Sign in with SSO
                            </>
                          )}
                        </Button>
                        
                        {authStatus === 'authenticating' && (
                          <Button
                            onClick={handleCancelSsoAuth}
                            variant="outline"
                            className="border-gray-300 text-gray-700 hover:bg-gray-100"
                          >
                            <XCircle className="size-4" />
                            Cancel
                          </Button>
                        )}
                      </div>
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

              {/* SSO Account Selection */}
              {authStatus === 'select_account' && (
                <div className="space-y-4">
                  <div className="text-blue-700 font-semibold text-sm mb-2">
                    ✓ SSO authentication successful
                  </div>
                  <div className="bg-blue-100/50 rounded p-3 text-sm text-gray-700">
                    <p>Select an AWS account to continue:</p>
                  </div>
                  
                  <div className="space-y-2">
                    {ssoAccounts.map((account) => (
                      <button
                        key={account.accountId}
                        onClick={() => handleSsoAccountSelect(account)}
                        disabled={loadingRoles}
                        className={`w-full text-left px-4 py-3 rounded-md border transition-colors cursor-pointer ${
                          loadingRoles && selectedSsoAccount?.accountId === account.accountId
                            ? 'bg-blue-100 border-blue-300'
                            : 'bg-white border-gray-200 hover:bg-blue-50 hover:border-blue-300'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="font-medium text-gray-900">{account.accountName}</div>
                            <div className="text-sm text-gray-500">
                              {account.accountId}
                              {account.emailAddress && ` • ${account.emailAddress}`}
                            </div>
                          </div>
                          {loadingRoles && selectedSsoAccount?.accountId === account.accountId && (
                            <Loader2 className="size-4 animate-spin text-blue-600" />
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                  
                  <Button
                    onClick={handleReset}
                    variant="outline"
                    className="border-gray-300 text-gray-700 hover:bg-gray-100"
                  >
                    Cancel
                  </Button>
                </div>
              )}

              {/* SSO Role Selection */}
              {authStatus === 'select_role' && selectedSsoAccount && (
                <div className="space-y-4">
                  <div className="text-blue-700 font-semibold text-sm mb-2">
                    ✓ Account selected: {selectedSsoAccount.accountName}
                  </div>
                  <div className="bg-blue-100/50 rounded p-3 text-sm text-gray-700">
                    <p>Select a role to assume:</p>
                  </div>
                  
                  <div className="space-y-2">
                    {ssoRoles.map((role) => (
                      <button
                        key={role.roleName}
                        onClick={() => setSelectedSsoRole(role.roleName)}
                        className={`w-full text-left px-4 py-3 rounded-md border transition-colors cursor-pointer ${
                          selectedSsoRole === role.roleName
                            ? 'bg-blue-100 border-blue-400 ring-2 ring-blue-200'
                            : 'bg-white border-gray-200 hover:bg-blue-50 hover:border-blue-300'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <Check
                            className={cn(
                              "h-4 w-4 shrink-0",
                              selectedSsoRole === role.roleName ? "opacity-100 text-blue-600" : "opacity-0"
                            )}
                          />
                          <span className="font-medium text-gray-900">{role.roleName}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                  
                  <div className="flex gap-2">
                    <Button
                      onClick={handleSsoComplete}
                      disabled={!selectedSsoRole}
                      className="bg-blue-600 hover:bg-blue-700 text-white"
                    >
                      Continue
                    </Button>
                    <Button
                      onClick={handleBackToAccountSelection}
                      variant="outline"
                      className="border-gray-300 text-gray-700 hover:bg-gray-100"
                    >
                      Back
                    </Button>
                  </div>
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

                  <DefaultRegionPicker
                    selectedRegion={selectedDefaultRegion}
                    setSelectedRegion={setSelectedDefaultRegion}
                    disabled={authStatus === 'authenticating'}
                  />
                  
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

