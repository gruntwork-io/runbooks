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

export function registerAwsHandlers(): void {
  ipcMain.handle(
    "aws:validate",
    async (_event, params: { credentials: AwsCredentials; region: string }) => {
      return runtime.runPromise(
        validateCredentials(params.credentials, params.region),
      )
    },
  )

  ipcMain.handle("aws:profiles", async () => {
    return runtime.runPromise(listProfiles())
  })

  ipcMain.handle(
    "aws:profile-auth",
    async (_event, params: { profileName: string }) => {
      return runtime.runPromise(authenticateProfile(params.profileName))
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
      return runtime.runPromise(completeSsoAuth(params))
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
    async (_event, params: { region: string; credentials: AwsCredentials }) => {
      return runtime.runPromise(
        checkRegion(params.region, params.credentials),
      )
    },
  )
}
