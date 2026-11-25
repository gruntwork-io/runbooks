import type { GoogleIdentity } from "../../services/GoogleClient.ts"

/**
 * Only a user login is compared. A configuration's account is a user account,
 * so it always differs from a service account or an impersonated one set up
 * alongside it, and that difference does not mean the two were mismatched.
 */
export function namesAnotherAccount(
  configurationAccount: string | undefined,
  signedIn: Pick<GoogleIdentity, "email" | "credentialType">,
): boolean {
  if (signedIn.credentialType !== "authorized_user") return false
  if (!configurationAccount || !signedIn.email) return false
  return configurationAccount.toLowerCase() !== signedIn.email.toLowerCase()
}
