import { CheckCircle, XCircle, Loader2, KeyRound } from "lucide-react"
import type { GitHubAuthStatus } from "./types"

// Get status-based styling for the container
// Using purple (violet) as GitHub's brand color
export const getStatusClasses = (authStatus: GitHubAuthStatus): string => {
  const statusMap: Record<GitHubAuthStatus, string> = {
    authenticated: 'bg-green-50 border-green-200',
    failed: 'bg-red-50 border-red-200',
    authenticating: 'bg-violet-50 border-violet-200',
    pending: 'bg-violet-50/50 border-violet-200',
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
    authenticated: 'text-green-600',
    failed: 'text-red-600',
    authenticating: 'text-violet-600',
    pending: 'text-violet-600',
  }
  return colorMap[authStatus]
}
