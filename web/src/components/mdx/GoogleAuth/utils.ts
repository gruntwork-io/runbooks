import { CheckCircle, XCircle, Loader2, KeyRound, FolderOpen } from "lucide-react"
import type {
  AdcPrincipalLookup,
  GcloudConfigInfo,
  GoogleAuthMethod,
  GoogleAuthStatus,
  GoogleCredentialType,
  GoogleDetectionSource,
  SignedInAdcPrincipal,
} from "./types"
import { makeStatusStyles } from "../_shared/lib/statusStyles"
import { namesAnotherAccount } from "../../../../../src/domain/google/account-mismatch"

// Status-based styling for the container, icon, and icon color. Maps are
// GoogleAuth-specific: the accent is `info` (blue) for the pending,
// authenticating, and select_project states — matching GitAuth rather than
// AwsAuth's AWS-orange `warning`. The shared factory only removes the repeated
// lookup boilerplate; `Record<GoogleAuthStatus, …>` keeps every map exhaustive,
// so adding a status without styling it is a compile error.
export const { getStatusClasses, StatusIcon, getStatusIconClasses } =
  makeStatusStyles<GoogleAuthStatus>({
    container: {
      authenticated: "bg-success-muted border-success/30",
      failed: "bg-destructive-muted border-destructive/30",
      authenticating: "bg-info-muted border-info/40",
      pending: "bg-info-muted/50 border-info/40",
      select_project: "bg-info-muted border-info/40",
    },
    icon: {
      authenticated: CheckCircle,
      failed: XCircle,
      authenticating: Loader2,
      pending: KeyRound,
      select_project: FolderOpen,
    },
    iconColor: {
      authenticated: "text-success",
      failed: "text-destructive",
      authenticating: "text-info",
      pending: "text-info",
      select_project: "text-info",
    },
  })

// Get a human-readable label for a Google Cloud credential detection source.
// Returns null when nothing was detected so callers can conditionally hide the label.
export function getSourceLabel(source: GoogleDetectionSource): string | null {
  switch (source) {
    case "env":
      return "Environment Variables"
    case "adc":
      return "Application Default Credentials"
    case "gcloud":
      return "gcloud Configuration"
    case "block":
      return "Command Output"
    case null:
      return null
  }
}

// Human labels for a credentials-JSON `type`. `Record<GoogleCredentialType, …>`
// keeps this exhaustive: a new credential type that isn't labelled is a compile
// error.
const CREDENTIAL_TYPE_LABELS: Record<GoogleCredentialType, string> = {
  service_account: "Service account key",
  authorized_user: "User credentials (ADC)",
  external_account: "Workload identity federation",
  impersonated_service_account: "Impersonated service account",
  access_token: "Access token",
  gce_metadata: "Compute Engine metadata",
}

// Get a human-readable label for a Google credential type. Returns null for a
// missing or unrecognized type so callers can hide the label or pick their own
// fallback. The type comes from MAIN, so the lookup is own-key only: a stray
// value like 'toString' must not resolve to an Object.prototype member.
export function getCredentialTypeLabel(type: GoogleCredentialType | undefined): string | null {
  return type && Object.hasOwn(CREDENTIAL_TYPE_LABELS, type) ? CREDENTIAL_TYPE_LABELS[type] : null
}

const UNREADABLE_ADC = "Google could not confirm who this login belongs to"

interface AdcDetection {
  found: boolean
  valid?: boolean
  account?: { principal?: string }
  credentialType?: GoogleCredentialType
  missingScopes?: string[]
  warning?: string
  error?: string
}

export function toAdcPrincipalLookup(detection: AdcDetection): AdcPrincipalLookup {
  const reason = detection.warning ?? detection.error
  const principal = detection.account?.principal ?? ""
  if (!detection.found) return reason ? { status: "unusable", reason } : { status: "missing" }
  if (detection.missingScopes?.length) {
    return { status: "missing-scopes", principal, missingScopes: detection.missingScopes }
  }
  if (!detection.valid) return { status: "unusable", reason: reason ?? UNREADABLE_ADC }
  return {
    status: "signed-in",
    principal,
    ...(detection.credentialType ? { credentialType: detection.credentialType } : {}),
  }
}

export function isForAnotherAccount(
  configuration: GcloudConfigInfo,
  signedIn: SignedInAdcPrincipal,
): boolean {
  if (!signedIn.credentialType) return false
  const identity = { email: signedIn.principal, credentialType: signedIn.credentialType }
  return namesAnotherAccount(configuration.account, identity)
}

function hasCredentials(configuration: GcloudConfigInfo): boolean {
  return configuration.authType !== "config-only" && configuration.authType !== "unsupported"
}

export function isUsableWith(
  configuration: GcloudConfigInfo,
  signedIn: SignedInAdcPrincipal,
): boolean {
  return hasCredentials(configuration) && !isForAnotherAccount(configuration, signedIn)
}

export function configurationsUsableWith(
  configurations: GcloudConfigInfo[],
  lookup: AdcPrincipalLookup,
): GcloudConfigInfo[] {
  if (lookup.status !== "signed-in") return []
  return configurations.filter((configuration) => isUsableWith(configuration, lookup))
}

export function chooseConfiguration(
  usable: GcloudConfigInfo[],
  previousName: string | undefined,
  pinnedName: string | undefined,
): GcloudConfigInfo | null {
  return (
    usable.find((configuration) => configuration.name === previousName) ??
    usable.find((configuration) => configuration.name === pinnedName) ??
    usable.find((configuration) => configuration.isActive) ??
    usable[0] ??
    null
  )
}

export interface GcloudSetting {
  label: "Project" | "Region" | "Zone"
  value: string
  source?: string
}

export interface GcloudSettingSources {
  configuration: GcloudConfigInfo | null
  pinnedProject: string | undefined
  quotaProject: string | undefined
  pickedRegion: string
  defaultRegion: string | undefined
  defaultZone: string | undefined
}

const SET_BY_RUNBOOK = "set by this runbook"

function fromConfiguration(configuration: GcloudConfigInfo): string {
  return `from your gcloud configuration ${configuration.name}`
}

function describeProject(sources: GcloudSettingSources): GcloudSetting {
  const { configuration, pinnedProject, quotaProject } = sources
  if (pinnedProject) return { label: "Project", value: pinnedProject, source: SET_BY_RUNBOOK }
  if (configuration?.project) {
    return {
      label: "Project",
      value: configuration.project,
      source: fromConfiguration(configuration),
    }
  }
  if (quotaProject)
    return { label: "Project", value: quotaProject, source: "from your gcloud login" }
  return { label: "Project", value: "Chosen after sign-in" }
}

function describeRegion(sources: GcloudSettingSources): GcloudSetting {
  const { configuration, pickedRegion, defaultRegion } = sources
  if (pickedRegion) {
    const source = pickedRegion === defaultRegion ? SET_BY_RUNBOOK : "your choice"
    return { label: "Region", value: pickedRegion, source }
  }
  if (configuration?.region) {
    return {
      label: "Region",
      value: configuration.region,
      source: fromConfiguration(configuration),
    }
  }
  return { label: "Region", value: "Not set" }
}

function describeZone(sources: GcloudSettingSources): GcloudSetting[] {
  const { configuration, defaultZone } = sources
  if (defaultZone) return [{ label: "Zone", value: defaultZone, source: SET_BY_RUNBOOK }]
  if (!configuration?.zone) return []
  return [{ label: "Zone", value: configuration.zone, source: fromConfiguration(configuration) }]
}

export function describeGcloudSettings(sources: GcloudSettingSources): GcloudSetting[] {
  return [describeProject(sources), describeRegion(sources), ...describeZone(sources)]
}

// The tab the block opens on when the author sets no `defaultTab`.
const FALLBACK_AUTH_METHOD: GoogleAuthMethod = "service_account"

export const AUTH_METHODS: readonly GoogleAuthMethod[] = ["service_account", "oauth", "gcloud"]

/**
 * Resolve the `defaultTab` prop to the tab the block opens on. Runbook authors
 * write raw MDX with no type checking, so the value is validated here: an
 * unrecognized tab name falls back to the Service Account Key tab rather than
 * leaving the block with no form showing at all.
 */
export function resolveDefaultAuthMethod(defaultTab: string | undefined): GoogleAuthMethod {
  return AUTH_METHODS.includes(defaultTab as GoogleAuthMethod)
    ? (defaultTab as GoogleAuthMethod)
    : FALLBACK_AUTH_METHOD
}
