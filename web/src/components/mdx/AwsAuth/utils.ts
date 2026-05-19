import { CheckCircle, XCircle, Loader2, KeyRound, User } from "lucide-react"
import type { AuthStatus, AwsDetectionSource } from "./types"

// Get status-based styling for the container
export const getStatusClasses = (authStatus: AuthStatus): string => {
  const statusMap: Record<AuthStatus, string> = {
    authenticated: 'bg-success-muted border-success/30',
    failed: 'bg-destructive-muted border-destructive/30',
    authenticating: 'bg-warning-muted border-warning/30',
    pending: 'bg-warning-muted/50 border-warning/30',
    select_account: 'bg-info-muted border-info/40',
    select_role: 'bg-info-muted border-info/40',
  }
  return statusMap[authStatus]
}

// Get the appropriate icon component for the current status
export const getStatusIcon = (authStatus: AuthStatus) => {
  const iconMap: Record<AuthStatus, typeof CheckCircle> = {
    authenticated: CheckCircle,
    failed: XCircle,
    authenticating: Loader2,
    pending: KeyRound,
    select_account: User,
    select_role: User,
  }
  return iconMap[authStatus]
}

// Get icon color classes for the current status
export const getStatusIconClasses = (authStatus: AuthStatus): string => {
  const colorMap: Record<AuthStatus, string> = {
    authenticated: 'text-success',
    failed: 'text-destructive',
    authenticating: 'text-warning',
    pending: 'text-warning',
    select_account: 'text-info',
    select_role: 'text-info',
  }
  return colorMap[authStatus]
}

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
