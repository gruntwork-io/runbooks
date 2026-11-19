import { useEffect, useRef } from "react"
import { AlertTriangle, Cloud, Info, Loader2 } from "lucide-react"
import { InlineMarkdown } from "@/components/mdx/_shared/components/InlineMarkdown"
import { BlockIdLabel } from "@/components/mdx/_shared"
import { useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"
import { useErrorReporting } from "@/contexts/useErrorReporting"
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
                onReAuthenticate={auth.handleManualAuth}
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
                onCancel={auth.handleManualAuth}
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
