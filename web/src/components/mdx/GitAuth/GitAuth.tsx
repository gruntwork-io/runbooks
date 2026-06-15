import { useEffect, useState, useMemo } from "react"
import { AlertTriangle, Loader2 } from "lucide-react"
import { InlineMarkdown } from "@/components/mdx/_shared/components/InlineMarkdown"
import { BlockIdLabel } from "@/components/mdx/_shared"
import { useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"
import type { BlockComponentType } from "@/contexts/ComponentIdRegistry"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { useTelemetry } from "@/contexts/useTelemetry"
import { useTemplateContext } from "@/contexts/useRunbook"
import { useInstructionMode } from "@/contexts/useInstructionMode"
import { resolveTemplateReferences } from "@/lib/templateUtils"
import { GitAuthInstruction } from "./GitAuthInstruction"

import { ErrorDisplay } from "@/components/mdx/_shared/components/ErrorDisplay"
import { DuplicateIdError } from "@/components/mdx/_shared/components/DuplicateIdError"
import type { AppError } from "@/types/error"
import type { GitAuthProps, GitProvider } from "./types"
import { PROVIDERS } from "./providers"
import { useGitAuth } from "./hooks/useGitAuth"
import { getStatusClasses, getStatusIcon, getStatusIconClasses } from "./utils"
import { ProviderSelect } from "./components/ProviderSelect"
import { HostSelect } from "./components/HostSelect"
import { AuthTabs } from "./components/AuthTabs"
import { AuthSuccess } from "./components/AuthSuccess"
import { PatForm } from "./components/PatForm"
import { OAuthFlow } from "./components/OAuthFlow"
import { AutoAuthInfo } from "./components/AutoAuthInfo"
import { CustomOAuthWarning } from "./components/CustomOAuthWarning"
import { TlsErrorCard } from "./components/TlsErrorCard"

type GitAuthInternalProps = GitAuthProps & { __registryType?: BlockComponentType }

function GitAuthInteractive({
  id,
  title = "Git Authentication",
  description,
  provider: initialProvider = 'github',
  hideProviderSelect = false,
  instanceUrl,
  oauthClientId,
  oauthScopes,
  detectCredentials,
  host,
  inputsId,
  __registryType = 'GitAuth',
}: GitAuthInternalProps) {
  const validationError = useMemo((): AppError | null => {
    if (!id) {
      return {
        message: `The <${__registryType}> component requires a non-empty 'id' prop.`,
        details: "Please provide a unique 'id' for this component instance."
      }
    }
    return null
  }, [id, __registryType])

  // Resolve template expressions in display props
  const templateCtx = useTemplateContext(inputsId)
  const resolvedTitle = useMemo(() => title ? resolveTemplateReferences(title, templateCtx) : title, [title, templateCtx])
  const resolvedDescription = useMemo(() => description ? resolveTemplateReferences(description, templateCtx) : description, [description, templateCtx])

  // Check for duplicate component IDs
  const { isDuplicate, isNormalizedCollision, collidingId } = useComponentIdRegistry(id, __registryType)

  // Error reporting context (for configuration errors only)
  const { reportError, clearError } = useErrorReporting()

  const { trackBlockRender } = useTelemetry()

  // Selected provider (GitHub | GitLab)
  const [provider, setProvider] = useState<GitProvider>(initialProvider)
  const providerConfig = PROVIDERS[provider]

  // State for custom OAuth warning
  const [customOAuthDismissed, setCustomOAuthDismissed] = useState(false)
  const [useDefaultOAuth, setUseDefaultOAuth] = useState(false)

  // Per-provider OAuth scopes (GitHub only).
  const effectiveOAuthScopes = oauthScopes ?? providerConfig.defaultOAuthScopes

  // All auth state and handlers from custom hook
  const auth = useGitAuth({
    id,
    provider: providerConfig,
    instanceUrl,
    oauthClientId: useDefaultOAuth ? undefined : oauthClientId,
    oauthScopes: effectiveOAuthScopes,
    detectCredentials,
    host,
  })

  // Switch providers: cancel any in-flight OAuth poll, drop the prior
  // provider's outputs, reset transient + detection state so detection re-runs,
  // and reset the auth method to the new provider's default (GitLab has no
  // OAuth, so a leftover 'oauth' method would render no form at all).
  const handleSelectProvider = (next: GitProvider) => {
    if (next === provider) return
    auth.cancelOAuth()
    auth.clearRegisteredOutputs(next)
    auth.resetAuth()
    auth.resetDetectionState()
    auth.setAuthMethod(PROVIDERS[next].supportsOAuth ? 'oauth' : 'pat')
    setCustomOAuthDismissed(false)
    setUseDefaultOAuth(false)
    setProvider(next)
  }

  // Track block render on mount
  useEffect(() => {
    trackBlockRender(__registryType)
  }, [trackBlockRender, __registryType])

  // When the OAuth tab is disabled (§2.0 unreachable), make sure the PAT form
  // is the one showing rather than a dead OAuth pane.
  const oauthDisabled = auth.oauthUnavailableReason !== null
  const setAuthMethod = auth.setAuthMethod
  useEffect(() => {
    if (oauthDisabled && auth.authMethod === 'oauth') {
      setAuthMethod('pat')
    }
  }, [oauthDisabled, auth.authMethod, setAuthMethod])

  // Report configuration errors only
  useEffect(() => {
    if (isDuplicate) {
      reportError({
        componentId: id,
        componentType: __registryType,
        severity: 'error',
        message: `Duplicate component ID: ${id}`
      })
    } else {
      clearError(id)
    }
  }, [id, isDuplicate, reportError, clearError, __registryType])

  // Early return for validation errors (e.g. missing id prop)
  if (validationError) {
    return <ErrorDisplay error={validationError} />
  }

  // Early return for duplicate ID
  if (isDuplicate) {
    return (
      <DuplicateIdError
        id={id}
        isNormalizedCollision={isNormalizedCollision}
        collidingId={collidingId}
        componentName={__registryType}
        className="runbook-block"
      />
    )
  }

  const IconComponent = getStatusIcon(auth.authStatus)
  const statusClasses = getStatusClasses(auth.authStatus)
  const iconClasses = getStatusIconClasses(auth.authStatus)

  // Provider picker is hidden when the author locks it or once authenticated.
  const showProviderSelect = !hideProviderSelect && auth.authStatus !== 'authenticated'

  // Show custom OAuth warning if using non-default client ID and not dismissed
  const showCustomOAuthWarning = auth.isCustomClientId && !customOAuthDismissed && !useDefaultOAuth &&
    auth.authStatus !== 'authenticated' && auth.authMethod === 'oauth'

  return (
    <div data-testid={id} className={`runbook-block relative rounded-sm border ${statusClasses} mb-5 p-4`}>
      {/* ID label - positioned at top right */}
      <div className="absolute top-3 right-3 z-20">
        <BlockIdLabel id={id} size="large" />
      </div>

      {/* Header with provider logo */}
      <div className="flex items-start gap-4 @container">
        <div className="border-r border-border pr-3 mr-0 self-stretch">
          <IconComponent className={`size-6 ${iconClasses} ${auth.authStatus === 'authenticating' ? 'animate-spin' : ''}`} />
        </div>

        <div className="flex-1">
          {/* Title row with provider icon */}
          <div className="flex items-center gap-1 mb-2">
            <providerConfig.Logo className="size-6 text-foreground" />
            <div className="text-md font-bold text-foreground">
              <InlineMarkdown>{resolvedTitle}</InlineMarkdown>
            </div>
          </div>

          {resolvedDescription && (
            <div className="text-md text-muted-foreground mb-4">
              <InlineMarkdown>{resolvedDescription}</InlineMarkdown>
            </div>
          )}

          {/* Provider picker */}
          {showProviderSelect && (
            <ProviderSelect provider={provider} onSelect={handleSelectProvider} />
          )}

          {/* GitLab host picker + config reload. Auto-detection lands on glab's
              default host first, so the switcher stays visible after
              authenticating whenever more than one host is available — that's
              how the user moves from gitlab.com to a self-managed instance. */}
          {auth.hostSelectable &&
            ((auth.availableHosts?.length ?? 0) > 1 || auth.authStatus !== 'authenticated') && (
            <HostSelect
              id={id}
              hosts={auth.availableHosts}
              value={auth.selectedHost}
              onChange={auth.handleHostSelect}
              onReload={auth.reloadDetection}
              downgradedHosts={auth.downgradedHosts}
              disabled={auth.detectionStatus === 'pending'}
            />
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
              provider={providerConfig}
              detectionSource={auth.detectionSource}
              detectedScopes={auth.detectedScopes}
              detectedTokenType={auth.detectedTokenType}
              scopeWarning={auth.scopeWarning}
              sessionEnvWarning={auth.sessionEnvWarning}
              host={auth.selectedHost}
              successMeta={auth.successMeta}
              divergenceHint={auth.divergenceHint}
              sessionStale={auth.sessionStale}
              gitSslBackend={auth.cliStatus?.git?.sslBackend}
              onApplySchannel={() => {
                void window.api.invoke('vcs:apply-git-schannel').catch(() => {})
              }}
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

          {/* Unreachable host (§2.0/§7): a TLS/server-cert/network failure is
              NEVER an invalid-credentials warning. The card renders above the
              still-available manual UI. */}
          {auth.unreachableInfo && auth.authStatus !== 'authenticated' && (
            <TlsErrorCard
              info={auth.unreachableInfo}
              onRetry={auth.retryUnreachable}
              retrying={auth.detectionStatus === 'pending'}
            />
          )}

          {/* Authentication form (only show when not authenticated and detection is done) */}
          {auth.authStatus !== 'authenticated' && auth.detectionStatus === 'done' && (
            <>
              {/* CLI-status-driven hint (§5/§7) + the "Check again" control */}
              {auth.manualHint && (
                <div
                  data-testid="vcs-cli-hint"
                  className="mb-4 text-sm text-muted-foreground flex items-center gap-2 flex-wrap"
                >
                  <span>{auth.manualHint}</span>
                  {provider === 'github' && (
                    <button
                      type="button"
                      onClick={auth.retryUnreachable}
                      className="text-info hover:underline cursor-pointer text-sm font-medium"
                    >
                      Check again
                    </button>
                  )}
                </div>
              )}

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
                provider={providerConfig}
                oauthDisabled={oauthDisabled}
                oauthDisabledReason={auth.oauthUnavailableReason ?? undefined}
              />

              {/* OAuth Flow (GitHub only) */}
              {providerConfig.supportsOAuth && auth.authMethod === 'oauth' && !showCustomOAuthWarning && !oauthDisabled && (
                <OAuthFlow
                  authStatus={auth.authStatus}
                  effectiveClientId={auth.effectiveClientId}
                  userCode={auth.oauthUserCode}
                  verificationUri={auth.oauthVerificationUri}
                  onStartOAuth={auth.startOAuth}
                  onCancelOAuth={auth.cancelOAuth}
                  provider={providerConfig}
                />
              )}

              {/* PAT Form */}
              {auth.authMethod === 'pat' && (
                <>
                  <PatForm
                    authStatus={auth.authStatus}
                    patToken={auth.patToken}
                    setPatToken={auth.setPatToken}
                    showPatToken={auth.showPatToken}
                    setShowPatToken={auth.setShowPatToken}
                    onSubmit={auth.handlePatSubmit}
                    provider={providerConfig}
                    instanceUrl={auth.gitlabInstanceUrl}
                    setInstanceUrl={auth.setGitlabInstanceUrl}
                  />
                  {/* Providers without OAuth (GitLab) surface the auto-detect
                      FAQ here, since there is no OAuth tab to carry it. */}
                  {!providerConfig.supportsOAuth && (
                    <div className="mt-4">
                      <AutoAuthInfo provider={providerConfig} />
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * GitAuth entry point. A thin wrapper that branches on instruction mode before
 * any auth hooks run: in instruction mode it renders a plain "Log into
 * GitHub/GitLab" instruction (no token capture); otherwise it renders the
 * interactive authentication UI. Branching here keeps `useGitAuth` (and its
 * on-mount detection) out of the instruction path entirely.
 */
export function GitAuth(props: GitAuthInternalProps) {
  const { enabled: instructionMode } = useInstructionMode()
  if (instructionMode) {
    return <GitAuthInstruction {...props} />
  }
  return <GitAuthInteractive {...props} />
}

// Set displayName for React DevTools and component detection
GitAuth.displayName = 'GitAuth'
