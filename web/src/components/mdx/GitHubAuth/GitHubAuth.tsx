import { useEffect, useState, useMemo } from "react"
import { XCircle, AlertTriangle, Loader2 } from "lucide-react"
import { InlineMarkdown } from "@/components/mdx/_shared/components/InlineMarkdown"
import { BlockIdLabel } from "@/components/mdx/_shared"
import { useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { useTelemetry } from "@/contexts/useTelemetry"
import { useTemplateContext } from "@/contexts/useRunbook"
import { useInstructionMode } from "@/contexts/useInstructionMode"
import { resolveTemplateReferences } from "@/lib/templateUtils"
import { GitHubAuthInstruction } from "./GitHubAuthInstruction"

import { ErrorDisplay } from "@/components/mdx/_shared/components/ErrorDisplay"
import type { AppError } from "@/types/error"
import type { GitHubAuthProps } from "./types"
import { useGitHubAuth } from "./hooks/useGitHubAuth"
import { getStatusClasses, getStatusIcon, getStatusIconClasses } from "./utils"
import { AuthTabs } from "./components/AuthTabs"
import { AuthSuccess } from "./components/AuthSuccess"
import { PatForm } from "./components/PatForm"
import { OAuthFlow } from "./components/OAuthFlow"
import { CustomOAuthWarning } from "./components/CustomOAuthWarning"
import { GitHubLogo } from "./components/GitHubLogo"

function GitHubAuthInteractive({
  id,
  title = "GitHub Authentication",
  description,
  oauthClientId,
  oauthScopes = ['repo'],
  detectCredentials,
  inputsId,
}: GitHubAuthProps) {
  // Validate required props
  const validationError = useMemo((): AppError | null => {
    if (!id) {
      return {
        message: "The <GitHubAuth> component requires a non-empty 'id' prop.",
        details: "Please provide a unique 'id' for this component instance."
      }
    }
    return null
  }, [id])

  // Resolve template expressions in display props
  const templateCtx = useTemplateContext(inputsId)
  const resolvedTitle = useMemo(() => title ? resolveTemplateReferences(title, templateCtx) : title, [title, templateCtx])
  const resolvedDescription = useMemo(() => description ? resolveTemplateReferences(description, templateCtx) : description, [description, templateCtx])

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
    detectCredentials,
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
                Another <code className="bg-destructive-muted px-1 rounded">{"<GitHubAuth>"}</code> component with id <code className="bg-destructive-muted px-1 rounded">{`"${id}"`}</code> already exists.
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
    <div data-testid={id} className={`runbook-block relative rounded-sm border ${statusClasses} mb-5 p-4`}>
      {/* ID label - positioned at top right */}
      <div className="absolute top-3 right-3 z-20">
        <BlockIdLabel id={id} size="large" />
      </div>

      {/* Header with GitHub Logo */}
      <div className="flex items-start gap-4 @container">
        <div className="border-r border-border pr-3 mr-0 self-stretch">
          <IconComponent className={`size-6 ${iconClasses} ${auth.authStatus === 'authenticating' ? 'animate-spin' : ''}`} />
        </div>

        <div className="flex-1">
          {/* Title row with GitHub icon */}
          <div className="flex items-center gap-1 mb-2">
            <GitHubLogo className="size-6 text-foreground" />
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
                  : 'Checking for existing authentication...'}
              </span>
            </div>
          )}

          {/* Success state */}
          {auth.authStatus === 'authenticated' && auth.userInfo && (
            <AuthSuccess
              userInfo={auth.userInfo}
              detectionSource={auth.detectionSource}
              detectedScopes={auth.detectedScopes}
              detectedTokenType={auth.detectedTokenType}
              scopeWarning={auth.scopeWarning}
              sessionEnvWarning={auth.sessionEnvWarning}
              onReAuthenticate={auth.resetAuth}
            />
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

          {/* Detection warning (found credentials but they're invalid) */}
          {auth.detectionWarning && auth.authStatus !== 'authenticated' && (
            <div className="mb-4 bg-warning-muted border border-warning/30 rounded p-3 text-sm text-warning-foreground flex items-start gap-2">
              <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
              <div>
                <strong>Invalid credentials detected:</strong> {auth.detectionWarning}
                <br />
                <span className="text-warning-foreground">Please authenticate manually below, or fix the credentials and reload.</span>
              </div>
            </div>
          )}

          {/* Authentication form (only show when not authenticated and detection is done) */}
          {auth.authStatus !== 'authenticated' && auth.detectionStatus === 'done' && (
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
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * GitHubAuth entry point. A thin wrapper that branches on instruction mode
 * before any auth hooks run: in instruction mode it renders a plain "Log into
 * GitHub" instruction (no token capture); otherwise it renders the interactive
 * authentication UI. Branching here keeps `useGitHubAuth` (and its on-mount
 * detection) out of the instruction path entirely.
 */
export function GitHubAuth(props: GitHubAuthProps) {
  const { enabled: instructionMode } = useInstructionMode()
  if (instructionMode) {
    return <GitHubAuthInstruction {...props} />
  }
  return <GitHubAuthInteractive {...props} />
}

// Set displayName for React DevTools and component detection
GitHubAuth.displayName = 'GitHubAuth'
