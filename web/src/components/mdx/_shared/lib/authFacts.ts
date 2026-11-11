import type { AuthKind } from "../../../../../../src/domain/lookups/types"

/** What a signed-in auth block knows about its sign-in, from its outputs, for lookups to read as `.auth`. */
export function authFacts(
  kind: AuthKind,
  outputs: Readonly<Record<string, string>>,
): Record<string, string> {
  if (kind === "AwsAuth") {
    return {
      region: outputs.AWS_REGION ?? "",
      ssoRegion: outputs.AWS_SSO_REGION || outputs.AWS_REGION || "",
      accountId: outputs.AWS_ACCOUNT_ID ?? "",
    }
  }
  return {
    email: outputs.CLOUDSDK_CORE_ACCOUNT ?? "",
    project: outputs.GOOGLE_CLOUD_PROJECT ?? "",
  }
}

/** What a lookup reads as `.auth` in simulation mode, from an auth block nobody signed in to. */
export function simulatedAuthFacts(kind: AuthKind): Record<string, string> {
  return kind === "AwsAuth"
    ? { region: "us-east-1", ssoRegion: "us-east-1", accountId: "111122223333" }
    : { email: "you@example.com", project: "simulated-project" }
}

/** Whether an auth block's outputs say it's signed in. */
export function signedIn(kind: AuthKind, outputs: Readonly<Record<string, string>>): boolean {
  return kind === "AwsAuth"
    ? Boolean(outputs.AWS_ACCESS_KEY_ID && outputs.AWS_SECRET_ACCESS_KEY)
    : outputs.GOOGLE_AUTH_TYPE !== undefined
}
