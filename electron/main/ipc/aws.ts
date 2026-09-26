/**
 * IPC handlers for AWS authentication.
 *
 * Bridges Electron ipcMain to the AWS auth domain module, providing credential
 * validation, env credential detection (aws-env.ts), profile-based auth
 * (aws-profiles.ts), SSO device flow, and region checking.
 */
import { ipcMain } from "electron"
import { runtime } from "./runtime.ts"
import {
  validateCredentials,
  startSsoFlow,
  signInWithSsoRole,
  checkRegion,
} from "../../../src/domain/aws/auth.ts"
import type { AwsCredentials, SsoCompleteParams } from "../../../src/services/AwsClient.ts"
import { handleEnvCredentials, handleEnvCredentialsConfirm } from "./aws-env.ts"
import type { EnvCredentialsParams } from "./aws-env.ts"
import { handleProfiles, handleProfileAuth } from "./aws-profiles.ts"
import type { ProfileAuthRequest } from "./aws-profiles.ts"
import { handleSsoPoll, handleSsoRoles } from "./aws-sso.ts"
import type { SsoPollRequest, SsoRolesRequest } from "./aws-sso.ts"

type ValidatePayload = Partial<AwsCredentials> & { credentials?: AwsCredentials; region?: string }

function unwrapCredentials(params: ValidatePayload): AwsCredentials {
  if (params.credentials) {
    return params.credentials
  }
  return {
    accessKeyId: params.accessKeyId ?? "",
    secretAccessKey: params.secretAccessKey ?? "",
    sessionToken: params.sessionToken,
    region: params.region ?? "",
  }
}

export function registerAwsHandlers(): void {
  ipcMain.handle(
    "aws:validate",
    async (_event, params: ValidatePayload) => {
      const credentials = unwrapCredentials(params)
      const region = params.region ?? credentials.region
      try {
        const identity = await runtime.runPromise(
          validateCredentials(credentials, region),
        )
        return { valid: true, ...identity }
      } catch (err) {
        return {
          valid: false,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    },
  )

  ipcMain.handle("aws:profiles", async () => handleProfiles())

  ipcMain.handle(
    "aws:profile-auth",
    async (_event, params: ProfileAuthRequest) => handleProfileAuth(params),
  )

  ipcMain.handle(
    "aws:sso-start",
    async (_event, params: { startUrl: string; region: string }) => {
      return runtime.runPromise(startSsoFlow(params.startUrl, params.region))
    },
  )

  ipcMain.handle(
    "aws:sso-poll",
    async (_event, params: SsoPollRequest) => handleSsoPoll(params),
  )

  ipcMain.handle(
    "aws:sso-roles",
    async (_event, params: SsoRolesRequest) => handleSsoRoles(params),
  )

  ipcMain.handle(
    "aws:sso-complete",
    async (_event, params: SsoCompleteParams) => {
      try {
        const { credentials, identity } = await runtime.runPromise(signInWithSsoRole(params))
        return {
          ...identity,
          accessKeyId: credentials.accessKeyId,
          secretAccessKey: credentials.secretAccessKey,
          sessionToken: credentials.sessionToken,
          region: credentials.region,
        }
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err),
        }
      }
    },
  )

  ipcMain.handle(
    "aws:env-credentials",
    async (_event, params: EnvCredentialsParams = {}) => handleEnvCredentials(params),
  )

  ipcMain.handle(
    "aws:env-credentials-confirm",
    async (_event, params: EnvCredentialsParams = {}) => handleEnvCredentialsConfirm(params),
  )

  ipcMain.handle(
    "aws:check-region",
    async (_event, params: ValidatePayload) => {
      const credentials = unwrapCredentials(params)
      const region = params.region ?? credentials.region
      try {
        const enabled = await runtime.runPromise(
          checkRegion(region, credentials),
        )
        return enabled
          ? { enabled: true }
          : { enabled: false, warning: `Region ${region} is not enabled for this AWS account` }
      } catch (err) {
        return {
          enabled: false,
          warning: err instanceof Error ? err.message : String(err),
        }
      }
    },
  )
}
