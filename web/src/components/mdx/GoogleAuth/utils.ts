import { CheckCircle, XCircle, Loader2, KeyRound, FolderOpen } from "lucide-react"
import type { GoogleAuthMethod, GoogleAuthStatus, GoogleCredentialType, GoogleDetectionSource } from "./types"
import { makeStatusStyles } from "../_shared/lib/statusStyles"

// Status-based styling for the container, icon, and icon color. Maps are
// GoogleAuth-specific: the accent is `info` (blue) for the pending,
// authenticating, and select_project states — matching GitAuth rather than
// AwsAuth's AWS-orange `warning`. The shared factory only removes the repeated
// lookup boilerplate; `Record<GoogleAuthStatus, …>` keeps every map exhaustive,
// so adding a status without styling it is a compile error.
export const { getStatusClasses, getStatusIcon, getStatusIconClasses } = makeStatusStyles<GoogleAuthStatus>({
  container: {
    authenticated: 'bg-success-muted border-success/30',
    failed: 'bg-destructive-muted border-destructive/30',
    authenticating: 'bg-info-muted border-info/40',
    pending: 'bg-info-muted/50 border-info/40',
    select_project: 'bg-info-muted border-info/40',
  },
  icon: {
    authenticated: CheckCircle,
    failed: XCircle,
    authenticating: Loader2,
    pending: KeyRound,
    select_project: FolderOpen,
  },
  iconColor: {
    authenticated: 'text-success',
    failed: 'text-destructive',
    authenticating: 'text-info',
    pending: 'text-info',
    select_project: 'text-info',
  },
})

// Get a human-readable label for a Google Cloud credential detection source.
// Returns null for unknown/null sources so callers can conditionally hide the label.
export function getSourceLabel(source: GoogleDetectionSource): string | null {
  switch (source) {
    case 'env':
      return 'Environment Variables'
    case 'adc':
      return 'Application Default Credentials'
    case 'gcloud':
      return 'gcloud Configuration'
    case 'block':
      return 'Command Output'
    default:
      return null
  }
}

// Human labels for a credentials-JSON `type`. `Record<GoogleCredentialType, …>`
// keeps this exhaustive: a new credential type that isn't labelled is a compile
// error.
const CREDENTIAL_TYPE_LABELS: Record<GoogleCredentialType, string> = {
  service_account: 'Service account key',
  authorized_user: 'User credentials (ADC)',
  external_account: 'Workload identity federation',
  impersonated_service_account: 'Impersonated service account',
  access_token: 'Access token',
  gce_metadata: 'Compute Engine metadata',
}

// Get a human-readable label for a Google credential type. Returns null for a
// missing or unrecognized type so callers can hide the label or pick their own
// fallback. The type comes from MAIN, so the lookup is own-key only: a stray
// value like 'toString' must not resolve to an Object.prototype member.
export function getCredentialTypeLabel(type: GoogleCredentialType | undefined): string | null {
  return type && Object.hasOwn(CREDENTIAL_TYPE_LABELS, type) ? CREDENTIAL_TYPE_LABELS[type] : null
}

// The tab the block opens on when the author sets no `defaultTab`.
const FALLBACK_AUTH_METHOD: GoogleAuthMethod = 'service_account'

const AUTH_METHODS: readonly GoogleAuthMethod[] = ['service_account', 'oauth', 'gcloud']

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
