/**
 * Live implementation of the AwsClient service using AWS SDK v3.
 */
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { Effect, Layer } from "effect"
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts"
import { IAMClient, ListAccountAliasesCommand } from "@aws-sdk/client-iam"
import { SSOClient, GetRoleCredentialsCommand, ListAccountsCommand, ListAccountRolesCommand } from "@aws-sdk/client-sso"
import { SSOOIDCClient, RegisterClientCommand, StartDeviceAuthorizationCommand, CreateTokenCommand } from "@aws-sdk/client-sso-oidc"
import { AccountClient, GetRegionOptStatusCommand } from "@aws-sdk/client-account"
import { parse as parseIni } from "ini"
import { AwsClient } from "../services/AwsClient.ts"
import type {
  AwsClientShape,
  AwsCredentials,
  AwsIdentity,
  ProfileInfo,
  SsoDeviceAuth,
  SsoPollParams,
  SsoTokenResult,
  SsoCompleteParams,
  SsoAccount,
  SsoRole,
} from "../services/AwsClient.ts"
import { AwsAuthError, AwsConfigError, AwsSsoError } from "../errors/index.ts"

function makeCredentialsProvider(creds: AwsCredentials) {
  return {
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken,
  }
}

const impl: AwsClientShape = {
  validateCredentials: (creds: AwsCredentials, region: string) =>
    Effect.tryPromise({
      try: async (): Promise<AwsIdentity> => {
        const stsClient = new STSClient({
          region,
          credentials: makeCredentialsProvider(creds),
        })
        const identity = await stsClient.send(new GetCallerIdentityCommand({}))
        const accountId = identity.Account ?? ""
        const arn = identity.Arn ?? ""

        // Try to get account alias
        let accountName: string | undefined
        try {
          const iamClient = new IAMClient({
            region,
            credentials: makeCredentialsProvider(creds),
          })
          const aliases = await iamClient.send(new ListAccountAliasesCommand({}))
          accountName = aliases.AccountAliases?.[0]
        } catch {
          // IAM alias lookup is best-effort
        }

        return { accountId, accountName, arn }
      },
      catch: (err) => new AwsAuthError({ message: `Failed to validate credentials: ${err}`, cause: err }),
    }),

  listProfiles: () =>
    Effect.tryPromise({
      try: async (): Promise<ProfileInfo[]> => {
        const awsDir = path.join(os.homedir(), ".aws")
        const profiles: ProfileInfo[] = []
        const seen = new Set<string>()

        // Parse config file
        try {
          const configContent = await fs.readFile(path.join(awsDir, "config"), "utf-8")
          const config = parseIni(configContent)
          for (const section of Object.keys(config)) {
            const name = section.replace(/^profile\s+/, "")
            if (seen.has(name)) continue
            seen.add(name)

            const block = config[section] as Record<string, string>
            profiles.push(classifyProfile(name, block))
          }
        } catch {
          // Config file may not exist
        }

        // Parse credentials file
        try {
          const credsContent = await fs.readFile(path.join(awsDir, "credentials"), "utf-8")
          const creds = parseIni(credsContent)
          for (const name of Object.keys(creds)) {
            if (seen.has(name)) continue
            seen.add(name)

            const block = creds[name] as Record<string, string>
            profiles.push(classifyProfile(name, block))
          }
        } catch {
          // Credentials file may not exist
        }

        return profiles
      },
      catch: (err) => new AwsConfigError({ message: `Failed to list AWS profiles: ${err}` }),
    }),

  authenticateProfile: (profileName: string) =>
    Effect.tryPromise({
      try: async (): Promise<AwsCredentials> => {
        // Dynamic import to avoid bundling credential-providers when not needed
        const { fromIni } = await import("@aws-sdk/credential-providers")
        const provider = fromIni({ profile: profileName })
        const resolved = await provider()

        // Determine region from config
        const awsDir = path.join(os.homedir(), ".aws")
        let region = "us-east-1"
        try {
          const configContent = await fs.readFile(path.join(awsDir, "config"), "utf-8")
          const config = parseIni(configContent)
          const section = config[`profile ${profileName}`] ?? config[profileName]
          if (section && typeof section === "object" && "region" in section) {
            region = (section as Record<string, string>).region
          }
        } catch {
          // Fall back to default region
        }

        // Validate
        const stsClient = new STSClient({ region, credentials: resolved })
        await stsClient.send(new GetCallerIdentityCommand({}))

        return {
          accessKeyId: resolved.accessKeyId,
          secretAccessKey: resolved.secretAccessKey,
          sessionToken: resolved.sessionToken,
          region,
        }
      },
      catch: (err) => new AwsAuthError({ message: `Failed to authenticate profile: ${err}`, cause: err }),
    }),

  startSsoDeviceAuth: (startUrl: string, region: string) =>
    Effect.tryPromise({
      try: async (): Promise<SsoDeviceAuth> => {
        const oidcClient = new SSOOIDCClient({ region })

        const registerResp = await oidcClient.send(
          new RegisterClientCommand({
            clientName: "gruntwork-runbooks",
            clientType: "public",
          }),
        )

        const deviceResp = await oidcClient.send(
          new StartDeviceAuthorizationCommand({
            clientId: registerResp.clientId!,
            clientSecret: registerResp.clientSecret!,
            startUrl,
          }),
        )

        return {
          verificationUri: deviceResp.verificationUriComplete ?? deviceResp.verificationUri!,
          userCode: deviceResp.userCode!,
          deviceCode: deviceResp.deviceCode!,
          clientId: registerResp.clientId!,
          clientSecret: registerResp.clientSecret!,
        }
      },
      catch: (err) => new AwsSsoError({ message: `Failed to start SSO device auth: ${err}`, cause: err }),
    }),

  pollSsoToken: (params: SsoPollParams) =>
    Effect.tryPromise({
      try: async (): Promise<SsoTokenResult> => {
        const oidcClient = new SSOOIDCClient({})

        try {
          const tokenResp = await oidcClient.send(
            new CreateTokenCommand({
              clientId: params.clientId,
              clientSecret: params.clientSecret,
              grantType: "urn:ietf:params:oauth:grant-type:device_code",
              deviceCode: params.deviceCode,
            }),
          )

          return { accessToken: tokenResp.accessToken }
        } catch (err: unknown) {
          if (err instanceof Error && err.name === "AuthorizationPendingException") {
            return { pending: true }
          }
          throw err
        }
      },
      catch: (err) => new AwsSsoError({ message: `Failed to poll SSO token: ${err}`, cause: err }),
    }),

  completeSsoAuth: (params: SsoCompleteParams) =>
    Effect.tryPromise({
      try: async (): Promise<AwsCredentials> => {
        const ssoClient = new SSOClient({ region: params.region })
        const resp = await ssoClient.send(
          new GetRoleCredentialsCommand({
            accessToken: params.accessToken,
            accountId: params.accountId,
            roleName: params.roleName,
          }),
        )

        const roleCreds = resp.roleCredentials!
        return {
          accessKeyId: roleCreds.accessKeyId!,
          secretAccessKey: roleCreds.secretAccessKey!,
          sessionToken: roleCreds.sessionToken,
          region: params.region,
        }
      },
      catch: (err) => new AwsSsoError({ message: `Failed to complete SSO auth: ${err}`, cause: err }),
    }),

  listSsoAccounts: (accessToken: string) =>
    Effect.tryPromise({
      try: async (): Promise<SsoAccount[]> => {
        const ssoClient = new SSOClient({})
        const resp = await ssoClient.send(
          new ListAccountsCommand({ accessToken }),
        )
        return (resp.accountList ?? []).map((a) => ({
          accountId: a.accountId ?? "",
          accountName: a.accountName ?? "",
          emailAddress: a.emailAddress,
        }))
      },
      catch: (err) => new AwsSsoError({ message: `Failed to list SSO accounts: ${err}`, cause: err }),
    }),

  listSsoRoles: (accessToken: string, accountId: string) =>
    Effect.tryPromise({
      try: async (): Promise<SsoRole[]> => {
        const ssoClient = new SSOClient({})
        const resp = await ssoClient.send(
          new ListAccountRolesCommand({ accessToken, accountId }),
        )
        return (resp.roleList ?? []).map((r) => ({
          roleName: r.roleName ?? "",
          accountId: r.accountId ?? accountId,
        }))
      },
      catch: (err) => new AwsSsoError({ message: `Failed to list SSO roles: ${err}`, cause: err }),
    }),

  checkRegion: (region: string, creds: AwsCredentials) =>
    Effect.tryPromise({
      try: async (): Promise<boolean> => {
        const client = new AccountClient({
          region: "us-east-1",
          credentials: makeCredentialsProvider(creds),
        })
        const resp = await client.send(
          new GetRegionOptStatusCommand({ RegionName: region }),
        )
        return (
          resp.RegionOptStatus === "ENABLED" ||
          resp.RegionOptStatus === "ENABLED_BY_DEFAULT"
        )
      },
      catch: () => true,
    }) as Effect.Effect<boolean, AwsAuthError>,
}

function classifyProfile(name: string, block: Record<string, string>): ProfileInfo {
  const base = { name, region: block.region }

  if (block.sso_start_url) {
    return {
      ...base,
      authType: "sso" as const,
      ssoStartUrl: block.sso_start_url,
      ssoRegion: block.sso_region,
    }
  }
  if (block.aws_access_key_id) {
    return { ...base, authType: "static" as const }
  }
  if (block.role_arn && block.source_profile) {
    return { ...base, authType: "assume_role" as const }
  }
  return { ...base, authType: "unsupported" as const }
}

export const AwsSdkClientLive = Layer.succeed(AwsClient, impl)
