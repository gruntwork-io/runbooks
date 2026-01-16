import { CheckCircle, XCircle, Loader2, KeyRound, User } from "lucide-react"
import type { AuthStatus } from "./types"

// Get status-based styling for the container
export const getStatusClasses = (authStatus: AuthStatus): string => {
  const statusMap: Record<AuthStatus, string> = {
    authenticated: 'bg-green-50 border-green-200',
    failed: 'bg-red-50 border-red-200',
    authenticating: 'bg-amber-50 border-amber-200',
    pending: 'bg-amber-50/50 border-amber-200',
    select_account: 'bg-blue-50 border-blue-200',
    select_role: 'bg-blue-50 border-blue-200',
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
    authenticated: 'text-green-600',
    failed: 'text-red-600',
    authenticating: 'text-amber-600',
    pending: 'text-amber-600',
    select_account: 'text-blue-600',
    select_role: 'text-blue-600',
  }
  return colorMap[authStatus]
}
