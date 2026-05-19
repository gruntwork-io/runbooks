import { CheckCircle, XCircle, Loader2, KeyRound } from "lucide-react"
import type { GitHubAuthStatus } from "./types"

// Get status-based styling for the container
export const getStatusClasses = (authStatus: GitHubAuthStatus): string => {
  const statusMap: Record<GitHubAuthStatus, string> = {
    authenticated: 'bg-success-muted border-success/30',
    failed: 'bg-destructive-muted border-destructive/30',
    authenticating: 'bg-info-muted border-info/40',
    pending: 'bg-info-muted/50 border-info/40',
  }
  return statusMap[authStatus]
}

// Get the appropriate icon component for the current status
export const getStatusIcon = (authStatus: GitHubAuthStatus) => {
  const iconMap: Record<GitHubAuthStatus, typeof CheckCircle> = {
    authenticated: CheckCircle,
    failed: XCircle,
    authenticating: Loader2,
    pending: KeyRound,
  }
  return iconMap[authStatus]
}

// Get icon color classes for the current status
export const getStatusIconClasses = (authStatus: GitHubAuthStatus): string => {
  const colorMap: Record<GitHubAuthStatus, string> = {
    authenticated: 'text-success',
    failed: 'text-destructive',
    authenticating: 'text-info',
    pending: 'text-info',
  }
  return colorMap[authStatus]
}
