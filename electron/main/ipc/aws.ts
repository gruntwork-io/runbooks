/**
 * IPC handlers for AWS authentication.
 *
 * Bridges Electron ipcMain to the AWS auth domain module, providing credential
 * validation, profile-based auth, SSO device flow, and region checking.
 */
import { ipcMain } from "electron"
import { runtime, sessionManager } from "./runtime.ts"
import {
  validateCredentials,
  detectEnvCredentials,
  confirmEnvCredentials,
  listProfiles,
  authenticateProfile,
  startSsoFlow,
  pollSsoToken,
  completeSsoAuth,
  listSsoRoles,
  checkRegion,
} from "../../../src/domain/aws/auth.ts"
import type { AwsCredentials, SsoPollParams, SsoCompleteParams } from "../../../src/services/AwsClient.ts"

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

  ipcMain.handle("aws:profiles", async () => {
    return runtime.runPromise(listProfiles())
  })

  ipcMain.handle(
    "aws:profile-auth",
    async (_event, params: { profileName?: string; profile?: string }) => {
      const profileName = params.profileName ?? params.profile ?? ""
      try {
        const credentials = await runtime.runPromise(authenticateProfile(profileName))
        const identity = await runtime.runPromise(
          validateCredentials(credentials, credentials.region),
        )
        return {
          valid: true,
          ...identity,
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
    },
  )

  ipcMain.handle(
    "aws:sso-start",
    async (_event, params: { startUrl: string; region: string }) => {
      return runtime.runPromise(startSsoFlow(params.startUrl, params.region))
    },
  )

  ipcMain.handle(
    "aws:sso-poll",
    async (_event, params: SsoPollParams) => {
      return runtime.runPromise(pollSsoToken(params))
    },
  )

  ipcMain.handle(
    "aws:sso-roles",
    async (_event, params: { accessToken: string; accountId: string }) => {
      return runtime.runPromise(
        listSsoRoles(params.accessToken, params.accountId),
      )
    },
  )

  ipcMain.handle(
    "aws:sso-complete",
    async (_event, params: SsoCompleteParams) => {
      try {
        const credentials = await runtime.runPromise(completeSsoAuth(params))
        const identity = await runtime.runPromise(
          validateCredentials(credentials, credentials.region),
        )
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

  ipcMain.handle("aws:env-credentials", async () => {
    return runtime.runPromise(detectEnvCredentials())
  })

  ipcMain.handle("aws:env-credentials-confirm", async () => {
    const credentials = await runtime.runPromise(confirmEnvCredentials())

    // Inject the validated credentials into the session environment
    const envVars: Record<string, string> = {
      AWS_ACCESS_KEY_ID: credentials.accessKeyId,
      AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
      AWS_DEFAULT_REGION: credentials.region,
    }
    if (credentials.sessionToken) {
      envVars.AWS_SESSION_TOKEN = credentials.sessionToken
    }

    await runtime.runPromise(sessionManager.appendToEnv(envVars))

    return credentials
  })

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
