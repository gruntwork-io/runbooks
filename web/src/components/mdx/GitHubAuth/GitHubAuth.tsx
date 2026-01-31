import { useEffect, useState } from "react"
import { XCircle, AlertTriangle, Loader2 } from "lucide-react"
import { InlineMarkdown } from "@/components/mdx/_shared/components/InlineMarkdown"
import { BlockIdLabel } from "@/components/mdx/_shared"
import { useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { useTelemetry } from "@/contexts/useTelemetry"
import { Button } from "@/components/ui/button"

import type { GitHubAuthProps } from "./types"
import { useGitHubAuth } from "./hooks/useGitHubAuth"
import { getStatusClasses, getStatusIcon, getStatusIconClasses } from "./utils"
import { AuthTabs } from "./components/AuthTabs"
import { AuthSuccess } from "./components/AuthSuccess"
import { PatForm } from "./components/PatForm"
import { OAuthFlow } from "./components/OAuthFlow"
import { CustomOAuthWarning } from "./components/CustomOAuthWarning"
import { GitHubLogo } from "./components/GitHubLogo"

export function GitHubAuth({
  id,
  title = "GitHub Authentication",
  description,
  oauthClientId,
  oauthScopes = ['repo'],
  prefilledCredentials,
  allowOverridePrefilled = true,
}: GitHubAuthProps) {
  
  // Check for duplicate component IDs
  const { isDuplicate, isNormalizedCollision, collidingId } = useComponentIdRegistry(id, 'GitHubAuth')
  
  // Error reporting context (for configuration errors only)
  const { reportError, clearError } = useErrorReporting()
  
  // Telemetry context
  const { trackBlockRender } = useTelemetry()

  // State for custom OAuth warning
  const [customOAuthDismissed, setCustomOAuthDismissed] = useState(false)
  const [useDefaultOAuth, setUseDefaultOAuth] = useState(false)

  // All auth state and handlers from custom hook
  const auth = useGitHubAuth({
    id,
    oauthClientId: useDefaultOAuth ? undefined : oauthClientId,
    oauthScopes,
    prefilledCredentials,
    allowOverridePrefilled,
  })

  // Track block render on mount
  useEffect(() => {
    trackBlockRender('GitHubAuth')
  }, [trackBlockRender])

  // Report configuration errors only
  useEffect(() => {
    if (isDuplicate) {
      reportError({
        componentId: id,
        componentType: 'GitHubAuth',
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
                Another <code className="bg-red-100 px-1 rounded">{"<GitHubAuth>"}</code> component with id <code className="bg-red-100 px-1 rounded">{`"${id}"`}</code> already exists.
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

  // Show custom OAuth warning if using non-default client ID and not dismissed
  const showCustomOAuthWarning = auth.isCustomClientId && !customOAuthDismissed && !useDefaultOAuth && 
    auth.authStatus !== 'authenticated' && auth.authMethod === 'oauth'

  return (
    <div className={`runbook-block relative rounded-sm border ${statusClasses} mb-5 p-4`}>
      {/* ID label - positioned at top right */}
      <div className="absolute top-3 right-3 z-20">
        <BlockIdLabel id={id} size="large" />
      </div>

      {/* Header with GitHub Logo */}
      <div className="flex items-start gap-4 @container">
        <div className="border-r border-violet-300 pr-3 mr-0 self-stretch">
          <IconComponent className={`size-6 ${iconClasses} ${auth.authStatus === 'authenticating' ? 'animate-spin' : ''}`} />
        </div>

        <div className="flex-1">
          {/* Title row with GitHub icon */}
          <div className="flex items-center gap-1 mb-2">
            <GitHubLogo className="size-6 text-gray-800" />
            <div className="text-md font-bold text-gray-700">
              <InlineMarkdown>{title}</InlineMarkdown>
            </div>
          </div>
          
          {description && (
            <div className="text-md text-gray-600 mb-4">
              <InlineMarkdown>{description}</InlineMarkdown>
            </div>
          )}

          {/* Prefill pending state - waiting for block or checking credentials */}
          {auth.prefillStatus === 'pending' && (
            <div className="mb-4 text-violet-600 text-sm flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" />
              <span>
                {auth.waitingForBlockId 
                  ? `Waiting for "${auth.waitingForBlockId}" to run...`
                  : 'Checking for credentials...'}
              </span>
            </div>
          )}

          {/* Success state */}
          {auth.authStatus === 'authenticated' && auth.userInfo && (
            <AuthSuccess
              userInfo={auth.userInfo}
              prefillSource={auth.prefillSource}
              onReAuthenticate={allowOverridePrefilled ? auth.resetAuth : undefined}
              onManualAuth={allowOverridePrefilled && auth.prefillSource ? auth.switchToManualAuth : undefined}
            />
          )}

          {/* Prefill failed state */}
          {auth.prefillStatus === 'failed' && auth.prefillError && allowOverridePrefilled && (
            <div className="mb-4 bg-amber-50 border border-amber-200 rounded p-3 text-sm text-amber-800 flex items-start gap-2">
              <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
              <div>
                <strong>Could not load prefilled credentials:</strong> {auth.prefillError}
                <br />
                <span className="text-amber-700">Please authenticate manually below.</span>
              </div>
            </div>
          )}

          {/* Prefill failed without override - just show error */}
          {auth.prefillStatus === 'failed' && auth.prefillError && !allowOverridePrefilled && (
            <div className="mb-4 text-red-600 text-sm flex items-start gap-2">
              <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
              <div>
                <strong>Credential prefill failed:</strong> {auth.prefillError}
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

          {/* Authentication form (only show when not authenticated and not pending prefill) */}
          {auth.authStatus !== 'authenticated' && auth.prefillStatus !== 'pending' && (auth.prefillStatus !== 'failed' || allowOverridePrefilled) && (
            <>
              {/* Custom OAuth Warning */}
              {showCustomOAuthWarning && (
                <CustomOAuthWarning
                  clientId={oauthClientId!}
                  onUseDefault={() => setUseDefaultOAuth(true)}
                  onContinue={() => setCustomOAuthDismissed(true)}
                />
              )}

              {/* Method tabs */}
              <AuthTabs
                authMethod={auth.authMethod}
                setAuthMethod={auth.setAuthMethod}
              />

              {/* OAuth Flow */}
              {auth.authMethod === 'oauth' && !showCustomOAuthWarning && (
                <OAuthFlow
                  authStatus={auth.authStatus}
                  effectiveClientId={auth.effectiveClientId}
                  userCode={auth.oauthUserCode}
                  verificationUri={auth.oauthVerificationUri}
                  onStartOAuth={auth.startOAuth}
                  onCancelOAuth={auth.cancelOAuth}
                />
              )}

              {/* PAT Form */}
              {auth.authMethod === 'pat' && (
                <PatForm
                  authStatus={auth.authStatus}
                  patToken={auth.patToken}
                  setPatToken={auth.setPatToken}
                  showPatToken={auth.showPatToken}
                  setShowPatToken={auth.setShowPatToken}
                  onSubmit={auth.handlePatSubmit}
                />
              )}

              {/* Option to use prefilled credentials when in manual auth mode */}
              {prefilledCredentials && auth.prefillStatus === 'not-configured' && (
                <div className="mt-4 text-sm text-gray-600">
                  {prefilledCredentials.type === 'env' && 'Environment'}
                  {prefilledCredentials.type === 'outputs' && 'Command output'}
                  {prefilledCredentials.type === 'static' && 'Prefilled'} credentials are available.{' '}
                  <Button 
                    variant="outline" 
                    size="sm" 
                    onClick={auth.retryPrefill}
                  >
                    Use {prefilledCredentials.type === 'env' ? 'environment' : prefilledCredentials.type === 'outputs' ? 'command output' : 'prefilled'} credentials
                  </Button>
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
GitHubAuth.displayName = 'GitHubAuth'
