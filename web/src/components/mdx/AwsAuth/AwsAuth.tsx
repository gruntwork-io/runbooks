import { useEffect, useMemo, useRef } from "react"
import { XCircle, AlertTriangle, Loader2 } from "lucide-react"
import awsLogo from "@/assets/aws-logo.svg"
import awsLogoLight from "@/assets/aws-logo-light.svg"
import { InlineMarkdown } from "@/components/mdx/_shared/components/InlineMarkdown"
import { BlockIdLabel } from "@/components/mdx/_shared"
import { useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"
import { stringParam, useAgentBlock, useAgentDeferred, useLatest } from "@/contexts/useAgentBridge"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { issueAnchor } from "@/contexts/ErrorReportingContext.types"
import { useTemplateContext } from "@/contexts/useRunbook"
import { useTheme } from "@/contexts/useTheme"
import { useInstructionMode } from "@/contexts/useInstructionMode"
import { resolveTemplateReferences } from "@/lib/templateUtils"
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
import { getStatusClasses, StatusIcon, getStatusIconClasses } from "./utils"
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

  // Resolve template expressions in display props
  const templateCtx = useTemplateContext(inputsId)
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
    ssoStartUrl,
    ssoRegion,
    ssoAccountId,
    ssoRoleName,
    defaultRegion,
    detectCredentials,
    defaultTab,
  })

  const expiry = useCredentialExpiry(
    auth.authStatus === "authenticated" ? auth.expiresAt : undefined,
  )

  // Load available profiles when profile tab is selected
  const { authMethod, profiles, loadAwsProfiles } = auth
  useEffect(() => {
    if (authMethod === "profile" && profiles.length === 0) {
      void loadAwsProfiles()
    }
  }, [authMethod, profiles.length, loadAwsProfiles])

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
    } else {
      clearError(id)
    }
  }, [id, isDuplicate, hasMultipleBlockSources, reportError, clearError])

  // What an AI agent sees of this block and does to it, through the app's MCP
  // server: the same handlers as the block's detection prompt, profile picker
  // and SSO account and role pickers.
  const latestAuth = useLatest(auth)
  const defer = useAgentDeferred()
  const signedIn = auth.authStatus === "authenticated"
  const signingIn = auth.authStatus === "authenticating"
  const detectedPending = auth.detectionStatus === "detected" && auth.detectedCredentials !== null
  useAgentBlock(id, {
    type: "AwsAuth",
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
      ...(hasMultipleBlockSources ? ["The block's detectCredentials is invalid"] : []),
      ...(auth.waitingForBlockId
        ? [`Waiting for block "${auth.waitingForBlockId}", whose credentials it uses`]
        : []),
    ],
    needsHuman: () =>
      signingIn && auth.authMethod === "sso"
        ? "The person at the window must finish the AWS SSO sign-in in the browser page that opened."
        : undefined,
    detail: () => ({
      state: {
        signedInAs: signedIn ? auth.accountInfo?.arn : undefined,
        accountId: auth.accountInfo?.accountId,
        accountName: auth.accountInfo?.accountName,
        region: auth.selectedDefaultRegion || undefined,
        detected: detectedPending ? auth.detectedCredentials : undefined,
        profiles: auth.profiles.map((p) => ({ name: p.name, type: p.authType })),
        ssoAccounts:
          auth.authStatus === "select_account"
            ? auth.ssoAccounts.map((a) => ({ id: a.accountId, name: a.accountName }))
            : undefined,
        ssoRoles:
          auth.authStatus === "select_role" ? auth.ssoRoles.map((r) => r.roleName) : undefined,
        choosing:
          auth.authStatus === "select_account"
            ? "account"
            : auth.authStatus === "select_role"
              ? "role"
              : undefined,
        error: auth.errorMessage ?? undefined,
        warning: auth.warningMessage ?? undefined,
      },
    }),
    actions: () => [
      {
        name: "confirm_detected",
        description:
          "Use the AWS credentials the block detected (state.detected), as the block's Use these credentials does.",
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
        description: "Look again for AWS credentials in the environment.",
        changes: false,
        ...(signedIn ? { unavailable: "Already signed in." } : {}),
      },
      {
        name: "sign_in_with_profile",
        description:
          "Sign in with a profile from ~/.aws/config, as the block's Profile tab does. An SSO profile may need the person at the window to finish in the browser.",
        params: {
          profile: {
            type: "string",
            description: "A profile name (state.profiles; loaded on first use)",
            required: true,
          },
        },
        changes: true,
        ...(signedIn || signingIn ? { unavailable: "Already signed in or signing in." } : {}),
      },
      {
        name: "start_sso_sign_in",
        description:
          "Start the block's AWS SSO sign-in. The person at the window has to finish it in the browser (see needsHuman); then pick the account and role.",
        changes: true,
        ...(signedIn || signingIn
          ? { unavailable: "Already signed in or signing in." }
          : !ssoStartUrl
            ? { unavailable: "This block has no ssoStartUrl, so it offers no SSO sign-in." }
            : {}),
      },
      {
        name: "select_sso_account",
        description: "Pick the AWS account to use, from state.ssoAccounts.",
        params: { account_id: { type: "string", description: "An account id", required: true } },
        changes: false,
        ...(auth.authStatus === "select_account"
          ? {}
          : { unavailable: "There is no account to pick now." }),
      },
      {
        name: "select_sso_role",
        description:
          "Pick the role to use in that account, from state.ssoRoles, and finish signing in.",
        params: { role: { type: "string", description: "A role name", required: true } },
        changes: true,
        ...(auth.authStatus === "select_role"
          ? {}
          : { unavailable: "There is no role to pick now." }),
      },
      {
        name: "cancel_sign_in",
        description: "Stop an SSO sign-in that is waiting.",
        changes: false,
        ...(signingIn ? {} : { unavailable: "No sign-in is in progress." }),
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
        case "sign_in_with_profile": {
          const name = stringParam(params, "profile")
          if (!name) return { ok: false, reason: "profile is required" }
          auth.setAuthMethod("profile")
          if (auth.profiles.length === 0) await auth.loadAwsProfiles()
          // The profiles and the selection reach the handler through state
          defer(() => {
            const profile = latestAuth.current.profiles.find((p) => p.name === name)
            if (!profile) return
            latestAuth.current.setSelectedProfile(profile)
            defer(() => void latestAuth.current.handleProfileAuth())
          })
          return {
            ok: true,
            note: "Signing in; get_block shows the result, or state.error if there is no such profile.",
          }
        }
        case "start_sso_sign_in":
          auth.setAuthMethod("sso")
          void auth.handleSsoAuth()
          return { ok: true, note: "Waiting for the person at the window; see needsHuman." }
        case "select_sso_account": {
          const account = auth.ssoAccounts.find(
            (a) => a.accountId === stringParam(params, "account_id"),
          )
          if (!account) return { ok: false, reason: "account_id must be one of state.ssoAccounts" }
          void auth.handleSsoAccountSelect(account)
          return { ok: true }
        }
        case "select_sso_role": {
          const role = stringParam(params, "role")
          if (!role || !auth.ssoRoles.some((r) => r.roleName === role)) {
            return { ok: false, reason: "role must be one of state.ssoRoles" }
          }
          auth.setSelectedSsoRole(role)
          defer(() => void latestAuth.current.handleSsoComplete())
          return { ok: true }
        }
        case "cancel_sign_in":
          auth.handleCancelSsoAuth()
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
        componentName="AwsAuth"
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

            {/* Authentication form (only show when not authenticated and detection is done) */}
            {auth.authStatus !== "authenticated" && auth.detectionStatus === "done" && (
              <>
                {/* The hint line and "Check again", which re-runs detection, as in
                    GitAuth. Absent with detection off. */}
                {showTabs && auth.manualHint && (
                  <DetectionHint hint={auth.manualHint} onCheckAgain={auth.handleRetryDetection} />
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
