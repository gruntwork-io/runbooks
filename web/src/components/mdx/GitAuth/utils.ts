import { CheckCircle, XCircle, Loader2, KeyRound } from "lucide-react"
import type { GitAuthStatus } from "./types"

/**
 * Normalize a user-entered GitLab instance URL (or bare host) into a clean
 * origin (`https://gitlab.example.com`), or null when empty/invalid. Mirrors the
 * backend's normalizeGitLabBaseUrl; used to build the self-hosted
 * token-creation link. A missing scheme is assumed https.
 */
export const normalizeInstanceBaseUrl = (input: string | undefined | null): string | null => {
  const raw = (input ?? "").trim()
  if (!raw) return null
  // Reject a non-http(s) scheme rather than gluing https:// in front of it
  // (which would turn `ftp://host` into the bogus `https://ftp`).
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
  if (hasScheme && !/^https?:\/\//i.test(raw)) return null
  const withScheme = hasScheme ? raw : `https://${raw}`
  try {
    const u = new URL(withScheme)
    if (u.protocol !== "http:" && u.protocol !== "https:") return null
    return `${u.protocol}//${u.host}`
  } catch {
    return null
  }
}

export const getStatusClasses = (authStatus: GitAuthStatus): string => {
  const statusMap: Record<GitAuthStatus, string> = {
    authenticated: 'bg-success-muted border-success/30',
    failed: 'bg-destructive-muted border-destructive/30',
    authenticating: 'bg-info-muted border-info/40',
    pending: 'bg-info-muted/50 border-info/40',
  }
  return statusMap[authStatus]
}

export const getStatusIcon = (authStatus: GitAuthStatus) => {
  const iconMap: Record<GitAuthStatus, typeof CheckCircle> = {
    authenticated: CheckCircle,
    failed: XCircle,
    authenticating: Loader2,
    pending: KeyRound,
  }
  return iconMap[authStatus]
}

export const getStatusIconClasses = (authStatus: GitAuthStatus): string => {
  const colorMap: Record<GitAuthStatus, string> = {
    authenticated: 'text-success',
    failed: 'text-destructive',
    authenticating: 'text-info',
    pending: 'text-info',
  }
  return colorMap[authStatus]
}
