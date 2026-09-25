/**
 * The aws:env-credentials and aws:env-credentials-confirm handlers for
 * electron/main/ipc/aws.ts.
 *
 * Split out of the IPC module so the reply contract can be exercised without
 * an Electron `ipcMain`: detection returns metadata only, confirm validates
 * before it writes anything to the session, and a renderer-supplied prefix is
 * allowlist-checked before any env var name is built from it.
 */
import { runtime, sessionManager } from "./runtime.ts"
import {
  detectEnvCredentials,
  validateEnvCredentials,
  confirmEnvCredentials,
} from "../../../src/domain/aws/auth.ts"
import { ENV_PREFIX_PATTERN } from "../../../src/domain/env-prefix.ts"

export type EnvCredentialsParams = { prefix?: string; defaultRegion?: string }

/**
 * The prefix is untrusted renderer input: allowlist-validate it in MAIN before
 * it is ever used to build an env var name (same check as ipc/google.ts).
 */
function invalidPrefixError(prefix: string | undefined): string | undefined {
  if (prefix !== undefined && !ENV_PREFIX_PATTERN.test(prefix)) {
    return `Invalid env prefix "${prefix}": must match ${ENV_PREFIX_PATTERN}`
  }
  return undefined
}

/**
 * aws:env-credentials — read-only detection. Validates the env credentials
 * but returns metadata only: the keys never reach the renderer until the user
 * confirms.
 */
export async function handleEnvCredentials(params: EnvCredentialsParams = {}) {
  // The plain 'env' source sends '' — that means "no prefix".
  const prefix = params.prefix || undefined
  const prefixError = invalidPrefixError(prefix)
  if (prefixError) return { found: false, error: prefixError }

  try {
    const envCreds = await runtime.runPromise(detectEnvCredentials(prefix))
    if (!envCreds) return { found: false }

    try {
      const { credentials, identity } = await runtime.runPromise(
        validateEnvCredentials(envCreds, params.defaultRegion),
      )
      return {
        found: true,
        valid: true,
        accountId: identity.accountId,
        accountName: identity.accountName,
        arn: identity.arn,
        region: credentials.region,
        hasSessionToken: !!credentials.sessionToken,
      }
    } catch (err) {
      return {
        found: true,
        valid: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  } catch (err) {
    return {
      found: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * aws:env-credentials-confirm — the same detection, re-run at confirm time
 * (the credentials may have changed since detect). Validation comes first, so
 * a failure writes nothing to the session. Returns the keys: the renderer
 * publishes them as block outputs for awsAuthId, like aws:profile-auth and
 * aws:sso-complete.
 */
export async function handleEnvCredentialsConfirm(params: EnvCredentialsParams = {}) {
  const prefix = params.prefix || undefined
  const prefixError = invalidPrefixError(prefix)
  if (prefixError) return { valid: false, error: prefixError }

  try {
    const { credentials, identity } = await runtime.runPromise(
      confirmEnvCredentials(prefix, params.defaultRegion),
    )

    // The same variables useAwsAuth's registerCredentials publishes:
    // AWS_REGION (what the block documents and the SDKs read), and an
    // explicit empty AWS_SESSION_TOKEN so static keys never run with a
    // previous auth's session token.
    await runtime.runPromise(
      sessionManager.appendToEnv({
        AWS_ACCESS_KEY_ID: credentials.accessKeyId,
        AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
        AWS_REGION: credentials.region,
        AWS_SESSION_TOKEN: credentials.sessionToken ?? "",
      }),
    )

    return {
      valid: true,
      accountId: identity.accountId,
      accountName: identity.accountName,
      arn: identity.arn,
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
      region: credentials.region,
    }
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
