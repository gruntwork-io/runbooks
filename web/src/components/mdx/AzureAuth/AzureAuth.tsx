import { useEffect, useRef } from "react"
import { AlertTriangle, Cloud, Info, Loader2 } from "lucide-react"
import { InlineMarkdown } from "@/components/mdx/_shared/components/InlineMarkdown"
import { BlockIdLabel } from "@/components/mdx/_shared"
import { useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"
import { stringParam, useAgentBlock, useAgentDeferred, useLatest } from "@/contexts/useAgentBridge"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { issueAnchor } from "@/contexts/ErrorReportingContext.types"
import { useTemplateContext } from "@/contexts/useRunbook"
import { useInstructionMode } from "@/contexts/useInstructionMode"
import { resolveTemplateReferences } from "@/lib/templateUtils"
import { ErrorDisplay } from "@/components/mdx/_shared/components/ErrorDisplay"
import { DetectionHint } from "@/components/mdx/_shared/components/DetectionHint"
import { DuplicateIdError } from "@/components/mdx/_shared/components/DuplicateIdError"
import { AutoCollapse, CollapseButton } from "@/components/mdx/_shared/components/AutoCollapse"
import { ProgressStep } from "@/components/mdx/_shared/components/ProgressStep"
import { AzureAuthInstruction } from "./AzureAuthInstruction"
import type { AzureAuthProps } from "./types"
import { useAzureAuth } from "./hooks/useAzureAuth"
import { detectionPlan, getStatusClasses, getStatusIconClasses, StatusIcon } from "./utils"
import { AuthTabs } from "./components/AuthTabs"
import { AuthSuccess } from "./components/AuthSuccess"
import { ContextPicker } from "./components/ContextPicker"
import { DetectedCredentialsPrompt } from "./components/DetectedCredentialsPrompt"
import { InteractiveSignIn } from "./components/InteractiveSignIn"
import { ServicePrincipalForm } from "./components/ServicePrincipalForm"

function invalidRequiredRoles(requiredRoles: unknown): boolean {
  if (requiredRoles === undefined) return false
  if (!Array.isArray(requiredRoles)) return true
  return requiredRoles.some(
    (entry) =>
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as { role?: unknown }).role !== "string" ||
      ((entry as { scope?: unknown }).scope !== undefined &&
        typeof (entry as { scope?: unknown }).scope !== "string"),
  )
}

function AzureAuthInteractive({
  id,
  title = "Azure Authentication",
  description,
  tenantId,
  subscriptionId,
  requiredRoles,
  detectCredentials,
  defaultTab,
  inputsId,
  autoCollapse,
}: AzureAuthProps) {
  const templateCtx = useTemplateContext(inputsId)
  const resolve = (value: string | undefined) =>
    value ? resolveTemplateReferences(value, templateCtx) : value
  const resolvedTitle = resolve(title)
  const resolvedDescription = resolve(description)
  const resolvedTenantId = resolve(tenantId)?.trim() || undefined
  const resolvedSubscriptionId = resolve(subscriptionId)?.trim() || undefined
  const rolesInvalid = invalidRequiredRoles(requiredRoles)
  const detectionInvalid = detectionPlan(detectCredentials).invalid

  const blockRef = useRef<HTMLDivElement>(null)
  const { isDuplicate, isNormalizedCollision, collidingId } = useComponentIdRegistry(
    id,
    "AzureAuth",
    blockRef,
  )
  const { reportError, clearError } = useErrorReporting()

  const auth = useAzureAuth({
    id,
    tenantId: resolvedTenantId,
    subscriptionId: resolvedSubscriptionId,
    requiredRoles: rolesInvalid ? undefined : requiredRoles,
    detectCredentials,
    defaultTab,
  })

  useEffect(() => {
    if (isDuplicate) {
      reportError({
        componentId: id,
        componentType: "AzureAuth",
        severity: "error",
        message: `Duplicate component ID: ${id}`,
      })
    } else if (detectionInvalid) {
      reportError({
        componentId: id,
        componentType: "AzureAuth",
        severity: "error",
        message:
          'detectCredentials must be false or an array of "env", "cli" or { env: { prefix } }',
      })
    } else if (rolesInvalid) {
      reportError({
        componentId: id,
        componentType: "AzureAuth",
        severity: "error",
        message: "requiredRoles must be an array of { role, scope } objects",
      })
    } else {
      clearError(id)
    }
  }, [id, isDuplicate, detectionInvalid, rolesInvalid, reportError, clearError])

  // What an AI agent sees of this block and does to it, through the app's MCP
  // server: the same handlers as the block's detection prompt, sign-in tabs
  // and tenant and subscription picker.
  const latestAuth = useLatest(auth)
  const defer = useAgentDeferred()
  const signedIn = auth.authStatus === "authenticated"
  const signingIn = auth.authStatus === "authenticating"
  const detectedPending = auth.detectionStatus === "detected" && auth.detected !== null
  useAgentBlock(id, {
    type: "AzureAuth",
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
      ...(isDuplicate ? [`Duplicate block id "${id}"`] : []),
      ...(detectionInvalid || rolesInvalid ? ["The block's configuration is invalid"] : []),
    ],
    needsHuman: () => {
      if (auth.tenantSignIn) {
        return auth.deviceCode
          ? `Tenant ${auth.tenantSignIn.tenantId} needs a new sign-in: the person at the window must open ${auth.deviceCode.verificationUri} and enter the code ${auth.deviceCode.userCode}.`
          : `Tenant ${auth.tenantSignIn.tenantId} needs a new sign-in: the person at the window must finish it in the browser window az login opened.`
      }
      if (signingIn && auth.deviceCode) {
        return `The person at the window must open ${auth.deviceCode.verificationUri} and enter the code ${auth.deviceCode.userCode} to finish signing in to Azure.`
      }
      if (signingIn)
        return "The person at the window must finish signing in to Azure in the browser window az login opened."
      return undefined
    },
    detail: () => ({
      state: {
        signedInAs: auth.signInInfo?.principal.name,
        tenantId: auth.signInInfo?.tenantId,
        tenantName: auth.signInInfo?.tenantName,
        subscriptionId: auth.signInInfo?.subscriptionId,
        subscriptionName: auth.signInInfo?.subscriptionName,
        detected: detectedPending ? auth.detected : undefined,
        choosing:
          auth.authStatus === "select_context"
            ? {
                tenants: auth.tenants.map((t) => ({
                  id: t.tenantId,
                  name: t.displayName ?? t.defaultDomain,
                })),
                subscriptions: auth.subscriptions.map((sub) => ({
                  id: sub.id,
                  name: sub.name,
                  tenantId: sub.tenantId,
                })),
                selectedTenantId: auth.selectedTenantId,
                selectedSubscriptionId: auth.selectedSubscriptionId,
              }
            : undefined,
        error: auth.errorMessage ?? undefined,
        notice: auth.notice ?? undefined,
        warning: auth.warningMessage ?? undefined,
        azureCliMissing: auth.cliMissing || undefined,
      },
    }),
    actions: () => [
      {
        name: "confirm_detected",
        description:
          "Use the Azure credential the block detected (state.detected), as the block's Use these credentials does.",
        changes: true,
        ...(detectedPending
          ? {}
          : { unavailable: "No detected credential is waiting to be confirmed." }),
      },
      {
        name: "reject_detected",
        description: "Don't use the detected credential; sign in another way.",
        changes: false,
        ...(detectedPending ? {} : { unavailable: "No detected credential is waiting." }),
      },
      {
        name: "retry_detection",
        description: "Look again for an Azure CLI sign-in or service principal in the environment.",
        changes: false,
        ...(signedIn ? { unavailable: "Already signed in." } : {}),
      },
      {
        name: "start_browser_sign_in",
        description:
          "Run az login in the browser on this machine. The person at the window has to finish it (see needsHuman).",
        changes: true,
        ...(signedIn || signingIn ? { unavailable: "Already signed in or signing in." } : {}),
      },
      {
        name: "start_device_code_sign_in",
        description:
          "Run az login with a device code. The person at the window has to enter the code (see needsHuman).",
        changes: true,
        ...(signedIn || signingIn ? { unavailable: "Already signed in or signing in." } : {}),
      },
      {
        name: "cancel_sign_in",
        description: "Stop a sign-in that is waiting.",
        changes: false,
        ...(signingIn || auth.tenantSignIn ? {} : { unavailable: "No sign-in is in progress." }),
      },
      {
        name: "change_tenant",
        description:
          "Open the tenant and subscription picker on this block's sign-in, as the block's Change tenant does, without signing in again. Then use select_context.",
        changes: false,
        ...(signedIn && auth.canChangeTenant
          ? {}
          : {
              unavailable:
                "Only a signed-in user sign-in, with no tenant or subscription pinned, can change tenant.",
            }),
      },
      {
        name: "cancel_change_tenant",
        description: "Close the picker Change tenant opened and keep the current tenant.",
        changes: false,
        ...(auth.authStatus === "select_context" && auth.changingTenant
          ? {}
          : { unavailable: "Change tenant isn't open." }),
      },
      {
        name: "select_context",
        description:
          "Choose the tenant and subscription to use, from state.choosing, as the block's picker does.",
        params: {
          tenant_id: {
            type: "string",
            description: "A tenant id from state.choosing.tenants",
            required: true,
          },
          subscription_id: {
            type: "string",
            description: "A subscription id in that tenant (default: its default subscription)",
          },
        },
        changes: true,
        ...(auth.authStatus === "select_context"
          ? {}
          : { unavailable: "There is no tenant or subscription to choose now." }),
      },
      {
        name: "sign_out",
        description:
          "Forget this block's sign-in and start over, as the block's Sign in another way does.",
        changes: true,
        ...(signedIn ? {} : { unavailable: "Not signed in." }),
      },
    ],
    act: (action, params) => {
      switch (action) {
        case "confirm_detected":
          auth.handleConfirmDetected()
          return { ok: true }
        case "reject_detected":
          auth.handleRejectDetected()
          return { ok: true }
        case "retry_detection":
          auth.handleRetryDetection()
          return { ok: true }
        case "start_browser_sign_in":
          auth.startBrowserLogin()
          return { ok: true, note: "Waiting for the person at the window; see needsHuman." }
        case "start_device_code_sign_in":
          auth.startDeviceCodeLogin()
          return { ok: true, note: "Waiting for the person at the window; see needsHuman." }
        case "cancel_sign_in":
          if (auth.tenantSignIn) auth.handleCancelTenantSignIn()
          else auth.handleCancelLogin()
          return { ok: true }
        case "change_tenant":
          auth.handleChangeTenant()
          return { ok: true }
        case "cancel_change_tenant":
          auth.handleCancelPicker()
          return { ok: true }
        case "select_context": {
          const tenant = stringParam(params, "tenant_id")
          if (!tenant || !auth.tenants.some((t) => t.tenantId === tenant)) {
            return { ok: false, reason: "tenant_id must be one of state.choosing.tenants" }
          }
          const subscription = stringParam(params, "subscription_id")
          if (
            subscription &&
            !auth.subscriptions.some((sub) => sub.id === subscription && sub.tenantId === tenant)
          ) {
            return { ok: false, reason: "subscription_id must be a subscription in that tenant" }
          }
          auth.selectTenant(tenant)
          if (subscription) auth.setSelectedSubscriptionId(subscription)
          // The picker's Continue reads the choice from state, so it waits for the render
          defer(() => latestAuth.current.handleSelectContext())
          return { ok: true }
        }
        case "sign_out":
          auth.handleManualAuth()
          return { ok: true }
        default:
          return { ok: false, reason: `Unknown action "${action}"` }
      }
    },
  })

  if (!id) {
    return (
      <ErrorDisplay
        error={{
          message: "The <AzureAuth> component requires a non-empty 'id' prop.",
          details: "Please provide a unique 'id' for this component instance.",
        }}
      />
    )
  }
  if (isDuplicate) {
    return (
      <DuplicateIdError
        id={id}
        isNormalizedCollision={isNormalizedCollision}
        collidingId={collidingId}
        componentName="AzureAuth"
        className="runbook-block"
      />
    )
  }

  const status = auth.authStatus
  const authenticating = status === "authenticating"
  const done = status === "authenticated"
  const showForms = status !== "authenticated" && status !== "select_context"

  return (
    <AutoCollapse enabled={autoCollapse} done={done}>
      <div
        ref={blockRef}
        // The block shows no message for an invalid prop it reports, so the
        // error summary goes to the block
        {...issueAnchor((detectionInvalid || rolesInvalid) && id)}
        data-fold="path"
        data-testid={id}
        className={`runbook-block relative rounded-sm border ${getStatusClasses(status)} mb-5 p-4`}
      >
        <ProgressStep done={done} />
        <div data-fold="keep" className="absolute top-3 right-3 z-20 flex items-center gap-1">
          <BlockIdLabel id={id} size="large" />
          <CollapseButton />
        </div>

        <div data-fold="path" className="flex items-start gap-4 @container">
          <div data-fold="keep" className="border-r border-warning/30 pr-3 mr-0 self-stretch">
            <StatusIcon
              status={status}
              className={`size-6 ${getStatusIconClasses(status)} ${authenticating ? "animate-spin" : ""}`}
            />
          </div>

          <div data-fold="path" className="flex-1 min-w-0">
            <div data-fold="title" className="flex items-center gap-3 mb-2">
              <span className="inline-flex items-center gap-1 text-info font-semibold">
                <Cloud className="size-5" aria-hidden />
                Azure
              </span>
              <div className="text-md font-bold text-foreground">
                <InlineMarkdown>{resolvedTitle ?? ""}</InlineMarkdown>
              </div>
            </div>

            {resolvedDescription && (
              <div className="text-md text-muted-foreground mb-4">
                <InlineMarkdown>{resolvedDescription}</InlineMarkdown>
              </div>
            )}

            {auth.detectionStatus === "pending" && (status === "pending" || authenticating) && (
              <div className="mb-4 text-info text-sm flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" />
                <span>Checking for an existing Azure sign-in...</span>
              </div>
            )}

            {auth.notice && status === "pending" && auth.detectionStatus !== "pending" && (
              <div
                className="mb-4 text-muted-foreground text-sm flex items-start gap-2"
                role="status"
              >
                <Info className="size-4 mt-0.5 flex-shrink-0" />
                <div className="min-w-0">{auth.notice}</div>
              </div>
            )}

            {auth.detectionStatus === "detected" && auth.detected && status !== "authenticated" && (
              <DetectedCredentialsPrompt
                detected={auth.detected}
                confirming={authenticating}
                onConfirm={auth.handleConfirmDetected}
                onReject={auth.handleRejectDetected}
              />
            )}

            {done && auth.signInInfo && (
              <AuthSuccess
                info={auth.signInInfo}
                warningMessage={auth.warningMessage}
                errorMessage={auth.errorMessage}
                onReAuthenticate={auth.handleManualAuth}
                onChangeTenant={auth.canChangeTenant ? auth.handleChangeTenant : undefined}
                loadingTenants={auth.loadingTenants}
              />
            )}

            {auth.cliMissing && !done && (
              <div className="mb-4 bg-warning-muted border border-warning/30 rounded p-3 text-sm text-warning-foreground flex items-start gap-2">
                <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
                <div className="min-w-0">
                  AzureAuth signs in with the Azure CLI, which isn't installed or isn't on your
                  PATH.{" "}
                  <a
                    className="underline"
                    href="https://learn.microsoft.com/cli/azure/install-azure-cli"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Install the Azure CLI
                  </a>
                  , then click Check again.
                </div>
              </div>
            )}

            {auth.detectionWarning && auth.detectionStatus === "done" && !done && (
              <div className="mb-4 bg-warning-muted border border-warning/30 rounded p-3 text-sm text-warning-foreground flex items-start gap-2">
                <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
                <div className="min-w-0">
                  <strong>Existing sign-in not usable:</strong> {auth.detectionWarning}
                </div>
              </div>
            )}

            {(status === "failed" || status === "select_context") && auth.errorMessage && (
              <div className="mb-4 text-destructive text-sm flex items-start gap-2" role="alert">
                <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
                <div className="min-w-0">
                  <strong>Authentication failed:</strong> {auth.errorMessage}
                </div>
              </div>
            )}

            {status === "select_context" && (
              <ContextPicker
                principal={auth.pickerPrincipal}
                tenants={auth.tenants}
                subscriptions={auth.subscriptions}
                selectedTenantId={auth.selectedTenantId}
                onSelectTenant={auth.selectTenant}
                selectedSubscriptionId={auth.selectedSubscriptionId}
                onSelectSubscription={auth.setSelectedSubscriptionId}
                authenticating={auth.selecting}
                onContinue={auth.handleSelectContext}
                onCancel={auth.handleCancelPicker}
                tenantSignIn={
                  auth.tenantSignIn && {
                    deviceCodeFlow: auth.pickerAuthType === "device_code",
                    deviceCode: auth.deviceCode,
                    onCancel: auth.handleCancelTenantSignIn,
                  }
                }
              />
            )}

            {showForms && auth.detectionStatus === "done" && (
              <>
                {auth.manualHint && !authenticating && (
                  <DetectionHint hint={auth.manualHint} onCheckAgain={auth.handleRetryDetection} />
                )}
                <AuthTabs
                  authMethod={auth.authMethod}
                  setAuthMethod={auth.setAuthMethod}
                  disabled={authenticating}
                />
                {(auth.authMethod === "cli" || auth.authMethod === "device_code") && (
                  <InteractiveSignIn
                    deviceCodeFlow={auth.authMethod === "device_code"}
                    authenticating={authenticating}
                    tenantId={auth.signInTenantId}
                    setTenantId={auth.setSignInTenantId}
                    pinnedTenantId={resolvedTenantId}
                    deviceCode={auth.deviceCode}
                    onStart={
                      auth.authMethod === "device_code"
                        ? auth.startDeviceCodeLogin
                        : auth.startBrowserLogin
                    }
                    onCancel={auth.handleCancelLogin}
                  />
                )}
                {auth.authMethod === "service_principal" && (
                  <ServicePrincipalForm
                    authenticating={authenticating}
                    clientId={auth.clientId}
                    setClientId={auth.setClientId}
                    tenantId={auth.spTenantId}
                    setTenantId={auth.setSpTenantId}
                    pinnedTenantId={resolvedTenantId}
                    clientSecret={auth.clientSecret}
                    setClientSecret={auth.setClientSecret}
                    certificatePath={auth.certificatePath}
                    setCertificatePath={auth.setCertificatePath}
                    useCertificate={auth.useCertificate}
                    setUseCertificate={auth.setUseCertificate}
                    onSubmit={auth.handleServicePrincipal}
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

function AzureAuth(props: AzureAuthProps) {
  const { enabled: instructionMode } = useInstructionMode()
  if (instructionMode) return <AzureAuthInstruction {...props} />
  return <AzureAuthInteractive {...props} />
}

AzureAuth.displayName = "AzureAuth"

export default AzureAuth
