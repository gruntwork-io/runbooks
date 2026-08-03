import { useEffect, useMemo } from "react"
import { XCircle, AlertTriangle, Loader2 } from "lucide-react"
import { InlineMarkdown } from "@/components/mdx/_shared/components/InlineMarkdown"
import { BlockIdLabel } from "@/components/mdx/_shared"
import { useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { useTelemetry } from "@/contexts/useTelemetry"
import { useTemplateContext } from "@/contexts/useRunbook"
import { useInstructionMode } from "@/contexts/useInstructionMode"
import { resolveTemplateReferences } from "@/lib/templateUtils"
import { GoogleAuthInstruction } from "./GoogleAuthInstruction"

import { ErrorDisplay } from "@/components/mdx/_shared/components/ErrorDisplay"
import { DuplicateIdError } from "@/components/mdx/_shared/components/DuplicateIdError"
import type { AppError } from "@/types/error"
import type { GoogleAuthProps } from "./types"
import { useGoogleAuth } from "./hooks/useGoogleAuth"
import { getStatusClasses, getStatusIcon, getStatusIconClasses } from "./utils"
import { GoogleCloudLogo } from "./components/GoogleCloudLogo"
import { AuthTabs } from "./components/AuthTabs"
import { AuthSuccess } from "./components/AuthSuccess"
import { ServiceAccountKeyForm } from "./components/ServiceAccountKeyForm"
import { OAuthFlow } from "./components/OAuthFlow"
import { GcloudConfigSelector } from "./components/GcloudConfigSelector"
import { ProjectSelector } from "./components/ProjectSelector"
import { DetectedCredentialsPrompt } from "./components/DetectedCredentialsPrompt"

function GoogleAuthInteractive({
  id,
  title = "Google Cloud Authentication",
  description,
  project,
  scopes,
  oauthClientId,
  oauthClientSecret,
  defaultRegion,
  defaultZone,
  gcloudConfiguration,
  detectCredentials = ['env', 'adc'],  // Default: env vars, then the well-known ADC file
  inputsId,
}: GoogleAuthProps) {
  const validationError = useMemo((): AppError | null => {
    if (!id) {
      return {
        message: "The <GoogleAuth> component requires a non-empty 'id' prop.",
        details: "Please provide a unique 'id' for this component instance."
      }
    }
    return null
  }, [id])

  // Resolve template expressions in display props and in the props that select
  // what we authenticate against (so `project="{{ .inputs.project }}"` works).
  const templateCtx = useTemplateContext(inputsId)
  const resolvedTitle = useMemo(() => title ? resolveTemplateReferences(title, templateCtx) : title, [title, templateCtx])
  const resolvedDescription = useMemo(() => description ? resolveTemplateReferences(description, templateCtx) : description, [description, templateCtx])
  const resolvedProject = useMemo(() => project ? resolveTemplateReferences(project, templateCtx) : project, [project, templateCtx])
  const resolvedConfiguration = useMemo(
    () => gcloudConfiguration ? resolveTemplateReferences(gcloudConfiguration, templateCtx) : gcloudConfiguration,
    [gcloudConfiguration, templateCtx],
  )

  // Check for duplicate component IDs (including normalized collisions like "a-b" vs "a_b")
  const { isDuplicate, isNormalizedCollision, collidingId } = useComponentIdRegistry(id, 'GoogleAuth')

  // Validate detectCredentials configuration: only one { block: string } source allowed.
  // The confirm path finds its source with a `find`, which is only unambiguous
  // because of this constraint.
  const blockSources = Array.isArray(detectCredentials)
    ? detectCredentials.filter(s => typeof s === 'object' && 'block' in s)
    : []
  const hasMultipleBlockSources = blockSources.length > 1

  // Error reporting context (for configuration errors only — runtime failures
  // such as an invalid key, an expired ADC, or a denied consent screen render
  // inline via the hook's errorMessage/detectionWarning).
  const { reportError, clearError } = useErrorReporting()

  const { trackBlockRender } = useTelemetry()

  const auth = useGoogleAuth({
    id,
    ...(resolvedProject ? { project: resolvedProject } : {}),
    ...(scopes ? { scopes } : {}),
    ...(oauthClientId ? { oauthClientId } : {}),
    ...(oauthClientSecret ? { oauthClientSecret } : {}),
    ...(defaultRegion ? { defaultRegion } : {}),
    ...(defaultZone ? { defaultZone } : {}),
    ...(resolvedConfiguration ? { gcloudConfiguration: resolvedConfiguration } : {}),
    detectCredentials,
  })

  // Track block render on mount
  useEffect(() => {
    trackBlockRender('GoogleAuth')
  }, [trackBlockRender])

  // Load the gcloud configurations when that tab is selected (mirrors AwsAuth's
  // lazy profile load — a pure disk read, but not one worth doing on mount).
  const { authMethod, gcloudConfigs, loadGcloudConfigs } = auth
  useEffect(() => {
    if (authMethod === 'gcloud' && gcloudConfigs.length === 0) {
      void loadGcloudConfigs()
    }
  }, [authMethod, gcloudConfigs.length, loadGcloudConfigs])

  // Report configuration errors only
  useEffect(() => {
    if (isDuplicate) {
      reportError({
        componentId: id,
        componentType: 'GoogleAuth',
        severity: 'error',
        message: `Duplicate component ID: ${id}`
      })
    } else if (hasMultipleBlockSources) {
      reportError({
        componentId: id,
        componentType: 'GoogleAuth',
        severity: 'error',
        message: `Multiple block sources in detectCredentials: only one { block: string } is allowed`
      })
    } else {
      clearError(id)
    }
  }, [id, isDuplicate, hasMultipleBlockSources, reportError, clearError])

  if (validationError) {
    return <ErrorDisplay error={validationError} />
  }

  if (isDuplicate) {
    return (
      <DuplicateIdError
        id={id}
        isNormalizedCollision={isNormalizedCollision}
        collidingId={collidingId}
        componentName="GoogleAuth"
        className="runbook-block"
      />
    )
  }

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

  // GCP has no account -> role two-step, so AwsAuth's two selection states
  // collapse into one: the tabs hide only while a project is being picked.
  const showTabs = auth.authStatus !== 'select_project'
  const showProjectSelector = auth.authStatus === 'select_project'

  return (
    <div data-testid={id} className={`runbook-block relative rounded-sm border ${statusClasses} mb-5 p-4`}>
      {/* ID label - positioned at top right */}
      <div className="absolute top-3 right-3 z-20">
        <BlockIdLabel id={id} size="large" />
      </div>

      {/* Header with Google Cloud logo */}
      <div className="flex items-start gap-4 @container">
        <div className="border-r border-info/30 pr-3 mr-0 self-stretch">
          <IconComponent className={`size-6 ${iconClasses} ${auth.authStatus === 'authenticating' ? 'animate-spin' : ''}`} />
        </div>

        <div className="flex-1">
          {/* Title row with the Google Cloud lockup. The wordmark uses
              currentColor, so light and dark surfaces need no asset swap. */}
          <div className="flex items-center gap-3 mb-2">
            <GoogleCloudLogo className="h-6 text-foreground" />
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

          {/* Detected credentials confirmation prompt. Detection is read-only —
              confirming is what makes the credential this block's. */}
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
              onChangeProject={auth.handleChangeProject}
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
              {/* Method tabs (hide during project selection) */}
              {showTabs && (
                <AuthTabs
                  authMethod={auth.authMethod}
                  setAuthMethod={(method) => {
                    auth.clearRetryMessage()
                    auth.setAuthMethod(method)
                  }}
                  oauthUnavailable={auth.oauthUnavailable}
                />
              )}

              {/* Service Account Key */}
              {auth.authMethod === 'service_account' && showTabs && (
                <ServiceAccountKeyForm
                  authStatus={auth.authStatus}
                  serviceAccountKey={auth.serviceAccountKey}
                  setServiceAccountKey={auth.setServiceAccountKey}
                  showServiceAccountKey={auth.showServiceAccountKey}
                  setShowServiceAccountKey={auth.setShowServiceAccountKey}
                  keyFileName={auth.keyFileName}
                  keyFilePath={auth.keyFilePath}
                  onLoadKeyFile={auth.loadKeyFromFile}
                  projectIdInput={auth.projectIdInput}
                  setProjectIdInput={auth.setProjectIdInput}
                  selectedRegion={auth.selectedRegion}
                  setSelectedRegion={auth.setSelectedRegion}
                  onSubmit={auth.handleServiceAccountSubmit}
                />
              )}

              {/* Google Sign-In (loopback OAuth) */}
              {auth.authMethod === 'oauth' && showTabs && (
                <OAuthFlow
                  authStatus={auth.authStatus}
                  flowId={auth.oauthFlowId}
                  authUrl={auth.oauthAuthUrl}
                  oauthUnavailable={auth.oauthUnavailable}
                  {...(scopes ? { scopes } : {})}
                  selectedRegion={auth.selectedRegion}
                  setSelectedRegion={auth.setSelectedRegion}
                  onStartOAuth={auth.handleOAuthLogin}
                  onCancelOAuth={auth.handleCancelOAuth}
                />
              )}

              {/* gcloud configuration */}
              {auth.authMethod === 'gcloud' && showTabs && (
                <GcloudConfigSelector
                  authStatus={auth.authStatus}
                  configs={auth.gcloudConfigs}
                  selectedConfig={auth.selectedConfig}
                  setSelectedConfig={auth.setSelectedConfig}
                  loadingConfigs={auth.loadingConfigs}
                  configSearch={auth.configSearch}
                  setConfigSearch={auth.setConfigSearch}
                  adcInfo={auth.adcInfo}
                  configRoot={auth.gcloudConfigRoot}
                  selectedRegion={auth.selectedRegion}
                  setSelectedRegion={auth.setSelectedRegion}
                  onGcloudAuth={auth.handleGcloudAuth}
                  onRefreshConfigs={auth.loadGcloudConfigs}
                />
              )}

              {/* Project Selection */}
              {showProjectSelector && (
                <ProjectSelector
                  projects={auth.projects}
                  selectedProject={auth.selectedProject}
                  loadingProjects={auth.loadingProjects}
                  searchValue={auth.projectSearch}
                  setSearchValue={auth.setProjectSearch}
                  onProjectSelect={auth.handleProjectSelect}
                  onCancel={auth.handleManualAuth}
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
 * GoogleAuth entry point. A thin wrapper that branches on instruction mode
 * before any auth hooks run: in instruction mode it renders a plain "Log into
 * Google Cloud" instruction (no credential capture); otherwise it renders the
 * interactive authentication UI. Branching here — rather than inside the
 * interactive component — keeps `useGoogleAuth` (and its on-mount credential
 * detection) out of the instruction path entirely.
 */
function GoogleAuth(props: GoogleAuthProps) {
  const { enabled: instructionMode } = useInstructionMode()
  if (instructionMode) {
    return <GoogleAuthInstruction {...props} />
  }
  return <GoogleAuthInteractive {...props} />
}

// Set displayName for React DevTools and component detection
GoogleAuth.displayName = 'GoogleAuth'

export default GoogleAuth
