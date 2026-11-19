import { useEffect, useEffectEvent, useRef, useState } from "react"
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

type Authenticated = Extract<AzureSignInResultIpc, { status: "authenticated" }>
type SavedSignIn = Extract<SavedAzureAuth, { status: "signed-in" }>
type DetectedFrom = NonNullable<SavedSignIn["detected"]>

const POLL_INTERVAL_MS = 2000

const RESTARTED_MESSAGE = "Runbooks was restarted, so sign in again."

const SECRET_NAMES = new Set<string>(AZURE_SECRET_ENV_VARS)

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

function infoOf(saved: Omit<Authenticated, "status" | "env" | "configDir">): AzureSignInInfo {
  return {
    authType: saved.authType,
    principal: saved.principal,
    tenantId: saved.tenantId,
    tenantName: saved.tenantName,
    subscriptionId: saved.subscriptionId,
    subscriptionName: saved.subscriptionName,
  }
}

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

  const [restoredAtMount] = useState(() => {
    const saved = parseSavedAzureAuth(history.saved(id, "auth"))
    return saved?.status === "signed-in" ? saved : undefined
  })

  const { steps: plan } = detectionPlan(detectCredentials)

  const [authMethod, setAuthMethod] = useState<AzureAuthMethod>(() =>
    resolveDefaultAuthMethod(defaultTab),
  )
  const [authStatus, setAuthStatus] = useState<AzureAuthStatus>(
    restoredAtMount ? "authenticated" : "pending",
  )
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [warningMessage, setWarningMessage] = useState<string | null>(null)
  const [cliMissing, setCliMissing] = useState(false)
  const [signInInfo, setSignInInfo] = useState<AzureSignInInfo | null>(
    restoredAtMount ? infoOf(restoredAtMount) : null,
  )

  const [detectionStatus, setDetectionStatus] = useState<AzureDetectionStatus>(
    plan.length === 0 || restoredAtMount ? "done" : "pending",
  )
  const [detected, setDetected] = useState<DetectedAzureCredentials | null>(null)
  const [detectionWarning, setDetectionWarning] = useState<string | null>(null)
  const [nothingDetected, setNothingDetected] = useState(false)
  const [detectionAttempt, setDetectionAttempt] = useState(restoredAtMount ? -1 : 0)

  const [signInTenantId, setSignInTenantId] = useState(tenantId ?? "")
  const [clientId, setClientId] = useState("")
  const [spTenantId, setSpTenantId] = useState(tenantId ?? "")
  const [clientSecret, setClientSecret] = useState("")
  const [certificatePath, setCertificatePath] = useState("")
  const [useCertificate, setUseCertificate] = useState(false)
  const [deviceCode, setDeviceCode] = useState<{
    verificationUri: string
    userCode: string
  } | null>(null)

  const [pickerPrincipal, setPickerPrincipal] = useState<AzurePrincipal | null>(null)
  const [tenants, setTenants] = useState<AzureTenant[]>([])
  const [subscriptions, setSubscriptions] = useState<AzureSubscription[]>([])
  const [selectedTenantId, setSelectedTenantId] = useState("")
  const [selectedSubscriptionId, setSelectedSubscriptionId] = useState("")
  const [selecting, setSelecting] = useState(false)

  const flowRef = useRef(0)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The existing sign-in the current sign-in came from, saved with it.
  const detectedFromRef = useRef<DetectedFrom | undefined>(restoredAtMount?.detected)
  // A restored sign-in whose config dir ended with Runbooks: the next detection
  // signs in with it again, without asking, if it finds the same sign-in.
  const resumeFromRef = useRef<SavedSignIn | undefined>(undefined)

  const roles = requiredRoles && requiredRoles.length > 0 ? { requiredRoles } : {}
  const pins = {
    ...(tenantId ? { tenantId } : {}),
    ...(subscriptionId ? { subscriptionId } : {}),
    ...roles,
  }

  function stopAttempt() {
    flowRef.current++
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current)
    pollTimerRef.current = null
    setDeviceCode(null)
    void api.invoke("azure:cancel", { blockId: id }).catch(() => {})
  }

  useEffect(
    () => () => {
      flowRef.current++
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current)
      void api.invoke("azure:cancel", { blockId: id }).catch(() => {})
    },
    [api, id],
  )

  function publish(result: Authenticated) {
    const info = infoOf(result)
    registerOutputs(id, outputsFor(result.env, info))
    setSignInInfo(info)
    setAuthStatus("authenticated")
    setErrorMessage(null)
    setNotice(null)
    setWarningMessage(result.sessionEnvWarning ?? null)
    const { status: _status, sessionEnvWarning: _warning, ...saved } = result
    const detectedFrom = detectedFromRef.current
    history.record(id, "auth", {
      status: "signed-in",
      block: "azure",
      ...saved,
      ...(detectedFrom ? { detected: detectedFrom } : {}),
    } satisfies SavedAzureAuth)
  }

  function fail(message: string, missingCli = false) {
    setAuthStatus("failed")
    setErrorMessage(message)
    if (missingCli) setCliMissing(true)
  }

  function handleResult(result: AzureSignInResultIpc) {
    if (result.status === "authenticated") return publish(result)
    if (result.status === "failed") return fail(result.error, result.cliMissing)
    setPickerPrincipal(result.principal)
    setTenants(result.tenants)
    setSubscriptions(result.subscriptions)
    const tenant =
      (result.tenants.find((t) => t.tenantId === result.principal.tenantId) ?? result.tenants[0])
        ?.tenantId ?? ""
    setSelectedTenantId(tenant)
    const inTenant = result.subscriptions.filter((s) => s.tenantId === tenant)
    setSelectedSubscriptionId((inTenant.find((s) => s.isDefault) ?? inTenant[0])?.id ?? "")
    setAuthStatus("select_context")
    setErrorMessage(null)
  }

  async function run(call: () => Promise<AzureSignInResultIpc>) {
    stopAttempt()
    const flow = flowRef.current
    setAuthStatus("authenticating")
    setErrorMessage(null)
    try {
      const result = await call()
      if (flowRef.current === flow) handleResult(result)
    } catch (err) {
      if (flowRef.current === flow) fail(errorText(err))
    }
  }

  /**
   * Sign in again, without asking, with the detected sign-in a restored one
   * came from: the same principal, in the saved tenant and subscription (or
   * the block's pins), with the required roles checked again. True when that
   * settled the block; false when something changed, and the user is asked.
   */
  const resumeDetected = useEffectEvent(async function resumeDetected(
    found: DetectedAzureCredentials,
    saved: SavedSignIn,
    cancelled: () => boolean,
  ): Promise<boolean> {
    const flow = ++flowRef.current
    setAuthStatus("authenticating")
    const pinnedSubscription = subscriptionId ?? saved.subscriptionId
    let result: AzureSignInResultIpc | undefined
    try {
      result = await api.invoke("azure:confirm-detected", {
        blockId: id,
        source: found.source,
        ...(found.prefix ? { prefix: found.prefix } : {}),
        tenantId: tenantId ?? saved.tenantId,
        ...(pinnedSubscription ? { subscriptionId: pinnedSubscription } : {}),
        ...roles,
        principalObjectId: saved.principal.objectId,
      })
    } catch {
      result = undefined
    }
    if (cancelled() || flowRef.current !== flow) return true
    // Missing roles are the answer for this principal; anything else (another
    // principal, a tenant or subscription it can't see) is for the user.
    const settled =
      result?.status === "authenticated" || (result?.status === "failed" && !!result.missingRoles)
    if (!result || !settled) {
      setAuthStatus("pending")
      return false
    }
    detectedFromRef.current = {
      source: found.source,
      ...(found.prefix ? { prefix: found.prefix } : {}),
    }
    setDetectionStatus("done")
    handleResult(result)
    return true
  })

  // A restored sign-in is published at once, then checked. Its config dir is
  // gone once Runbooks has quit, which is expected: the block starts over as
  // a new one would, saying why, and its detection signs in again without
  // asking when it finds the sign-in the user accepted before. A sign-in that
  // is still there but refused is an error.
  const detects = plan.length > 0
  useEffect(() => {
    if (!restoredAtMount) return
    registerOutputs(id, outputsFor(restoredAtMount.env, infoOf(restoredAtMount)))
    const flow = flowRef.current
    void api
      .invoke("azure:validate-session", {
        blockId: id,
        configDir: restoredAtMount.configDir,
        tenantId: restoredAtMount.tenantId,
      })
      .then((data) => {
        if (flowRef.current !== flow || data.valid || data.unreachable) return
        flowRef.current++
        registerOutputs(id, { __AUTHENTICATED: "false" })
        history.record(id, "auth", { status: "signed-out" } satisfies SavedAzureAuth)
        setSignInInfo(null)
        if (!data.ended) {
          return fail(
            `The saved Azure sign-in no longer works (${data.error ?? "it was refused"}). Sign in again.`,
          )
        }
        detectedFromRef.current = undefined
        resumeFromRef.current = restoredAtMount.detected ? restoredAtMount : undefined
        setAuthStatus("pending")
        setNotice(RESTARTED_MESSAGE)
        if (detects) {
          setDetectionStatus("pending")
          setDetectionAttempt((n) => Math.max(n, 0) + 1)
        }
      })
      .catch(() => {})
  }, [api, id, history, registerOutputs, restoredAtMount, detects])

  const planKey = JSON.stringify(plan)
  useEffect(() => {
    if (!sessionReady || detectionAttempt < 0) return
    const steps = JSON.parse(planKey) as typeof plan
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
            const found: DetectedAzureCredentials = {
              source: data.source,
              prefix: step.prefix,
              principalName: data.principalName,
              tenantId: data.tenantId,
              subscriptionId: data.subscriptionId,
              subscriptionName: data.subscriptionName,
              envVarPrefix: data.envVarPrefix,
            }
            setDetectionWarning(null)
            setNothingDetected(false)
            const resume = resumeFromRef.current
            resumeFromRef.current = undefined
            if (
              resume?.detected?.source === found.source &&
              (resume.detected.prefix ?? "") === (found.prefix ?? "")
            ) {
              if (await resumeDetected(found, resume, () => cancelled)) return
            }
            if (cancelled) return
            setDetected(found)
            setDetectionStatus("detected")
            return
          }
          if (data.error && !data.cliMissing) warnings.push(data.error)
        } catch (err) {
          if (cancelled) return
          warnings.push(errorText(err))
        }
      }
      if (cancelled) return
      resumeFromRef.current = undefined
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
    const { source, prefix } = detected
    detectedFromRef.current = { source, ...(prefix ? { prefix } : {}) }
    void run(() =>
      api.invoke("azure:confirm-detected", {
        blockId: id,
        source,
        ...(prefix ? { prefix } : {}),
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

  async function startLogin(useDeviceCode: boolean) {
    stopAttempt()
    detectedFromRef.current = undefined
    const flow = flowRef.current
    setAuthStatus("authenticating")
    setErrorMessage(null)
    const tenant = (tenantId ?? signInTenantId).trim()
    const tenantPin = tenant ? { tenantId: tenant } : {}
    try {
      const started = await api.invoke("azure:login-start", {
        blockId: id,
        deviceCode: useDeviceCode,
        ...tenantPin,
      })
      if (flowRef.current !== flow) return
      const flowId = started.flowId
      if (!flowId) return fail(started.error ?? "Couldn't start az login", started.cliMissing)
      const poll = async () => {
        try {
          const data = await api.invoke("azure:login-poll", { flowId, ...pins, ...tenantPin })
          if (flowRef.current !== flow) return
          if (data.status === "pending") {
            if (data.verificationUri && data.userCode) {
              setDeviceCode({ verificationUri: data.verificationUri, userCode: data.userCode })
            }
            pollTimerRef.current = setTimeout(() => void poll(), POLL_INTERVAL_MS)
            return
          }
          setDeviceCode(null)
          handleResult(data)
        } catch (err) {
          if (flowRef.current === flow) fail(errorText(err))
        }
      }
      pollTimerRef.current = setTimeout(() => void poll(), POLL_INTERVAL_MS / 2)
    } catch (err) {
      if (flowRef.current === flow) fail(errorText(err))
    }
  }

  function handleCancelLogin() {
    stopAttempt()
    setAuthStatus("pending")
    setErrorMessage(null)
  }

  function handleServicePrincipal() {
    detectedFromRef.current = undefined
    void run(() =>
      api.invoke("azure:service-principal", {
        blockId: id,
        clientId: clientId.trim(),
        tenantId: (tenantId ?? spTenantId).trim(),
        ...(useCertificate ? { certificatePath: certificatePath.trim() } : { clientSecret }),
        ...(subscriptionId ? { subscriptionId } : {}),
        ...roles,
      }),
    ).then(() => setClientSecret(""))
  }

  function selectTenant(next: string) {
    setSelectedTenantId(next)
    const inTenant = subscriptions.filter((s) => s.tenantId === next)
    setSelectedSubscriptionId((inTenant.find((s) => s.isDefault) ?? inTenant[0])?.id ?? "")
  }

  async function handleSelectContext() {
    if (!selectedTenantId) return
    const flow = ++flowRef.current
    setSelecting(true)
    setErrorMessage(null)
    try {
      const result = await api.invoke("azure:select-context", {
        blockId: id,
        tenantId: selectedTenantId,
        ...(selectedSubscriptionId ? { subscriptionId: selectedSubscriptionId } : {}),
        ...roles,
      })
      if (flowRef.current !== flow) return
      if (result.status === "failed") setErrorMessage(result.error)
      else handleResult(result)
    } catch (err) {
      if (flowRef.current === flow) setErrorMessage(errorText(err))
    } finally {
      if (flowRef.current === flow) setSelecting(false)
    }
  }

  function handleManualAuth() {
    stopAttempt()
    registerOutputs(id, { __AUTHENTICATED: "false" })
    history.record(id, "auth", { status: "signed-out" } satisfies SavedAzureAuth)
    setAuthStatus("pending")
    setErrorMessage(null)
    setNotice(null)
    setWarningMessage(null)
    setSignInInfo(null)
    setSelecting(false)
    detectedFromRef.current = undefined
    resumeFromRef.current = undefined
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
    notice,
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
    selecting,
    handleConfirmDetected,
    handleRejectDetected,
    handleRetryDetection,
    startBrowserLogin: () => void startLogin(false),
    startDeviceCodeLogin: () => void startLogin(true),
    handleCancelLogin,
    handleServicePrincipal,
    handleSelectContext: () => void handleSelectContext(),
    handleManualAuth,
  }
}
