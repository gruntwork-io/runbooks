import { useEffect, useRef, useState } from "react"
import { useApi } from "@/contexts/ApiContext"
import { useRunbookContext } from "@/contexts/useRunbook"
import { useSession } from "@/contexts/useSession"
import { useSessionHistory } from "@/contexts/useSessionHistory"
import { sensitiveOutput, type OutputValues } from "@/lib/outputValues"
import { parseSavedAzureAuth, type SavedAzureAuth } from "@/lib/sessionHistory"
import { signInHint } from "@/components/mdx/_shared/lib/signInHint"
import type { AzureSignInResultIpc } from "../../../../../../electron/shared/channels.ts"
import { AZURE_SECRET_ENV_VARS } from "../../../../../../src/domain/azure/env.ts"
import type {
  AzureAuthMethod,
  AzureAuthStatus,
  AzureCredentialSource,
  AzureDetectionStatus,
  AzurePrincipal,
  AzureRequiredRole,
  AzureSignInInfo,
  AzureSubscription,
  AzureTenant,
  DetectedAzureCredentials,
} from "../types"
import { detectionPlan, resolveDefaultAuthMethod } from "../utils"

interface UseAzureAuthOptions {
  id: string
  tenantId?: string | undefined
  subscriptionId?: string | undefined
  requiredRoles?: AzureRequiredRole[] | undefined
  detectCredentials?: false | AzureCredentialSource[] | undefined
  defaultTab?: string | undefined
}

/** How often a running `az login` is polled. */
const POLL_INTERVAL_MS = 2000

const SECRET_NAMES = new Set<string>(AZURE_SECRET_ENV_VARS)

/** The block's outputs for a sign-in: its env vars (secrets sensitive) and names. */
function outputsFor(env: Record<string, string>, info: AzureSignInInfo): OutputValues {
  const outputs: OutputValues = {}
  for (const [name, value] of Object.entries(env)) {
    outputs[name] = SECRET_NAMES.has(name) ? sensitiveOutput(value) : value
  }
  if (info.tenantName) outputs.AZURE_TENANT_NAME = info.tenantName
  if (info.subscriptionName) outputs.AZURE_SUBSCRIPTION_NAME = info.subscriptionName
  outputs.__AUTHENTICATED = "true"
  return outputs
}

export function useAzureAuth({
  id,
  tenantId,
  subscriptionId,
  requiredRoles,
  detectCredentials,
  defaultTab,
}: UseAzureAuthOptions) {
  const api = useApi()
  const { registerOutputs } = useRunbookContext()
  const { isReady: sessionReady } = useSession()
  const history = useSessionHistory()

  // The sign-in the session's history has for this block. The block starts
  // signed in to it and checks it below.
  const [restored] = useState(() => {
    const saved = parseSavedAzureAuth(history.saved(id, "auth"))
    return saved?.status === "signed-in" ? saved : undefined
  })

  const plan = detectionPlan(detectCredentials)

  const [authMethod, setAuthMethod] = useState<AzureAuthMethod>(() =>
    resolveDefaultAuthMethod(defaultTab),
  )
  const [authStatus, setAuthStatus] = useState<AzureAuthStatus>(
    restored ? "authenticated" : "pending",
  )
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [warningMessage, setWarningMessage] = useState<string | null>(null)
  const [cliMissing, setCliMissing] = useState(false)
  const [signInInfo, setSignInInfo] = useState<AzureSignInInfo | null>(
    restored
      ? {
          authType: restored.authType,
          principal: restored.principal,
          tenantId: restored.tenantId,
          tenantName: restored.tenantName,
          subscriptionId: restored.subscriptionId,
          subscriptionName: restored.subscriptionName,
        }
      : null,
  )

  // Detection
  const [detectionStatus, setDetectionStatus] = useState<AzureDetectionStatus>(
    plan.length === 0 || restored ? "done" : "pending",
  )
  const [detected, setDetected] = useState<DetectedAzureCredentials | null>(null)
  const [detectionWarning, setDetectionWarning] = useState<string | null>(null)
  const [nothingDetected, setNothingDetected] = useState(false)
  const [detectionAttempt, setDetectionAttempt] = useState(restored ? -1 : 0)

  // Forms
  const [signInTenantId, setSignInTenantId] = useState(tenantId ?? "")
  const [clientId, setClientId] = useState("")
  const [spTenantId, setSpTenantId] = useState(tenantId ?? "")
  const [clientSecret, setClientSecret] = useState("")
  const [certificatePath, setCertificatePath] = useState("")
  const [useCertificate, setUseCertificate] = useState(false)

  // Device code prompt, once az prints it
  const [deviceCode, setDeviceCode] = useState<{
    verificationUri: string
    userCode: string
  } | null>(null)

  // Tenant and subscription picker
  const [pickerPrincipal, setPickerPrincipal] = useState<AzurePrincipal | null>(null)
  const [tenants, setTenants] = useState<AzureTenant[]>([])
  const [subscriptions, setSubscriptions] = useState<AzureSubscription[]>([])
  const [selectedTenantId, setSelectedTenantId] = useState("")
  const [selectedSubscriptionId, setSelectedSubscriptionId] = useState("")

  // Each sign-in attempt runs under its own number, and acts on a reply only
  // while that number is current, so cancel, re-auth and unmount end it even
  // with a reply in flight.
  const flowRef = useRef(0)
  const loginFlowIdRef = useRef<string | null>(null)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const pins = {
    ...(tenantId ? { tenantId } : {}),
    ...(subscriptionId ? { subscriptionId } : {}),
    ...(requiredRoles && requiredRoles.length > 0 ? { requiredRoles } : {}),
  }

  function stopLogin() {
    flowRef.current++
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current)
    pollTimerRef.current = null
    const flowId = loginFlowIdRef.current
    loginFlowIdRef.current = null
    if (flowId) void api.invoke("azure:login-cancel", { flowId }).catch(() => {})
    setDeviceCode(null)
  }

  // End a running az login when the block goes away.
  useEffect(
    () => () => {
      flowRef.current++
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current)
      const flowId = loginFlowIdRef.current
      loginFlowIdRef.current = null
      if (flowId) void api.invoke("azure:login-cancel", { flowId }).catch(() => {})
    },
    [api],
  )

  function publish(result: Extract<AzureSignInResultIpc, { status: "authenticated" }>) {
    const info: AzureSignInInfo = {
      authType: result.authType,
      principal: result.principal,
      tenantId: result.tenantId,
      tenantName: result.tenantName,
      subscriptionId: result.subscriptionId,
      subscriptionName: result.subscriptionName,
    }
    registerOutputs(id, outputsFor(result.env, info))
    setSignInInfo(info)
    setAuthStatus("authenticated")
    setErrorMessage(null)
    setWarningMessage(result.sessionEnvWarning ?? null)
    history.record(id, "auth", {
      status: "signed-in",
      block: "azure",
      authType: result.authType,
      principal: result.principal,
      tenantId: result.tenantId,
      ...(result.tenantName ? { tenantName: result.tenantName } : {}),
      ...(result.subscriptionId ? { subscriptionId: result.subscriptionId } : {}),
      ...(result.subscriptionName ? { subscriptionName: result.subscriptionName } : {}),
      configDir: result.configDir,
      env: result.env,
    } satisfies SavedAzureAuth)
  }

  /** Act on where a sign-in stands. */
  function handleResult(result: AzureSignInResultIpc) {
    switch (result.status) {
      case "authenticated":
        publish(result)
        return
      case "select_context": {
        setPickerPrincipal(result.principal)
        setTenants(result.tenants)
        setSubscriptions(result.subscriptions)
        const firstTenant =
          result.tenants.find((t) => t.tenantId === result.principal.tenantId) ?? result.tenants[0]
        const tenant = firstTenant?.tenantId ?? ""
        setSelectedTenantId(tenant)
        const inTenant = result.subscriptions.filter((s) => s.tenantId === tenant)
        setSelectedSubscriptionId((inTenant.find((s) => s.isDefault) ?? inTenant[0])?.id ?? "")
        setAuthStatus("select_context")
        setErrorMessage(null)
        return
      }
      case "failed":
        setAuthStatus("failed")
        setErrorMessage(result.error)
        if (result.cliMissing) setCliMissing(true)
        return
    }
  }

  async function run(call: () => Promise<AzureSignInResultIpc>) {
    stopLogin()
    const flow = flowRef.current
    setAuthStatus("authenticating")
    setErrorMessage(null)
    try {
      const result = await call()
      if (flowRef.current !== flow) return
      handleResult(result)
    } catch (err) {
      if (flowRef.current !== flow) return
      setAuthStatus("failed")
      setErrorMessage(err instanceof Error ? err.message : String(err))
    }
  }

  // -------------------------------------------------------------------------
  // Restore
  // -------------------------------------------------------------------------

  // A restored sign-in is published at once, then checked: its config dir is
  // gone after an app restart, and its tokens can expire.
  useEffect(() => {
    if (!restored) return
    const info: AzureSignInInfo = {
      authType: restored.authType,
      principal: restored.principal,
      tenantId: restored.tenantId,
      tenantName: restored.tenantName,
      subscriptionId: restored.subscriptionId,
      subscriptionName: restored.subscriptionName,
    }
    registerOutputs(id, outputsFor(restored.env, info))
    const flow = flowRef.current
    void api
      .invoke("azure:validate-session", {
        blockId: id,
        configDir: restored.configDir,
        tenantId: restored.tenantId,
      })
      .then((data) => {
        if (flowRef.current !== flow || data.valid) return
        flowRef.current++
        registerOutputs(id, { __AUTHENTICATED: "false" })
        history.record(id, "auth", { status: "signed-out" } satisfies SavedAzureAuth)
        setSignInInfo(null)
        setAuthStatus("failed")
        setErrorMessage(
          `The saved Azure sign-in no longer works (${data.error ?? "it was refused"}). Sign in again.`,
        )
      })
      .catch(() => {})
    // Runs once, for the sign-in the block mounted with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // -------------------------------------------------------------------------
  // Detection
  // -------------------------------------------------------------------------

  const planKey = JSON.stringify(plan)
  useEffect(() => {
    if (!sessionReady || detectionAttempt < 0) return
    const steps = JSON.parse(planKey) as ReturnType<typeof detectionPlan>
    if (steps.length === 0) return
    let cancelled = false
    void (async () => {
      const warnings: string[] = []
      for (const step of steps) {
        try {
          const data = await api.invoke("azure:detect", {
            ...(step.prefix !== undefined ? { prefix: step.prefix } : {}),
            sources: [step.source],
          })
          if (cancelled) return
          if (data.cliMissing) setCliMissing(true)
          if (data.found && data.source && data.principalName) {
            setDetected({
              source: data.source,
              prefix: step.prefix,
              principalName: data.principalName,
              tenantId: data.tenantId,
              subscriptionId: data.subscriptionId,
              subscriptionName: data.subscriptionName,
              envVarPrefix: data.envVarPrefix,
            })
            setDetectionWarning(null)
            setNothingDetected(false)
            setDetectionStatus("detected")
            return
          }
          if (data.error && !data.cliMissing) warnings.push(data.error)
        } catch (err) {
          if (cancelled) return
          warnings.push(err instanceof Error ? err.message : String(err))
        }
      }
      if (cancelled) return
      setDetectionWarning(warnings[0] ?? null)
      setNothingDetected(warnings.length === 0)
      setDetectionStatus("done")
    })()
    return () => {
      cancelled = true
    }
  }, [api, sessionReady, planKey, detectionAttempt])

  function handleConfirmDetected() {
    if (!detected) return
    const found = detected
    void run(() =>
      api.invoke("azure:confirm-detected", {
        blockId: id,
        source: found.source,
        ...(found.prefix ? { prefix: found.prefix } : {}),
        ...pins,
      }),
    ).then(() => setDetectionStatus("done"))
  }

  function handleRejectDetected() {
    setDetected(null)
    setDetectionWarning(null)
    setNothingDetected(false)
    setDetectionStatus("done")
  }

  function handleRetryDetection() {
    setDetected(null)
    setDetectionWarning(null)
    setCliMissing(false)
    if (plan.length > 0) setDetectionStatus("pending")
    setDetectionAttempt((n) => Math.max(n, 0) + 1)
  }

  // -------------------------------------------------------------------------
  // Interactive sign-in (browser or device code)
  // -------------------------------------------------------------------------

  async function startLogin(useDeviceCode: boolean) {
    stopLogin()
    const flow = flowRef.current
    setAuthStatus("authenticating")
    setErrorMessage(null)
    const tenant = (tenantId ?? signInTenantId).trim()
    try {
      const started = await api.invoke("azure:login-start", {
        blockId: id,
        deviceCode: useDeviceCode,
        ...(tenant ? { tenantId: tenant } : {}),
      })
      if (flowRef.current !== flow) {
        if (started.flowId) void api.invoke("azure:login-cancel", { flowId: started.flowId })
        return
      }
      if (!started.flowId) {
        handleResult({
          status: "failed",
          error: started.error ?? "Couldn't start az login",
          ...(started.cliMissing ? { cliMissing: true } : {}),
        })
        return
      }
      loginFlowIdRef.current = started.flowId
      const flowId = started.flowId
      const poll = async () => {
        try {
          const data = await api.invoke("azure:login-poll", {
            flowId,
            ...pins,
            // A tenant typed for this sign-in pins the context like the prop.
            ...(tenant ? { tenantId: tenant } : {}),
          })
          if (flowRef.current !== flow) return
          if (data.status === "pending") {
            if (data.verificationUri && data.userCode) {
              setDeviceCode({ verificationUri: data.verificationUri, userCode: data.userCode })
            }
            pollTimerRef.current = setTimeout(() => void poll(), POLL_INTERVAL_MS)
            return
          }
          loginFlowIdRef.current = null
          setDeviceCode(null)
          handleResult(data)
        } catch (err) {
          if (flowRef.current !== flow) return
          loginFlowIdRef.current = null
          setAuthStatus("failed")
          setErrorMessage(err instanceof Error ? err.message : String(err))
        }
      }
      pollTimerRef.current = setTimeout(() => void poll(), POLL_INTERVAL_MS / 2)
    } catch (err) {
      if (flowRef.current !== flow) return
      setAuthStatus("failed")
      setErrorMessage(err instanceof Error ? err.message : String(err))
    }
  }

  function handleCancelLogin() {
    stopLogin()
    setAuthStatus("pending")
    setErrorMessage(null)
  }

  // -------------------------------------------------------------------------
  // Service principal
  // -------------------------------------------------------------------------

  function handleServicePrincipal() {
    const tenant = (tenantId ?? spTenantId).trim()
    void run(() =>
      api.invoke("azure:service-principal", {
        blockId: id,
        clientId: clientId.trim(),
        tenantId: tenant,
        ...(useCertificate ? { certificatePath: certificatePath.trim() } : { clientSecret }),
        ...(subscriptionId ? { subscriptionId } : {}),
        ...(requiredRoles && requiredRoles.length > 0 ? { requiredRoles } : {}),
      }),
    ).then(() => setClientSecret(""))
  }

  // -------------------------------------------------------------------------
  // Picker
  // -------------------------------------------------------------------------

  function selectTenant(next: string) {
    setSelectedTenantId(next)
    const inTenant = subscriptions.filter((s) => s.tenantId === next)
    setSelectedSubscriptionId((inTenant.find((s) => s.isDefault) ?? inTenant[0])?.id ?? "")
  }

  function handleSelectContext() {
    if (!selectedTenantId) return
    void run(() =>
      api.invoke("azure:select-context", {
        blockId: id,
        tenantId: selectedTenantId,
        ...(selectedSubscriptionId ? { subscriptionId: selectedSubscriptionId } : {}),
        ...(requiredRoles && requiredRoles.length > 0 ? { requiredRoles } : {}),
      }),
    )
  }

  // -------------------------------------------------------------------------
  // Re-authenticate
  // -------------------------------------------------------------------------

  function handleManualAuth() {
    stopLogin()
    // Withdraw the outputs so azureAuthId steps stop until the next sign-in.
    registerOutputs(id, { __AUTHENTICATED: "false" })
    history.record(id, "auth", { status: "signed-out" } satisfies SavedAzureAuth)
    setAuthStatus("pending")
    setErrorMessage(null)
    setWarningMessage(null)
    setSignInInfo(null)
    setDetected(null)
    setDetectionWarning(null)
    setNothingDetected(false)
    setDetectionStatus("done")
  }

  return {
    authMethod,
    setAuthMethod,
    authStatus,
    errorMessage,
    warningMessage,
    cliMissing,
    signInInfo,

    detectionStatus,
    detected,
    detectionWarning,
    manualHint:
      plan.length === 0
        ? null
        : signInHint({ invalidDetected: detectionWarning !== null, nothingDetected }),

    signInTenantId,
    setSignInTenantId,
    clientId,
    setClientId,
    spTenantId,
    setSpTenantId,
    clientSecret,
    setClientSecret,
    certificatePath,
    setCertificatePath,
    useCertificate,
    setUseCertificate,
    deviceCode,

    pickerPrincipal,
    tenants,
    subscriptions,
    selectedTenantId,
    selectTenant,
    selectedSubscriptionId,
    setSelectedSubscriptionId,

    handleConfirmDetected,
    handleRejectDetected,
    handleRetryDetection,
    startBrowserLogin: () => void startLogin(false),
    startDeviceCodeLogin: () => void startLogin(true),
    handleCancelLogin,
    handleServicePrincipal,
    handleSelectContext,
    handleManualAuth,
  }
}
