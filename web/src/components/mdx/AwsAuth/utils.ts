import { CheckCircle, XCircle, Loader2, KeyRound, User } from "lucide-react"
import type { AuthStatus, AwsDetectionSource } from "./types"
import { makeStatusStyles } from "../_shared/lib/statusStyles"

// Status-based styling for the container, icon, and icon color. Maps are
// AwsAuth-specific (note warning-tinted authenticating/pending and the
// select_account/select_role states); the shared factory only removes the
// repeated lookup boilerplate.
export const { getStatusClasses, getStatusIcon, getStatusIconClasses } = makeStatusStyles<AuthStatus>({
  container: {
    authenticated: 'bg-success-muted border-success/30',
    failed: 'bg-destructive-muted border-destructive/30',
    authenticating: 'bg-warning-muted border-warning/30',
    pending: 'bg-warning-muted/50 border-warning/30',
    select_account: 'bg-info-muted border-info/40',
    select_role: 'bg-info-muted border-info/40',
  },
  icon: {
    authenticated: CheckCircle,
    failed: XCircle,
    authenticating: Loader2,
    pending: KeyRound,
    select_account: User,
    select_role: User,
  },
  iconColor: {
    authenticated: 'text-success',
    failed: 'text-destructive',
    authenticating: 'text-warning',
    pending: 'text-warning',
    select_account: 'text-info',
    select_role: 'text-info',
  },
})

// Get a human-readable label for an AWS credential detection source.
// Returns null for unknown/null sources so callers can conditionally hide the label.
export function getSourceLabel(source: AwsDetectionSource): string | null {
  switch (source) {
    case 'env':
      return 'Environment Variables'
    case 'block':
      return 'Command Output'
    default:
      return null
  }
}
