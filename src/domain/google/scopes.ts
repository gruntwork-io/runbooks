/**
 * Required-scopes checks for GoogleAuth.
 *
 * Authors set `scopes` for two jobs: (1) what Google Sign-In requests, and
 * (2) what any auto-detected / gcloud ADC this block will accept. Service-
 * account keys are exempt — their JWT path hardcodes cloud-platform, and
 * Admin SDK-style scopes need a user credential anyway.
 */
import type { GoogleCredentialType } from "../../services/GoogleClient.ts"

/** Expand a tokeninfo-style grant into individual scope strings. */
export function expandGoogleScopes(
  scopes: readonly string[] | undefined,
): readonly string[] {
  if (!scopes || scopes.length === 0) return []
  const out: string[] = []
  for (const entry of scopes) {
    for (const part of entry.split(/\s+/)) {
      const trimmed = part.trim()
      if (trimmed) out.push(trimmed)
    }
  }
  return out
}

/**
 * Required scopes that are not present in the grant. Empty when the author
 * did not declare any requirements, or when every required scope is granted.
 */
export function missingGoogleScopes(
  required: readonly string[] | undefined,
  granted: readonly string[] | undefined,
): string[] {
  if (!required || required.length === 0) return []
  const grantedSet = new Set(expandGoogleScopes(granted))
  const missing: string[] = []
  for (const scope of required) {
    const trimmed = scope.trim()
    if (trimmed && !grantedSet.has(trimmed)) missing.push(trimmed)
  }
  return missing
}

/**
 * Service-account-shaped credentials skip the check: their access tokens only
 * ever request cloud-platform, and authors who need Admin SDK scopes must use
 * a user credential (Sign-In or scoped ADC).
 */
export function credentialSubjectToScopeCheck(
  accountType: "service_account" | "user" | undefined,
  credentialType: GoogleCredentialType | undefined,
): boolean {
  if (accountType === "service_account") return false
  if (
    credentialType === "service_account" ||
    credentialType === "impersonated_service_account"
  ) {
    return false
  }
  return true
}

export type GoogleScopeEvaluation =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly missing: readonly string[]
      readonly granted: readonly string[]
    }

/**
 * Decide whether a validated identity satisfies the author's `scopes` prop.
 * Only runs when the author explicitly set scopes — defaults are Requested by
 * Sign-In, not Required of ambient ADC (avoids breaking existing runbooks).
 */
export function evaluateRequiredGoogleScopes(params: {
  readonly required?: readonly string[]
  readonly granted?: readonly string[]
  readonly accountType?: "service_account" | "user"
  readonly credentialType?: GoogleCredentialType
}): GoogleScopeEvaluation {
  if (!params.required?.length) return { ok: true }
  if (!credentialSubjectToScopeCheck(params.accountType, params.credentialType)) {
    return { ok: true }
  }
  const missing = missingGoogleScopes(params.required, params.granted)
  if (missing.length === 0) return { ok: true }
  return {
    ok: false,
    missing,
    granted: expandGoogleScopes(params.granted),
  }
}

/** Hand-run equivalent of Google Sign-In with the author's scopes. */
export function formatGcloudAdcLoginCommand(scopes: readonly string[]): string {
  const clientFile = '--client-id-file="$GOOGLE_OAUTH_CLIENT_CREDENTIALS"'
  if (scopes.length === 0) {
    return `gcloud auth application-default login ${clientFile}`
  }
  return `gcloud auth application-default login ${clientFile} --scopes=${scopes.join(",")}`
}

/** User-facing copy when an ambient / gcloud credential fails the check. */
export function insufficientScopesErrorMessage(
  missing: readonly string[],
  required: readonly string[],
): string {
  const listed = missing.join(", ")
  return (
    `These credentials are missing required OAuth scopes: ${listed}. ` +
    `Sign in again with the required scopes, or run: ` +
    formatGcloudAdcLoginCommand(required)
  )
}
