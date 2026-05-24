import { useEffect, useMemo } from "react"
import { XCircle, AlertTriangle, Loader2 } from "lucide-react"
import awsLogo from '@/assets/aws-logo.svg'
import awsLogoLight from '@/assets/aws-logo-light.svg'
import { InlineMarkdown } from "@/components/mdx/_shared/components/InlineMarkdown"
import { BlockIdLabel } from "@/components/mdx/_shared"
import { useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { useTelemetry } from "@/contexts/useTelemetry"
import { useTemplateContext } from "@/contexts/useRunbook"
import { useTheme } from "@/contexts/useTheme"
import { useInstructionMode } from "@/contexts/useInstructionMode"
import { resolveTemplateReferences } from "@/lib/templateUtils"
import { AwsAuthInstruction } from "./AwsAuthInstruction"

import { ErrorDisplay } from "@/components/mdx/_shared/components/ErrorDisplay"
import type { AppError } from "@/types/error"
import type { AwsAuthProps } from "./types"
import { useAwsAuth } from "./hooks/useAwsAuth"
import { getStatusClasses, getStatusIcon, getStatusIconClasses } from "./utils"
import { AuthTabs } from "./components/AuthTabs"
import { AuthSuccess } from "./components/AuthSuccess"
import { CredentialsForm } from "./components/CredentialsForm"
import { SsoForm, SsoAccountSelector, SsoRoleSelector } from "./components/SsoFlow"
import { ProfileSelector } from "./components/ProfileSelector"
import { DetectedCredentialsPrompt } from "./components/DetectedCredentialsPrompt"

function AwsAuthInteractive({
  id,
  title = "AWS Authentication",
  description,
  ssoStartUrl,
  ssoRegion = "us-east-1",
  ssoAccountId,
  ssoRoleName,
  defaultRegion = "us-east-1",
  detectCredentials = ['env'],  // Default: auto-detect from env vars
  inputsId,
}: AwsAuthProps) {
  // Validate required props
  const validationError = useMemo((): AppError | null => {
    if (!id) {
      return {
        message: "The <AwsAuth> component requires a non-empty 'id' prop.",
        details: "Please provide a unique 'id' for this component instance."
      }
    }
    return null
  }, [id])

  // Resolve template expressions in display props
  const templateCtx = useTemplateContext(inputsId)
  const resolvedTitle = useMemo(() => title ? resolveTemplateReferences(title, templateCtx) : title, [title, templateCtx])
  const resolvedDescription = useMemo(() => description ? resolveTemplateReferences(description, templateCtx) : description, [description, templateCtx])

  // Check for duplicate component IDs (including normalized collisions like "a-b" vs "a_b")
  const { isDuplicate, isNormalizedCollision, collidingId } = useComponentIdRegistry(id, 'AwsAuth')
  
  // Validate detectCredentials configuration: only one { block: string } source allowed
  const blockSources = Array.isArray(detectCredentials) 
    ? detectCredentials.filter(s => typeof s === 'object' && 'block' in s) 
    : []
  const hasMultipleBlockSources = blockSources.length > 1
  
  // Error reporting context (for configuration errors only)
  const { reportError, clearError } = useErrorReporting()
  
  // Telemetry context
  const { trackBlockRender } = useTelemetry()

  // Theme — swap the AWS wordmark for its light variant on dark surfaces
  const { resolvedTheme } = useTheme()

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
    } else if (hasMultipleBlockSources) {
      reportError({
        componentId: id,
        componentType: 'AwsAuth',
        severity: 'error',
        message: `Multiple block sources in detectCredentials: only one { block: string } is allowed`
      })
    } else {
      clearError(id)
    }
  }, [id, isDuplicate, hasMultipleBlockSources, reportError, clearError])

  // Early return for validation errors (e.g. missing id prop)
  if (validationError) {
    return <ErrorDisplay error={validationError} />
  }

  // Early return for duplicate ID
  if (isDuplicate) {
    return (
      <div className="runbook-block relative rounded-sm border bg-destructive-muted border-destructive/30 mb-5 p-4">
        <div className="flex items-center text-destructive">
          <XCircle className="size-6 mr-4 flex-shrink-0" />
          <div className="text-md">
            {isNormalizedCollision ? (
              <>
                <strong>ID Collision:</strong><br />
                The ID <code className="bg-destructive-muted px-1 rounded">{`"${id}"`}</code> collides with <code className="bg-destructive-muted px-1 rounded">{`"${collidingId}"`}</code> because 
                hyphens are converted to underscores for template access.
                Use different IDs to avoid this collision.
              </>
            ) : (
              <>
                <strong>Duplicate Component ID:</strong><br />
                Another <code className="bg-destructive-muted px-1 rounded">{"<AwsAuth>"}</code> component with id <code className="bg-destructive-muted px-1 rounded">{`"${id}"`}</code> already exists.
              </>
            )}
          </div>
        </div>
      </div>
    )
  }

  // Early return for multiple block sources in detectCredentials
  if (hasMultipleBlockSources) {
    return (
      <div className="runbook-block relative rounded-sm border bg-destructive-muted border-destructive/30 mb-5 p-4">
        <div className="flex items-center text-destructive">
          <XCircle className="size-6 mr-4 flex-shrink-0" />
          <div className="text-md">
            <strong>Invalid Configuration:</strong><br />
            The <code className="bg-destructive-muted px-1 rounded">detectCredentials</code> prop contains multiple <code className="bg-destructive-muted px-1 rounded">{`{ block: "..." }`}</code> entries.
            Only one block source is allowed.
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
    <div data-testid={id} className={`runbook-block relative rounded-sm border ${statusClasses} mb-5 p-4`}>
      {/* ID label - positioned at top right */}
      <div className="absolute top-3 right-3 z-20">
        <BlockIdLabel id={id} size="large" />
      </div>

      {/* Header with AWS Logo */}
      <div className="flex items-start gap-4 @container">
        <div className="border-r border-warning/30 pr-3 mr-0 self-stretch">
          <IconComponent className={`size-6 ${iconClasses} ${auth.authStatus === 'authenticating' ? 'animate-spin' : ''}`} />
        </div>

        <div className="flex-1">
          {/* Title row with AWS logo */}
          <div className="flex items-center gap-3 mb-2">
            <img src={resolvedTheme === 'dark' ? awsLogoLight : awsLogo} alt="AWS" className="h-6" />
            <div className="text-md font-bold text-foreground">
              <InlineMarkdown>{resolvedTitle}</InlineMarkdown>
            </div>
          </div>
          
          {resolvedDescription && (
            <div className="text-md text-muted-foreground mb-4">
              <InlineMarkdown>{resolvedDescription}</InlineMarkdown>
            </div>
          )}

          {/* Detection pending state - waiting for block or checking credentials */}
          {auth.detectionStatus === 'pending' && (
            <div className="mb-4 text-info text-sm flex items-center gap-2">
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
              confirming={auth.authStatus === 'authenticating'}
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
            <div className="mb-4 bg-warning-muted border border-warning/30 rounded p-3 text-sm text-warning-foreground flex items-start gap-2">
              <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
              <div>
                <strong>Invalid credentials detected:</strong> {auth.detectionWarning}
                <br />
                <span className="text-warning-foreground">Please authenticate manually below.</span>
              </div>
            </div>
          )}

          {/* Error state (for manual auth failures) */}
          {auth.authStatus === 'failed' && auth.errorMessage && (
            <div className="mb-4 text-destructive text-sm flex items-start gap-2">
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
                <div className="mt-3 text-sm text-muted-foreground flex items-center gap-2">
                  <button
                    type="button"
                    onClick={auth.handleRetryDetection}
                    className="text-primary hover:text-primary/80 hover:underline cursor-pointer"
                  >
                    ← Try auto-detection again
                  </button>
                  {auth.retryFoundNothing && (
                    <span className="text-muted-foreground italic">No credentials found</span>
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

/**
 * AwsAuth entry point. A thin wrapper that branches on instruction mode before
 * any auth hooks run: in instruction mode it renders a plain "Log into AWS"
 * instruction (no credential capture); otherwise it renders the interactive
 * authentication UI. Branching here — rather than inside the interactive
 * component — keeps `useAwsAuth` (and its on-mount credential detection) out of
 * the instruction path entirely.
 */
function AwsAuth(props: AwsAuthProps) {
  const { enabled: instructionMode } = useInstructionMode()
  if (instructionMode) {
    return <AwsAuthInstruction {...props} />
  }
  return <AwsAuthInteractive {...props} />
}

// Set displayName for React DevTools and component detection
AwsAuth.displayName = 'AwsAuth'

export default AwsAuth
