/**
 * The aws:env-credentials and aws:env-credentials-confirm handlers for
 * electron/main/ipc/aws.ts.
 *
 * Split out of the IPC module so the reply contract can be exercised without
 * an Electron `ipcMain`: detection returns metadata only, confirm validates
 * and hands the keys back without writing the session, and a renderer-supplied
 * prefix is allowlist-checked before any env var name is built from it.
 */
import { runtime } from "./runtime.ts"
import {
  detectEnvCredentials,
  validateEnvCredentials,
  confirmEnvCredentials,
} from "../../../src/domain/aws/auth.ts"
import { ENV_PREFIX_PATTERN } from "../../../src/domain/env-prefix.ts"

export type EnvCredentialsParams = { prefix?: string; defaultRegion?: string }

/** Confirm also carries the account the user was shown and agreed to. */
export type EnvCredentialsConfirmParams = EnvCredentialsParams & { expectedAccountId?: string }

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
 * (the credentials may have changed since detect), then validated.
 *
 * It writes nothing to the session. It returns the keys, and the renderer
 * publishes them (block outputs and session env, like aws:profile-auth and
 * aws:sso-complete) only if the sign-in attempt is still current, so a reply
 * that lands after the block is gone changes nothing.
 *
 * When `expectedAccountId` is given and the credentials now belong to another
 * account, the reply is `{ valid: false, accountChanged: true, ...identity }`
 * with no keys, so the user is asked again about the account they would get.
 */
export async function handleEnvCredentialsConfirm(params: EnvCredentialsConfirmParams = {}) {
  const prefix = params.prefix || undefined
  const prefixError = invalidPrefixError(prefix)
  if (prefixError) return { valid: false, error: prefixError }

  try {
    const { credentials, identity } = await runtime.runPromise(
      confirmEnvCredentials(prefix, params.defaultRegion),
    )

    if (params.expectedAccountId && identity.accountId !== params.expectedAccountId) {
      return {
        valid: false,
        accountChanged: true,
        error: `The credentials now belong to account ${identity.accountId}, not ${params.expectedAccountId}`,
        accountId: identity.accountId,
        accountName: identity.accountName,
        arn: identity.arn,
        region: credentials.region,
        hasSessionToken: !!credentials.sessionToken,
      }
    }

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
