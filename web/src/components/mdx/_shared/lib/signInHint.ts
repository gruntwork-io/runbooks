/**
 * The hint AwsAuth and GoogleAuth show above their sign-in form, ahead of
 * "Check again". GitAuth writes its own, which names its CLI's login command.
 *
 * - `invalidDetected`: detection found credentials that don't validate (the
 *   warning above the form says which).
 * - `nothingDetected`: detection found no credentials at all.
 *
 * Neither is set after the user turned detected credentials down or chose
 * Re-authenticate: they are on the form to use other credentials.
 */
export function signInHint({
  invalidDetected,
  nothingDetected,
}: {
  invalidDetected: boolean
  nothingDetected: boolean
}): string {
  if (invalidDetected) return "Fix the credentials, or sign in below."
  if (nothingDetected) return "No existing credentials found. Sign in below."
  return "Sign in below with different credentials."
}
