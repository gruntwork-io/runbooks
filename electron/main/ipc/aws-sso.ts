/**
 * The aws:sso-poll and aws:sso-roles handlers for electron/main/ipc/aws.ts.
 *
 * Split out of the IPC module so the reply contract can be exercised without
 * an Electron `ipcMain`. Both replies are the shapes useAwsAuth reads (and
 * electron/shared/channels.ts declares), and neither rejects: a failure comes
 * back as `{status:'failed', error}` / `{roles:[], error}`.
 */
import { runtime } from "./runtime.ts"
import { pollSsoFlow, listSsoRoles } from "../../../src/domain/aws/auth.ts"

export type SsoPollRequest = {
  clientId: string
  clientSecret: string
  deviceCode: string
  region?: string
  accountId?: string
  roleName?: string
}

export type SsoRolesRequest = { accessToken: string; accountId: string; region?: string }

/** Every SSO call must go to the region the device flow was started in. */
const MISSING_REGION = "SSO region is required"

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * aws:sso-poll — one poll of the device flow. `pending` until the user
 * approves; then `select_account` with the accounts to choose from, or
 * `success` with the role's credentials when the block pinned an account and
 * role (or there was only one of each to pick).
 */
export async function handleSsoPoll(params: SsoPollRequest) {
  if (!params.region) return { status: "failed" as const, error: MISSING_REGION }

  try {
    const outcome = await runtime.runPromise(pollSsoFlow({ ...params, region: params.region }))
    switch (outcome.status) {
      case "pending":
        return { status: "pending" as const }
      case "select_account":
        return {
          status: "select_account" as const,
          accessToken: outcome.accessToken,
          accounts: outcome.accounts,
        }
      case "success":
        return {
          status: "success" as const,
          accountId: outcome.identity.accountId,
          accountName: outcome.identity.accountName,
          arn: outcome.identity.arn,
          accessKeyId: outcome.credentials.accessKeyId,
          secretAccessKey: outcome.credentials.secretAccessKey,
          sessionToken: outcome.credentials.sessionToken,
        }
    }
  } catch (err) {
    return { status: "failed" as const, error: errorMessage(err) }
  }
}

/** aws:sso-roles — the roles the user can assume in one SSO account. */
export async function handleSsoRoles(params: SsoRolesRequest) {
  if (!params.region) return { roles: [], error: MISSING_REGION }

  try {
    const roles = await runtime.runPromise(
      listSsoRoles(params.accessToken, params.accountId, params.region),
    )
    return { roles }
  } catch (err) {
    return { roles: [], error: errorMessage(err) }
  }
}
