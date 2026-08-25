import { CheckCircle, XCircle, Loader2, KeyRound } from "lucide-react"
import type { GitAuthMethod, GitAuthStatus } from "./types"
import type { ProviderConfig } from "./providers"
import { makeStatusStyles } from "../_shared/lib/statusStyles"

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

// Status-based styling for the container, icon, and icon color. Maps are
// GitAuth-specific (note info-tinted authenticating/pending); the shared
// factory only removes the repeated lookup boilerplate.
export const { getStatusClasses, getStatusIcon, getStatusIconClasses } = makeStatusStyles<GitAuthStatus>({
  container: {
    authenticated: 'bg-success-muted border-success/30',
    failed: 'bg-destructive-muted border-destructive/30',
    authenticating: 'bg-info-muted border-info/40',
    pending: 'bg-info-muted/50 border-info/40',
  },
  icon: {
    authenticated: CheckCircle,
    failed: XCircle,
    authenticating: Loader2,
    pending: KeyRound,
  },
  iconColor: {
    authenticated: 'text-success',
    failed: 'text-destructive',
    authenticating: 'text-info',
    pending: 'text-info',
  },
})

/**
 * Resolve the `defaultTab` prop to the tab the block opens on for a given
 * provider. Unlike AwsAuth/GoogleAuth the valid set is provider-dependent —
 * GitLab has no OAuth flow — so a tab the provider does not offer falls back
 * to that provider's default (OAuth where supported, otherwise PAT), as does
 * an unrecognized value from untyped MDX.
 */
export function resolveDefaultAuthMethod(
  provider: ProviderConfig,
  defaultTab: string | undefined,
): GitAuthMethod {
  if (defaultTab && provider.manualMethods.includes(defaultTab as GitAuthMethod)) {
    return defaultTab as GitAuthMethod
  }
  return provider.supportsOAuth ? 'oauth' : 'pat'
}
