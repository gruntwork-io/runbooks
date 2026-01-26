import { useEffect } from "react"
import { XCircle, AlertTriangle, Loader2, Github } from "lucide-react"
import { InlineMarkdown } from "@/components/mdx/_shared/components/InlineMarkdown"
import { BlockIdLabel } from "@/components/mdx/_shared"
import { useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { useTelemetry } from "@/contexts/useTelemetry"

import type { GitHubAuthProps } from "./types"
import { useGitHubAuth } from "./hooks/useGitHubAuth"
import { AuthTabs } from "./components/AuthTabs"
import { AuthSuccess } from "./components/AuthSuccess"
import { TokenForm } from "./components/TokenForm"
import { DeviceFlowForm } from "./components/DeviceFlowForm"

function getStatusClasses(status: string): string {
  switch (status) {
    case 'authenticated':
      return 'bg-green-50 border-green-200'
    case 'failed':
      return 'bg-red-50 border-red-200'
    case 'authenticating':
      return 'bg-blue-50 border-blue-200'
    default:
      return 'bg-gray-50 border-gray-200'
  }
}

function getStatusIconClasses(status: string): string {
  switch (status) {
    case 'authenticated':
      return 'text-green-600'
    case 'failed':
      return 'text-red-600'
    case 'authenticating':
      return 'text-blue-600'
    default:
      return 'text-gray-600'
  }
}

function GitHubAuth({
  id,
  title = "GitHub Authentication",
  description,
  scopes = ['repo'],
}: GitHubAuthProps) {
  // Check for duplicate component IDs
  const { isDuplicate, isNormalizedCollision, collidingId } = useComponentIdRegistry(id, 'GitHubAuth')

  // Error reporting context (for configuration errors only)
  const { reportError, clearError } = useErrorReporting()

  // Telemetry context
  const { trackBlockRender } = useTelemetry()

  // All auth state and handlers from custom hook
  const auth = useGitHubAuth({ id, scopes })

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

  const statusClasses = getStatusClasses(auth.authStatus)
  const iconClasses = getStatusIconClasses(auth.authStatus)

  const showAuthUI = auth.authStatus !== 'authenticated' &&
    auth.prefillStatus !== 'pending' &&
    (auth.prefillStatus !== 'failed' || true) // Always allow manual auth

  return (
    <div className={`runbook-block relative rounded-sm border ${statusClasses} mb-5 p-4`}>
      {/* ID label - positioned at top right */}
      <div className="absolute top-3 right-3 z-20">
        <BlockIdLabel id={id} size="large" />
      </div>

      {/* Header with GitHub Logo */}
      <div className="flex items-start gap-4 @container">
        <div className="border-r border-gray-300 pr-3 mr-0 self-stretch">
          {auth.authStatus === 'authenticating' ? (
            <Loader2 className={`size-6 ${iconClasses} animate-spin`} />
          ) : (
            <Github className={`size-6 ${iconClasses}`} />
          )}
        </div>

        <div className="flex-1">
          {/* Title row */}
          <div className="flex items-center gap-3 mb-2">
            <div className="text-md font-bold text-gray-700">
              <InlineMarkdown>{title}</InlineMarkdown>
            </div>
          </div>

          {description && (
            <div className="text-md text-gray-600 mb-4">
              <InlineMarkdown>{description}</InlineMarkdown>
            </div>
          )}

          {/* Prefill pending state */}
          {auth.prefillStatus === 'pending' && (
            <div className="mb-4 text-blue-600 text-sm flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" />
              <span>Checking for GitHub token...</span>
            </div>
          )}

          {/* Success state */}
          {auth.authStatus === 'authenticated' && auth.user && (
            <AuthSuccess
              user={auth.user}
              prefillSource={auth.prefillStatus === 'success' ? 'env' : null}
              onReauthenticate={auth.handleManualAuth}
            />
          )}

          {/* Prefill failed state */}
          {auth.prefillStatus === 'failed' && auth.prefillError && (
            <div className="mb-4 bg-amber-50 border border-amber-200 rounded p-3 text-sm text-amber-800 flex items-start gap-2">
              <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
              <div>
                <strong>Could not use environment token:</strong> {auth.prefillError}
                <br />
                <span className="text-amber-700">Please authenticate manually below.</span>
              </div>
            </div>
          )}

          {/* Error state */}
          {auth.authStatus === 'failed' && auth.errorMessage && (
            <div className="mb-4 text-red-600 text-sm flex items-start gap-2">
              <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
              <div>
                <strong>Authentication failed:</strong> {auth.errorMessage}
              </div>
            </div>
          )}

          {/* Authentication UI */}
          {showAuthUI && (
            <>
              {/* Only show tabs when not in device flow */}
              {!auth.deviceFlow && (
                <AuthTabs
                  authMethod={auth.authMethod}
                  setAuthMethod={auth.setAuthMethod}
                />
              )}

              {/* Token Form */}
              {auth.authMethod === 'token' && !auth.deviceFlow && (
                <TokenForm
                  authStatus={auth.authStatus}
                  token={auth.token}
                  setToken={auth.setToken}
                  showToken={auth.showToken}
                  setShowToken={auth.setShowToken}
                  onSubmit={auth.handleTokenSubmit}
                />
              )}

              {/* Device Flow */}
              {auth.authMethod === 'device' && (
                <DeviceFlowForm
                  authStatus={auth.authStatus}
                  deviceFlow={auth.deviceFlow}
                  onStart={auth.handleDeviceFlowStart}
                  onCancel={auth.handleCancelDeviceFlow}
                />
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

export default GitHubAuth
