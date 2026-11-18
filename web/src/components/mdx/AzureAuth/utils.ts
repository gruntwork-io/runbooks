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

/** The tab to open on: `defaultTab` when it names one, else Azure CLI. */
export function resolveDefaultAuthMethod(defaultTab: string | undefined): AzureAuthMethod {
  return AUTH_METHODS.includes(defaultTab as AzureAuthMethod)
    ? (defaultTab as AzureAuthMethod)
    : "cli"
}

/** The detection sources as `azure:detect` takes them: a prefix, then sources. */
export function detectionPlan(
  sources: false | AzureCredentialSource[] | undefined,
): Array<{ source: "env" | "cli"; prefix?: string }> {
  if (sources === false) return []
  const list = Array.isArray(sources) ? sources : ["env", "cli"]
  return list.flatMap((source): Array<{ source: "env" | "cli"; prefix?: string }> => {
    if (source === "env" || source === "cli") return [{ source }]
    if (typeof source === "object" && source && "env" in source) {
      return [{ source: "env", prefix: source.env?.prefix ?? "" }]
    }
    return []
  })
}

/** "User", "Guest" or "Service principal". */
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

/** How the block signed in, for the success card. */
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
