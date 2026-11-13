import { useEffect, useMemo, useRef, useState } from "react"
import { XCircle, AlertTriangle, Loader2 } from "lucide-react"
import awsLogo from "@/assets/aws-logo.svg"
import awsLogoLight from "@/assets/aws-logo-light.svg"
import { InlineMarkdown } from "@/components/mdx/_shared/components/InlineMarkdown"
import { BlockIdLabel } from "@/components/mdx/_shared"
import { useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { useTheme } from "@/contexts/useTheme"
import { useInstructionMode } from "@/contexts/useInstructionMode"
import { resolveTemplateReferences, resolveTemplateValue } from "@/lib/templateUtils"
import {
  extractTemplateDependenciesFromString,
  requireAllOutputs,
} from "@/lib/extractTemplateDependencies"
import { useTemplateDependencies } from "@/components/mdx/_shared/hooks/useTemplateDependencies"
import { UnmetDependenciesWarning } from "@/components/mdx/_shared/components/UnmetDependenciesWarning"
import { AwsAuthInstruction } from "./AwsAuthInstruction"

import { ErrorDisplay } from "@/components/mdx/_shared/components/ErrorDisplay"
import { BlockLink } from "@/components/mdx/_shared/components/BlockLink"
import { CredentialExpiryNotice } from "@/components/mdx/_shared/components/CredentialExpiryNotice"
import { DetectionHint } from "@/components/mdx/_shared/components/DetectionHint"
import { useCredentialExpiry } from "@/components/mdx/_shared/hooks/useCredentialExpiry"
import { DuplicateIdError } from "@/components/mdx/_shared/components/DuplicateIdError"
import { AutoCollapse, CollapseButton } from "@/components/mdx/_shared/components/AutoCollapse"
import { ProgressStep } from "@/components/mdx/_shared/components/ProgressStep"
import type { AppError } from "@/types/error"
import type { AwsAuthProps } from "./types"
import { useAwsAuth } from "./hooks/useAwsAuth"
import { getStatusClasses, StatusIcon, getStatusIconClasses, ssoPortals } from "./utils"
import { AuthTabs } from "./components/AuthTabs"
import { AuthSuccess } from "./components/AuthSuccess"
import { CredentialsForm } from "./components/CredentialsForm"
import { SsoForm, SsoAccountSelector, SsoRoleSelector } from "./components/SsoFlow"
import { ProfileSelector } from "./components/ProfileSelector"
import { DetectedCredentialsPrompt } from "./components/DetectedCredentialsPrompt"

function unresolvablePropMessage(prop: string): string {
  return `The <AwsAuth> ${prop} prop can't be resolved to a value to sign in with.`
}

function AwsAuthInteractive({
  id,
  title = "AWS Authentication",
  description,
  ssoStartUrl,
  ssoRegion = "us-east-1",
  ssoAccountId,
  ssoRoleName,
  defaultRegion = "us-east-1",
  detectCredentials = ["env"], // Default: auto-detect from env vars
  defaultTab,
  inputsId,
  autoCollapse,
}: AwsAuthProps) {
  const validationError = useMemo((): AppError | null => {
    if (!id) {
      return {
        message: "The <AwsAuth> component requires a non-empty 'id' prop.",
        details: "Please provide a unique 'id' for this component instance.",
      }
    }
    return null
  }, [id])

  // The sign-in props can read inputs and other blocks' outputs, such as an
  // account ID an earlier block creates. They resolve client-side, which can't
  // evaluate a `hasKey` guard, so every output they reference is required, and
  // the block waits for them before it offers a sign-in.
  const signInDeps = useMemo(
    () =>
      requireAllOutputs(
        extractTemplateDependenciesFromString(
          ...[ssoStartUrl, ssoRegion, ssoAccountId, ssoRoleName, defaultRegion].filter(
            (prop): prop is string => prop !== undefined,
          ),
        ),
      ),
    [ssoStartUrl, ssoRegion, ssoAccountId, ssoRoleName, defaultRegion],
  )
  const {
    unmetInputDeps,
    unmetOutputDeps,
    hasAllDependencies: signInReady,
    inputs,
    outputs,
  } = useTemplateDependencies(signInDeps, inputsId)
  const templateCtx = useMemo(() => ({ inputs, outputs }), [inputs, outputs])
  // A prop without references is used as it is. One with references waits for
  // them, then gets their values themselves, a sensitive output's included.
  const resolve = (value: string | undefined) => {
    if (value === undefined || !value.includes("{{")) return value
    return signInReady ? resolveTemplateValue(value, templateCtx) : undefined
  }
  // A sign-in prop whose references are all there but which still doesn't
  // resolve, such as one that pipes a value: it can't be signed in with.
  const unresolvableProp = signInReady
    ? Object.entries({ ssoStartUrl, ssoRegion, ssoAccountId, ssoRoleName, defaultRegion }).find(
        ([, value]) =>
          value?.includes("{{") && resolveTemplateValue(value, templateCtx) === undefined,
      )?.[0]
    : undefined
  const resolvedStartUrl = resolve(ssoStartUrl)
  const resolvedSsoRegion = resolve(ssoRegion) ?? "us-east-1"
  const resolvedAccountId = resolve(ssoAccountId)
  const resolvedRoleName = resolve(ssoRoleName)
  const resolvedDefaultRegion = resolve(defaultRegion) ?? "us-east-1"

  // Resolve template expressions in display props
  const resolvedTitle = useMemo(
    () => (title ? resolveTemplateReferences(title, templateCtx) : title),
    [title, templateCtx],
  )
  const resolvedDescription = useMemo(
    () => (description ? resolveTemplateReferences(description, templateCtx) : description),
    [description, templateCtx],
  )

  // Check for duplicate component IDs (including normalized collisions like "a-b" vs "a_b")
  const blockRef = useRef<HTMLDivElement>(null)
  const { isDuplicate, isNormalizedCollision, collidingId } = useComponentIdRegistry(
    id,
    "AwsAuth",
    blockRef,
  )

  // Validate detectCredentials configuration: only one { block: string } source allowed
  const blockSources = Array.isArray(detectCredentials)
    ? detectCredentials.filter((s) => typeof s === "object" && "block" in s)
    : []
  const hasMultipleBlockSources = blockSources.length > 1

  // Error reporting context (for configuration errors only)
  const { reportError, clearError } = useErrorReporting()

  // Theme — swap the AWS wordmark for its light variant on dark surfaces
  const { resolvedTheme } = useTheme()

  const auth = useAwsAuth({
    id,
    ssoStartUrl: resolvedStartUrl,
    ssoRegion: resolvedSsoRegion,
    ssoAccountId: resolvedAccountId,
    ssoRoleName: resolvedRoleName,
    defaultRegion: resolvedDefaultRegion,
    detectCredentials,
    defaultTab,
    ready: signInReady,
  })

  // A templated default region resolves after the region picker has started,
  // so the picker follows it when it does.
  const [prevDefaultRegion, setPrevDefaultRegion] = useState(resolvedDefaultRegion)
  if (prevDefaultRegion !== resolvedDefaultRegion) {
    setPrevDefaultRegion(resolvedDefaultRegion)
    auth.setSelectedDefaultRegion(resolvedDefaultRegion)
  }

  const expiry = useCredentialExpiry(
    auth.authStatus === "authenticated" ? auth.expiresAt : undefined,
  )

  // Load the local profiles when the Local Profile tab opens, or the SSO tab
  // opens with no start URL from the runbook: their portals are suggestions.
  const { authMethod, profiles, loadAwsProfiles } = auth
  useEffect(() => {
    const wanted = authMethod === "profile" || (authMethod === "sso" && !resolvedStartUrl)
    if (wanted && profiles.length === 0) {
      void loadAwsProfiles()
    }
  }, [authMethod, resolvedStartUrl, profiles.length, loadAwsProfiles])

  // Report configuration errors only
  useEffect(() => {
    if (isDuplicate) {
      reportError({
        componentId: id,
        componentType: "AwsAuth",
        severity: "error",
        message: `Duplicate component ID: ${id}`,
      })
    } else if (hasMultipleBlockSources) {
      reportError({
        componentId: id,
        componentType: "AwsAuth",
        severity: "error",
        message: `Multiple block sources in detectCredentials: only one { block: string } is allowed`,
      })
    } else if (unresolvableProp) {
      reportError({
        componentId: id,
        componentType: "AwsAuth",
        severity: "error",
        message: unresolvablePropMessage(unresolvableProp),
      })
    } else {
      clearError(id)
    }
  }, [id, isDuplicate, hasMultipleBlockSources, unresolvableProp, reportError, clearError])

  if (validationError) {
    return <ErrorDisplay error={validationError} />
  }

  if (isDuplicate) {
    return (
      <DuplicateIdError
        id={id}
        isNormalizedCollision={isNormalizedCollision}
        collidingId={collidingId}
        componentName="AwsAuth"
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

  if (unresolvableProp) {
    return (
      <ErrorDisplay
        error={{
          message: unresolvablePropMessage(unresolvableProp),
          details:
            "A sign-in prop can read plain {{ .inputs.name }} and {{ .outputs.block.name }} references, but not pipes or template logic.",
        }}
      />
    )
  }

  // Credentials that have expired, or are about to, show as a failed sign-in.
  const shownStatus = expiry === "expiring" || expiry === "expired" ? "failed" : auth.authStatus
  const statusClasses = getStatusClasses(shownStatus)
  const iconClasses = getStatusIconClasses(shownStatus)

  const showTabs = auth.authStatus !== "select_account" && auth.authStatus !== "select_role"
  const showSsoAccountSelector = auth.authStatus === "select_account"
  const showSsoRoleSelector = auth.authStatus === "select_role" && auth.selectedSsoAccount

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

        {/* Header with AWS Logo */}
        <div data-fold="path" className="flex items-start gap-4 @container">
          <div data-fold="keep" className="border-r border-warning/30 pr-3 mr-0 self-stretch">
            <StatusIcon
              status={shownStatus}
              className={`size-6 ${iconClasses} ${auth.authStatus === "authenticating" ? "animate-spin" : ""}`}
            />
          </div>

          <div data-fold="path" className="flex-1 min-w-0">
            {/* Title row with AWS logo */}
            <div data-fold="title" className="flex items-center gap-3 mb-2">
              <img
                src={resolvedTheme === "dark" ? awsLogoLight : awsLogo}
                alt="AWS"
                className="h-6"
              />
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
            {auth.detectionStatus === "pending" && signInReady && (
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

            {/* Detected credentials confirmation prompt */}
            {auth.detectionStatus === "detected" && auth.detectedCredentials && (
              <DetectedCredentialsPrompt
                credentials={auth.detectedCredentials}
                warning={auth.detectionWarning}
                confirming={auth.authStatus === "authenticating"}
                onConfirm={auth.handleConfirmDetected}
                onReject={auth.handleRejectDetected}
              />
            )}

            {/* Success state */}
            {auth.authStatus === "authenticated" && auth.accountInfo && (
              <AuthSuccess
                accountInfo={auth.accountInfo}
                warningMessage={auth.warningMessage}
                detectionSource={auth.detectedCredentials?.source}
                onReAuthenticate={auth.handleManualAuth}
              />
            )}
            {expiry && auth.expiresAt && (
              <CredentialExpiryNotice
                expiresAt={auth.expiresAt}
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

            {/* Waiting for the values the sign-in props read */}
            {auth.authStatus !== "authenticated" && !signInReady && (
              <UnmetDependenciesWarning
                blockType="aws-auth"
                unmetInputDeps={unmetInputDeps}
                unmetOutputDeps={unmetOutputDeps}
              />
            )}

            {/* Authentication form (only show when not authenticated and detection is done) */}
            {auth.authStatus !== "authenticated" &&
              auth.detectionStatus === "done" &&
              signInReady && (
                <>
                  {/* The hint line and "Check again", which re-runs detection, as in
                    GitAuth. Absent with detection off. */}
                  {showTabs && auth.manualHint && (
                    <DetectionHint
                      hint={auth.manualHint}
                      onCheckAgain={auth.handleRetryDetection}
                    />
                  )}

                  {/* Method tabs (hide during account/role selection) */}
                  {showTabs && (
                    <AuthTabs authMethod={auth.authMethod} setAuthMethod={auth.setAuthMethod} />
                  )}

                  {/* Static Credentials Form */}
                  {auth.authMethod === "credentials" && showTabs && (
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
                  {auth.authMethod === "sso" && showTabs && (
                    <SsoForm
                      authStatus={auth.authStatus}
                      ssoStartUrl={auth.ssoStartUrl}
                      portalInput={
                        resolvedStartUrl
                          ? undefined
                          : {
                              portal: auth.portal,
                              setPortal: auth.setPortal,
                              configured: ssoPortals(auth.profiles),
                            }
                      }
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
                  {auth.authMethod === "profile" && showTabs && (
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
                </>
              )}
          </div>
        </div>
      </div>
    </AutoCollapse>
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
AwsAuth.displayName = "AwsAuth"

export default AwsAuth
