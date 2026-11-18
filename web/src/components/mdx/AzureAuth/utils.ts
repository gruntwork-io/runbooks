import { CheckCircle, XCircle, Loader2, KeyRound, Building2 } from "lucide-react"
import type {
  AzureAuthMethod,
  AzureAuthStatus,
  AzureCredentialSource,
  AzurePrincipal,
} from "./types"
import { makeStatusStyles } from "../_shared/lib/statusStyles"

export const { getStatusClasses, StatusIcon, getStatusIconClasses } =
  makeStatusStyles<AzureAuthStatus>({
    container: {
      authenticated: "bg-success-muted border-success/30",
      failed: "bg-destructive-muted border-destructive/30",
      authenticating: "bg-warning-muted border-warning/30",
      pending: "bg-warning-muted/50 border-warning/30",
      select_context: "bg-info-muted border-info/40",
    },
    icon: {
      authenticated: CheckCircle,
      failed: XCircle,
      authenticating: Loader2,
      pending: KeyRound,
      select_context: Building2,
    },
    iconColor: {
      authenticated: "text-success",
      failed: "text-destructive",
      authenticating: "text-warning",
      pending: "text-warning",
      select_context: "text-info",
    },
  })

const AUTH_METHODS: readonly AzureAuthMethod[] = ["cli", "device_code", "service_principal"]

export function resolveDefaultAuthMethod(defaultTab: string | undefined): AzureAuthMethod {
  return AUTH_METHODS.includes(defaultTab as AzureAuthMethod)
    ? (defaultTab as AzureAuthMethod)
    : "cli"
}

type DetectionStep = { source: "env" | "cli"; prefix?: string }

export function detectionPlan(sources: false | AzureCredentialSource[] | undefined): {
  steps: DetectionStep[]
  invalid: boolean
} {
  if (sources === false) return { steps: [], invalid: false }
  if (sources !== undefined && !Array.isArray(sources)) return { steps: [], invalid: true }
  const steps: DetectionStep[] = []
  let invalid = false
  for (const source of sources ?? ["env", "cli"]) {
    if (source === "env" || source === "cli") steps.push({ source })
    else if (typeof source === "object" && source !== null && "env" in source) {
      steps.push({ source: "env", prefix: source.env?.prefix ?? "" })
    } else invalid = true
  }
  return { steps, invalid }
}

export function principalTypeLabel(type: AzurePrincipal["type"]): string {
  switch (type) {
    case "user":
      return "User"
    case "guest":
      return "Guest user"
    case "servicePrincipal":
      return "Service principal"
  }
}

export function authTypeLabel(authType: string): string {
  switch (authType) {
    case "cli":
      return "Azure CLI"
    case "device_code":
      return "Device code"
    case "service_principal":
      return "Service principal"
    default:
      return authType
  }
}
