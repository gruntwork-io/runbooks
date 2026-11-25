import { useEffect, useMemo, useRef } from "react"
import { XCircle, AlertTriangle, Loader2 } from "lucide-react"
import { InlineMarkdown } from "@/components/mdx/_shared/components/InlineMarkdown"
import { BlockIdLabel } from "@/components/mdx/_shared"
import { useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"
import { stringParam, useAgentBlock, useAgentDeferred, useLatest } from "@/contexts/useAgentBridge"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { issueAnchor } from "@/contexts/ErrorReportingContext.types"
import { useTemplateContext } from "@/contexts/useRunbook"
import { useInstructionMode } from "@/contexts/useInstructionMode"
import { resolveTemplateReferences } from "@/lib/templateUtils"
import { GoogleAuthInstruction } from "./GoogleAuthInstruction"

import { ErrorDisplay } from "@/components/mdx/_shared/components/ErrorDisplay"
import { BlockLink } from "@/components/mdx/_shared/components/BlockLink"
import { CredentialExpiryNotice } from "@/components/mdx/_shared/components/CredentialExpiryNotice"
import { DetectionHint } from "@/components/mdx/_shared/components/DetectionHint"
import { useCredentialExpiry } from "@/components/mdx/_shared/hooks/useCredentialExpiry"
import { DuplicateIdError } from "@/components/mdx/_shared/components/DuplicateIdError"
import { AutoCollapse, CollapseButton } from "@/components/mdx/_shared/components/AutoCollapse"
import { ProgressStep } from "@/components/mdx/_shared/components/ProgressStep"
import type { AppError } from "@/types/error"
import type { GoogleAuthProps } from "./types"
import { useGoogleAuth } from "./hooks/useGoogleAuth"
import { getStatusClasses, StatusIcon, getStatusIconClasses } from "./utils"
import { GoogleCloudLogo } from "./components/GoogleCloudLogo"
import { AuthTabs } from "./components/AuthTabs"
import { AuthSuccess } from "./components/AuthSuccess"
import { ServiceAccountKeyForm } from "./components/ServiceAccountKeyForm"
import { OAuthFlow } from "./components/OAuthFlow"
import { GcloudConfigSelector } from "./components/GcloudConfigSelector"
import { ProjectSelector } from "./components/ProjectSelector"
import { DetectedCredentialsPrompt } from "./components/DetectedCredentialsPrompt"
import { InsufficientScopesPrompt } from "./components/InsufficientScopesPrompt"

function GoogleAuthInteractive({
  id,
  title = "Google Cloud Authentication",
  description,
  project,
  scopes,
  oauthClientId,
  oauthClientSecret,
  oauthClientFile,
  defaultRegion,
  defaultZone,
  gcloudConfiguration,
  detectCredentials = ["env", "adc"], // Default: env vars, then the well-known ADC file
  defaultTab,
  inputsId,
  autoCollapse,
}: GoogleAuthProps) {
  const validationError = useMemo((): AppError | null => {
    if (!id) {
      return {
        message: "The <GoogleAuth> component requires a non-empty 'id' prop.",
        details: "Please provide a unique 'id' for this component instance.",
      }
    }
    return null
  }, [id])

  // Resolve template expressions in display props and in the props that select
  // what we authenticate against (so `project="{{ .inputs.project }}"` works).
  const templateCtx = useTemplateContext(inputsId)
  const resolvedTitle = useMemo(
    () => (title ? resolveTemplateReferences(title, templateCtx) : title),
    [title, templateCtx],
  )
  const resolvedDescription = useMemo(
    () => (description ? resolveTemplateReferences(description, templateCtx) : description),
    [description, templateCtx],
  )
  const resolvedProject = useMemo(
    () => (project ? resolveTemplateReferences(project, templateCtx) : project),
    [project, templateCtx],
  )
  const resolvedConfiguration = useMemo(
    () =>
      gcloudConfiguration
        ? resolveTemplateReferences(gcloudConfiguration, templateCtx)
        : gcloudConfiguration,
    [gcloudConfiguration, templateCtx],
  )
  const resolvedOauthClientFile = useMemo(
    () =>
      oauthClientFile ? resolveTemplateReferences(oauthClientFile, templateCtx) : oauthClientFile,
    [oauthClientFile, templateCtx],
  )
  const hasOauthClientFileConflict = Boolean(
    resolvedOauthClientFile && (oauthClientId || oauthClientSecret),
  )

  // Check for duplicate component IDs (including normalized collisions like "a-b" vs "a_b")
  const blockRef = useRef<HTMLDivElement>(null)
  const { isDuplicate, isNormalizedCollision, collidingId } = useComponentIdRegistry(
    id,
    "GoogleAuth",
    blockRef,
  )

  // Validate detectCredentials configuration: only one { block: string } source allowed.
  // The confirm path finds its source with a `find`, which is only unambiguous
  // because of this constraint.
  const blockSources = Array.isArray(detectCredentials)
    ? detectCredentials.filter((s) => typeof s === "object" && "block" in s)
    : []
  const hasMultipleBlockSources = blockSources.length > 1

  // Error reporting context (for configuration errors only — runtime failures
  // such as an invalid key, an expired ADC, or a denied consent screen render
  // inline via the hook's errorMessage/detectionWarning).
  const { reportError, clearError } = useErrorReporting()

  const auth = useGoogleAuth({
    id,
    ...(resolvedProject ? { project: resolvedProject } : {}),
    ...(scopes ? { scopes } : {}),
    ...(oauthClientId ? { oauthClientId } : {}),
    ...(oauthClientSecret ? { oauthClientSecret } : {}),
    ...(resolvedOauthClientFile ? { oauthClientFile: resolvedOauthClientFile } : {}),
    ...(defaultRegion ? { defaultRegion } : {}),
    ...(defaultZone ? { defaultZone } : {}),
    ...(resolvedConfiguration ? { gcloudConfiguration: resolvedConfiguration } : {}),
    detectCredentials,
    defaultTab,
  })

  const expiresAt = auth.authStatus === "authenticated" ? auth.accountInfo?.expiresAt : undefined
  const expiry = useCredentialExpiry(expiresAt)

  // Load the gcloud configurations when that tab is selected (mirrors AwsAuth's
  // lazy profile load — a pure disk read, but not one worth doing on mount).
  const { authMethod, gcloudConfigs, loadGcloudConfigs } = auth
  useEffect(() => {
    if (authMethod === "gcloud" && gcloudConfigs.length === 0) {
      void loadGcloudConfigs()
    }
  }, [authMethod, gcloudConfigs.length, loadGcloudConfigs])

  // Report configuration errors only
  useEffect(() => {
    if (isDuplicate) {
      reportError({
        componentId: id,
        componentType: "GoogleAuth",
        severity: "error",
        message: `Duplicate component ID: ${id}`,
      })
    } else if (hasMultipleBlockSources) {
      reportError({
        componentId: id,
        componentType: "GoogleAuth",
        severity: "error",
        message: `Multiple block sources in detectCredentials: only one { block: string } is allowed`,
      })
    } else if (hasOauthClientFileConflict) {
      reportError({
        componentId: id,
        componentType: "GoogleAuth",
        severity: "error",
        message: "Supply either oauthClientId/oauthClientSecret or oauthClientFile, not both.",
      })
    } else {
      clearError(id)
    }
  }, [
    id,
    isDuplicate,
    hasMultipleBlockSources,
    hasOauthClientFileConflict,
    reportError,
    clearError,
  ])

  // What an AI agent sees of this block and does to it, through the app's MCP
  // server: the same handlers as the block's detection prompt, gcloud tab,
  // browser sign-in and project picker.
  const latestAuth = useLatest(auth)
  const defer = useAgentDeferred()
  const signedIn = auth.authStatus === "authenticated"
  const signingIn = auth.authStatus === "authenticating"
  const detectedPending = auth.detectionStatus === "detected" && auth.detectedCredentials !== null
  useAgentBlock(id, {
    type: "GoogleAuth",
    title: resolvedTitle,
    status: () =>
      signedIn
        ? "success"
        : signingIn
          ? "running"
          : auth.authStatus === "failed"
            ? "fail"
            : "pending",
    blockedBy: () => [
      ...(validationError ? [validationError.message] : []),
      ...(isDuplicate ? [`Duplicate block id "${id}"`] : []),
      ...(hasMultipleBlockSources || hasOauthClientFileConflict
        ? ["The block's configuration is invalid"]
        : []),
      ...(auth.waitingForBlockId
        ? [`Waiting for block "${auth.waitingForBlockId}", whose credentials it uses`]
        : []),
    ],
    needsHuman: () =>
      signingIn && auth.oauthAuthUrl
        ? `The person at the window must finish the Google sign-in in the browser (${auth.oauthAuthUrl}).`
        : undefined,
    detail: () => ({
      state: {
        signedInAs: signedIn ? auth.accountInfo?.principal : undefined,
        projectId: auth.accountInfo?.projectId,
        projectName: auth.accountInfo?.projectName,
        region: auth.selectedRegion || undefined,
        detected: detectedPending ? auth.detectedCredentials : undefined,
        gcloudConfigs: auth.gcloudConfigs.map((c) => ({
          name: c.name,
          account: c.account,
          active: c.isActive,
        })),
        projects:
          auth.authStatus === "select_project"
            ? auth.projects.map((p) => ({ id: p.projectId, name: p.displayName }))
            : undefined,
        error: auth.errorMessage ?? undefined,
        warning: auth.warningMessage ?? undefined,
      },
    }),
    actions: () => [
      {
        name: "confirm_detected",
        description:
          "Use the Google credentials the block detected (state.detected), as the block's Use these credentials does.",
        changes: true,
        ...(detectedPending
          ? {}
          : { unavailable: "No detected credential is waiting to be confirmed." }),
      },
      {
        name: "reject_detected",
        description: "Don't use the detected credentials; sign in another way.",
        changes: false,
        ...(detectedPending ? {} : { unavailable: "No detected credential is waiting." }),
      },
      {
        name: "retry_detection",
        description:
          "Look again for Google credentials in the environment and gcloud's application default credentials.",
        changes: false,
        ...(signedIn ? { unavailable: "Already signed in." } : {}),
      },
      {
        name: "sign_in_with_gcloud",
        description: "Sign in with a gcloud configuration, as the block's gcloud tab does.",
        params: {
          config: {
            type: "string",
            description: "A configuration name (state.gcloudConfigs; loaded on first use)",
            required: true,
          },
        },
        changes: true,
        ...(signedIn || signingIn ? { unavailable: "Already signed in or signing in." } : {}),
      },
      {
        name: "start_browser_sign_in",
        description:
          "Start the block's Google sign-in in the browser. The person at the window has to finish it (see needsHuman).",
        changes: true,
        ...(signedIn || signingIn
          ? { unavailable: "Already signed in or signing in." }
          : auth.oauthUnavailable
            ? { unavailable: "Browser sign-in isn't available for this block." }
            : {}),
      },
      {
        name: "cancel_sign_in",
        description: "Stop a browser sign-in that is waiting.",
        changes: false,
        ...(signingIn ? {} : { unavailable: "No sign-in is in progress." }),
      },
      {
        name: "select_project",
        description:
          "Pick the Google Cloud project to use, from state.projects, as the block's project picker does.",
        params: { project_id: { type: "string", description: "A project id", required: true } },
        changes: true,
        ...(auth.authStatus === "select_project"
          ? {}
          : { unavailable: "There is no project to pick now." }),
      },
      {
        name: "change_project",
        description: "Choose another project for the signed-in account.",
        changes: false,
        ...(signedIn ? {} : { unavailable: "Not signed in." }),
      },
      {
        name: "sign_out",
        description:
          "Forget this block's credentials and start over, as the block's Sign in another way does.",
        changes: true,
        ...(signedIn ? {} : { unavailable: "Not signed in." }),
      },
    ],
    act: async (action, params) => {
      switch (action) {
        case "confirm_detected":
          void auth.handleConfirmDetected()
          return { ok: true }
        case "reject_detected":
          auth.handleRejectDetected()
          return { ok: true }
        case "retry_detection":
          auth.handleRetryDetection()
          return { ok: true }
        case "sign_in_with_gcloud": {
          const name = stringParam(params, "config")
          if (!name) return { ok: false, reason: "config is required" }
          auth.setAuthMethod("gcloud")
          if (auth.gcloudConfigs.length === 0) await auth.loadGcloudConfigs()
          defer(() => {
            const config = latestAuth.current.gcloudConfigs.find((c) => c.name === name)
            if (!config) return
            latestAuth.current.setSelectedConfig(config)
            defer(() => void latestAuth.current.handleGcloudAuth())
          })
          return {
            ok: true,
            note: "Signing in; get_block shows the result, or state.error if there is no such configuration.",
          }
        }
        case "start_browser_sign_in":
          auth.setAuthMethod("oauth")
          void auth.handleOAuthLogin()
          return { ok: true, note: "Waiting for the person at the window; see needsHuman." }
        case "cancel_sign_in":
          auth.handleCancelOAuth()
          return { ok: true }
        case "select_project": {
          const picked = auth.projects.find(
            (p) => p.projectId === stringParam(params, "project_id"),
          )
          if (!picked) return { ok: false, reason: "project_id must be one of state.projects" }
          void auth.handleProjectSelect(picked)
          return { ok: true }
        }
        case "change_project":
          void auth.handleChangeProject()
          return { ok: true }
        case "sign_out":
          auth.handleManualAuth()
          return { ok: true }
        default:
          return { ok: false, reason: `Unknown action "${action}"` }
      }
    },
  })

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
      <div
        {...issueAnchor(id)}
        className="runbook-block relative rounded-sm border bg-destructive-muted border-destructive/30 mb-5 p-4"
      >
        <div className="flex items-center text-destructive">
          <XCircle className="size-6 mr-4 flex-shrink-0" />
          <div className="text-md">
            <strong>Invalid Configuration:</strong>
            <br />
            The <code className="bg-destructive-muted px-1 rounded">detectCredentials</code> prop
            contains multiple{" "}
            <code className="bg-destructive-muted px-1 rounded">{`{ block: "..." }`}</code> entries.
            Only one block source is allowed.
          </div>
        </div>
      </div>
    )
  }

  if (hasOauthClientFileConflict) {
    return (
      <div
        {...issueAnchor(id)}
        className="runbook-block relative rounded-sm border bg-destructive-muted border-destructive/30 mb-5 p-4"
      >
        <div className="flex items-center text-destructive">
          <XCircle className="size-6 mr-4 flex-shrink-0" />
          <div className="text-md">
            <strong>Invalid Configuration:</strong>
            <br />
            Supply either <code className="bg-destructive-muted px-1 rounded">oauthClientId</code>/
            <code className="bg-destructive-muted px-1 rounded">oauthClientSecret</code> or{" "}
            <code className="bg-destructive-muted px-1 rounded">oauthClientFile</code>, not both.
          </div>
        </div>
      </div>
    )
  }

  // An access token that has expired, or is about to, shows as a failed sign-in.
  const shownStatus = expiry === "expiring" || expiry === "expired" ? "failed" : auth.authStatus
  const statusClasses = getStatusClasses(shownStatus)
  const iconClasses = getStatusIconClasses(shownStatus)

  // GCP has no account -> role two-step, so AwsAuth's two selection states
  // collapse into one: the tabs hide only while a project is being picked.
  const showTabs = auth.authStatus !== "select_project"
  const showProjectSelector = auth.authStatus === "select_project"

  const done = shownStatus === "authenticated"
  return (
    <AutoCollapse enabled={autoCollapse} done={done}>
      <div
        ref={blockRef}
        data-fold="path"
        data-testid={id}
        className={`runbook-block relative rounded-sm border ${statusClasses} mb-5 p-4`}
      >
        <ProgressStep done={done} />

        {/* ID label - positioned at top right */}
        <div data-fold="keep" className="absolute top-3 right-3 z-20 flex items-center gap-1">
          <BlockIdLabel id={id} size="large" />
          <CollapseButton />
        </div>

        {/* Header with Google Cloud logo */}
        <div data-fold="path" className="flex items-start gap-4 @container">
          <div data-fold="keep" className="border-r border-info/30 pr-3 mr-0 self-stretch">
            <StatusIcon
              status={shownStatus}
              className={`size-6 ${iconClasses} ${auth.authStatus === "authenticating" ? "animate-spin" : ""}`}
            />
          </div>

          <div data-fold="path" className="flex-1 min-w-0">
            {/* Title row with the Google Cloud lockup. The wordmark uses
              currentColor, so light and dark surfaces need no asset swap. */}
            <div data-fold="title" className="flex items-center gap-3 mb-2">
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
            {auth.detectionStatus === "pending" && (
              <div className="mb-4 text-info text-sm flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" />
                <span>
                  {auth.waitingForBlockId ? (
                    <>
                      Waiting for{" "}
                      <BlockLink blockId={auth.waitingForBlockId} className="bg-info-muted" /> to
                      run...
                    </>
                  ) : (
                    "Checking for existing credentials..."
                  )}
                </span>
              </div>
            )}

            {/* Detected credentials: confirm when scopes are sufficient, or show
              recovery when the author required scopes the credential lacks. */}
            {auth.detectionStatus === "detected" &&
              auth.detectedCredentials &&
              ((auth.detectedCredentials.missingScopes?.length ?? 0) > 0 &&
              scopes &&
              scopes.length > 0 ? (
                <InsufficientScopesPrompt
                  credentials={auth.detectedCredentials}
                  requiredScopes={scopes}
                  oauthUnavailable={auth.oauthUnavailable}
                  recovering={auth.authStatus === "authenticating"}
                  onSignIn={() => {
                    void auth.handleSignInWithRequiredScopes()
                  }}
                  onReject={auth.handleRejectDetected}
                  onRetryDetection={auth.handleRetryDetection}
                />
              ) : (
                <DetectedCredentialsPrompt
                  credentials={auth.detectedCredentials}
                  warning={auth.detectionWarning}
                  confirming={auth.authStatus === "authenticating"}
                  onConfirm={auth.handleConfirmDetected}
                  onReject={auth.handleRejectDetected}
                />
              ))}

            {/* Success state */}
            {auth.authStatus === "authenticated" && auth.accountInfo && (
              <AuthSuccess
                accountInfo={auth.accountInfo}
                warningMessage={auth.warningMessage}
                detectionSource={auth.detectedCredentials?.source}
                onChangeProject={auth.handleChangeProject}
                onReAuthenticate={auth.handleManualAuth}
              />
            )}
            {expiry && expiresAt && (
              <CredentialExpiryNotice
                expiresAt={expiresAt}
                expiry={expiry}
                onSignInAgain={auth.handleManualAuth}
              />
            )}

            {/* Detection warning (found credentials but they're invalid) */}
            {auth.detectionWarning &&
              auth.detectionStatus === "done" &&
              auth.authStatus !== "authenticated" && (
                <div className="mb-4 bg-warning-muted border border-warning/30 rounded p-3 text-sm text-warning-foreground flex items-start gap-2">
                  <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
                  <div className="min-w-0">
                    <strong>Invalid credentials detected:</strong> {auth.detectionWarning}
                  </div>
                </div>
              )}

            {/* Error state (for manual auth failures) */}
            {auth.authStatus === "failed" && auth.errorMessage && (
              <div className="mb-4 text-destructive text-sm flex items-start gap-2">
                <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
                <div className="min-w-0">
                  <strong>Authentication failed:</strong> {auth.errorMessage}
                </div>
              </div>
            )}

            {/* Authentication form (only show when not authenticated and detection is done) */}
            {auth.authStatus !== "authenticated" && auth.detectionStatus === "done" && (
              <>
                {/* The hint line and "Check again", which re-runs detection, as in
                    GitAuth. Absent with detection off. */}
                {showTabs && auth.manualHint && (
                  <DetectionHint hint={auth.manualHint} onCheckAgain={auth.handleRetryDetection} />
                )}

                {/* Method tabs (hide during project selection) */}
                {showTabs && (
                  <AuthTabs
                    authMethod={auth.authMethod}
                    setAuthMethod={auth.setAuthMethod}
                    oauthUnavailable={auth.oauthUnavailable}
                  />
                )}

                {/* Service Account Key */}
                {auth.authMethod === "service_account" && showTabs && (
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
                {auth.authMethod === "oauth" && showTabs && (
                  <OAuthFlow
                    authStatus={auth.authStatus}
                    flowId={auth.oauthFlowId}
                    authUrl={auth.oauthAuthUrl}
                    oauthUnavailable={auth.oauthUnavailable}
                    oauthClientFileName={auth.oauthClientFileName}
                    oauthClientFilePath={auth.oauthClientFilePath}
                    onLoadOAuthClientFile={() => {
                      void auth.loadOAuthClientFromFile()
                    }}
                    onClearOAuthClientFile={auth.clearOAuthClientFile}
                    {...(scopes ? { scopes } : {})}
                    selectedRegion={auth.selectedRegion}
                    setSelectedRegion={auth.setSelectedRegion}
                    onStartOAuth={auth.handleOAuthLogin}
                    onCancelOAuth={auth.handleCancelOAuth}
                  />
                )}

                {/* gcloud configuration */}
                {auth.authMethod === "gcloud" && showTabs && (
                  <GcloudConfigSelector
                    authStatus={auth.authStatus}
                    configs={auth.gcloudConfigs}
                    selectedConfig={auth.selectedConfig}
                    setSelectedConfig={auth.setSelectedConfig}
                    loadingConfigs={auth.loadingConfigs}
                    configSearch={auth.configSearch}
                    setConfigSearch={auth.setConfigSearch}
                    adcInfo={auth.adcInfo}
                    adcPrincipal={auth.adcPrincipal}
                    requiredScopes={scopes ?? []}
                    pinnedProject={resolvedProject}
                    defaultRegion={defaultRegion}
                    defaultZone={defaultZone}
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
                    error={auth.errorMessage}
                    searchValue={auth.projectSearch}
                    setSearchValue={auth.setProjectSearch}
                    onProjectSelect={auth.handleProjectSelect}
                    onCancel={auth.handleCancelProjectSelect}
                  />
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </AutoCollapse>
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
GoogleAuth.displayName = "GoogleAuth"

export default GoogleAuth
