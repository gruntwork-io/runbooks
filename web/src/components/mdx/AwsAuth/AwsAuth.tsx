import { useEffect } from "react"
import { XCircle, AlertTriangle, Loader2 } from "lucide-react"
import { InlineMarkdown } from "@/components/mdx/_shared/components/InlineMarkdown"
import { BlockIdLabel } from "@/components/mdx/_shared"
import { useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { useTelemetry } from "@/contexts/useTelemetry"

import type { AwsAuthProps } from "./types"
import { useAwsAuth } from "./hooks/useAwsAuth"
import { getStatusClasses, getStatusIcon, getStatusIconClasses } from "./utils"
import { AuthTabs } from "./components/AuthTabs"
import { AuthSuccess } from "./components/AuthSuccess"
import { CredentialsForm } from "./components/CredentialsForm"
import { SsoForm, SsoAccountSelector, SsoRoleSelector } from "./components/SsoFlow"
import { ProfileSelector } from "./components/ProfileSelector"
import { DetectedCredentialsPrompt } from "./components/DetectedCredentialsPrompt"

function AwsAuth({
  id,
  title = "AWS Authentication",
  description,
  ssoStartUrl,
  ssoRegion = "us-east-1",
  ssoAccountId,
  ssoRoleName,
  defaultRegion = "us-east-1",
  detectCredentials = ['env'],  // Default: auto-detect from env vars
}: AwsAuthProps) {
  
  // Check for duplicate component IDs (including normalized collisions like "a-b" vs "a_b")
  const { isDuplicate, isNormalizedCollision, collidingId } = useComponentIdRegistry(id, 'AwsAuth')
  
  // Error reporting context (for configuration errors only)
  const { reportError, clearError } = useErrorReporting()
  
  // Telemetry context
  const { trackBlockRender } = useTelemetry()

  // All auth state and handlers from custom hook
  const auth = useAwsAuth({
    id,
    ssoStartUrl,
    ssoRegion,
    ssoAccountId,
    ssoRoleName,
    defaultRegion,
    detectCredentials,
  })

  // Track block render on mount
  useEffect(() => {
    trackBlockRender('AwsAuth')
  }, [trackBlockRender])

  // Load available profiles when profile tab is selected
  const { authMethod, profiles, loadAwsProfiles } = auth
  useEffect(() => {
    if (authMethod === 'profile' && profiles.length === 0) {
      loadAwsProfiles()
    }
  }, [authMethod, profiles.length, loadAwsProfiles])

  // Report configuration errors only
  useEffect(() => {
    if (isDuplicate) {
      reportError({
        componentId: id,
        componentType: 'AwsAuth',
        severity: 'error',
        message: `Duplicate component ID: ${id}`
      })
    } else {
      clearError(id)
    }
  }, [id, isDuplicate, reportError, clearError])

  // Early return for duplicate ID
  if (isDuplicate) {
    return (
      <div className="runbook-block relative rounded-sm border bg-red-50 border-red-200 mb-5 p-4">
        <div className="flex items-center text-red-600">
          <XCircle className="size-6 mr-4 flex-shrink-0" />
          <div className="text-md">
            {isNormalizedCollision ? (
              <>
                <strong>ID Collision:</strong><br />
                The ID <code className="bg-red-100 px-1 rounded">{`"${id}"`}</code> collides with <code className="bg-red-100 px-1 rounded">{`"${collidingId}"`}</code> because 
                hyphens are converted to underscores for template access.
                Use different IDs to avoid this collision.
              </>
            ) : (
              <>
                <strong>Duplicate Component ID:</strong><br />
                Another <code className="bg-red-100 px-1 rounded">{"<AwsAuth>"}</code> component with id <code className="bg-red-100 px-1 rounded">{`"${id}"`}</code> already exists.
              </>
            )}
          </div>
        </div>
      </div>
    )
  }

  const IconComponent = getStatusIcon(auth.authStatus)
  const statusClasses = getStatusClasses(auth.authStatus)
  const iconClasses = getStatusIconClasses(auth.authStatus)

  const showTabs = auth.authStatus !== 'select_account' && auth.authStatus !== 'select_role'
  const showSsoAccountSelector = auth.authStatus === 'select_account'
  const showSsoRoleSelector = auth.authStatus === 'select_role' && auth.selectedSsoAccount

  return (
    <div className={`runbook-block relative rounded-sm border ${statusClasses} mb-5 p-4`}>
      {/* ID label - positioned at top right */}
      <div className="absolute top-3 right-3 z-20">
        <BlockIdLabel id={id} size="large" />
      </div>

      {/* Header with AWS Logo */}
      <div className="flex items-start gap-4 @container">
        <div className="border-r border-amber-300 pr-3 mr-0 self-stretch">
          <IconComponent className={`size-6 ${iconClasses} ${auth.authStatus === 'authenticating' ? 'animate-spin' : ''}`} />
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

          {/* Detection pending state - waiting for block or checking credentials */}
          {auth.detectionStatus === 'pending' && (
            <div className="mb-4 text-blue-600 text-sm flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" />
              <span>
                {auth.waitingForBlockId 
                  ? `Waiting for "${auth.waitingForBlockId}" to run...`
                  : 'Checking for existing credentials...'}
              </span>
            </div>
          )}

          {/* Detected credentials confirmation prompt */}
          {auth.detectionStatus === 'detected' && auth.detectedCredentials && (
            <DetectedCredentialsPrompt
              credentials={auth.detectedCredentials}
              warning={auth.detectionWarning}
              onConfirm={auth.handleConfirmDetected}
              onReject={auth.handleRejectDetected}
            />
          )}

          {/* Success state */}
          {auth.authStatus === 'authenticated' && auth.accountInfo && (
            <AuthSuccess
              accountInfo={auth.accountInfo}
              warningMessage={auth.warningMessage}
              detectionSource={auth.detectedCredentials?.source}
              onReAuthenticate={auth.handleManualAuth}
            />
          )}

          {/* Detection warning (found credentials but they're invalid) */}
          {auth.detectionWarning && auth.detectionStatus === 'done' && auth.authStatus !== 'authenticated' && (
            <div className="mb-4 bg-amber-50 border border-amber-200 rounded p-3 text-sm text-amber-800 flex items-start gap-2">
              <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
              <div>
                <strong>Invalid credentials detected:</strong> {auth.detectionWarning}
                <br />
                <span className="text-amber-700">Please authenticate manually below.</span>
              </div>
            </div>
          )}

          {/* Error state (for manual auth failures) */}
          {auth.authStatus === 'failed' && auth.errorMessage && (
            <div className="mb-4 text-red-600 text-sm flex items-start gap-2">
              <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
              <div>
                <strong>Authentication failed:</strong> {auth.errorMessage}
              </div>
            </div>
          )}

          {/* Authentication form (only show when not authenticated and detection is done) */}
          {auth.authStatus !== 'authenticated' && auth.detectionStatus === 'done' && (
            <>
              {/* Method tabs (hide during account/role selection) */}
              {showTabs && (
                <AuthTabs
                  authMethod={auth.authMethod}
                  setAuthMethod={(method) => {
                    auth.clearRetryMessage()
                    auth.setAuthMethod(method)
                  }}
                />
              )}

              {/* Static Credentials Form */}
              {auth.authMethod === 'credentials' && showTabs && (
                <CredentialsForm
                  authStatus={auth.authStatus}
                  accessKeyId={auth.accessKeyId}
                  setAccessKeyId={auth.setAccessKeyId}
                  secretAccessKey={auth.secretAccessKey}
                  setSecretAccessKey={auth.setSecretAccessKey}
                  sessionToken={auth.sessionToken}
                  setSessionToken={auth.setSessionToken}
                  selectedDefaultRegion={auth.selectedDefaultRegion}
                  setSelectedDefaultRegion={auth.setSelectedDefaultRegion}
                  showSecretKey={auth.showSecretKey}
                  setShowSecretKey={auth.setShowSecretKey}
                  showSessionToken={auth.showSessionToken}
                  setShowSessionToken={auth.setShowSessionToken}
                  onSubmit={auth.handleCredentialsSubmit}
                />
              )}

              {/* SSO Authentication */}
              {auth.authMethod === 'sso' && showTabs && (
                <SsoForm
                  authStatus={auth.authStatus}
                  ssoStartUrl={ssoStartUrl}
                  selectedDefaultRegion={auth.selectedDefaultRegion}
                  setSelectedDefaultRegion={auth.setSelectedDefaultRegion}
                  onSsoAuth={auth.handleSsoAuth}
                  onCancelSsoAuth={auth.handleCancelSsoAuth}
                />
              )}

              {/* SSO Account Selection */}
              {showSsoAccountSelector && (
                <SsoAccountSelector
                  accounts={auth.ssoAccounts}
                  selectedAccount={auth.selectedSsoAccount}
                  loadingRoles={auth.loadingRoles}
                  searchValue={auth.ssoAccountSearch}
                  setSearchValue={auth.setSsoAccountSearch}
                  onAccountSelect={auth.handleSsoAccountSelect}
                  onCancel={auth.handleManualAuth}
                />
              )}

              {/* SSO Role Selection */}
              {showSsoRoleSelector && (
                <SsoRoleSelector
                  selectedAccount={auth.selectedSsoAccount!}
                  roles={auth.ssoRoles}
                  selectedRole={auth.selectedSsoRole}
                  setSelectedRole={auth.setSelectedSsoRole}
                  searchValue={auth.ssoRoleSearch}
                  setSearchValue={auth.setSsoRoleSearch}
                  onComplete={auth.handleSsoComplete}
                  onBack={auth.handleBackToAccountSelection}
                />
              )}

              {/* Profile Selection */}
              {auth.authMethod === 'profile' && showTabs && (
                <ProfileSelector
                  authStatus={auth.authStatus}
                  profiles={auth.profiles}
                  selectedProfile={auth.selectedProfile}
                  setSelectedProfile={auth.setSelectedProfile}
                  loadingProfiles={auth.loadingProfiles}
                  profileSearch={auth.profileSearch}
                  setProfileSearch={auth.setProfileSearch}
                  selectedDefaultRegion={auth.selectedDefaultRegion}
                  setSelectedDefaultRegion={auth.setSelectedDefaultRegion}
                  onProfileAuth={auth.handleProfileAuth}
                  onRefreshProfiles={auth.loadAwsProfiles}
                />
              )}

              {/* Option to retry detection when in manual auth mode */}
              {detectCredentials !== false && showTabs && (
                <div className="mt-3 text-sm text-gray-600 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={auth.handleRetryDetection}
                    className="text-blue-600 hover:text-blue-800 hover:underline cursor-pointer"
                  >
                    ← Try auto-detection again
                  </button>
                  {auth.retryFoundNothing && (
                    <span className="text-gray-500 italic">No credentials found</span>
                  )}
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
