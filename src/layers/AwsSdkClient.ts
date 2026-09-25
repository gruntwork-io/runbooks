/**
 * Live implementation of the AwsClient service using AWS SDK v3.
 */
import { Effect, Layer } from "effect"
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts"
import { IAMClient, ListAccountAliasesCommand } from "@aws-sdk/client-iam"
import { SSOClient, GetRoleCredentialsCommand, ListAccountsCommand, ListAccountRolesCommand } from "@aws-sdk/client-sso"
import { SSOOIDCClient, RegisterClientCommand, StartDeviceAuthorizationCommand, CreateTokenCommand } from "@aws-sdk/client-sso-oidc"
import { AccountClient, GetRegionOptStatusCommand } from "@aws-sdk/client-account"
import { parseKnownFiles } from "@smithy/shared-ini-file-loader"
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

/**
 * The CreateToken failures a user causes get a message that says what to do;
 * anything else keeps the SDK's own text.
 */
function describeSsoTokenError(err: unknown): string {
  const name = err instanceof Error ? err.name : undefined
  if (name === "AccessDeniedException") {
    return "SSO sign-in was denied or cancelled in the browser"
  }
  if (name === "ExpiredTokenException") {
    return "The SSO sign-in request expired. Please try again."
  }
  return `Failed to poll SSO token: ${err}`
}

/**
 * Every profile in the shared config and credentials files, read the way the
 * SDK's own credential providers read them: `[profile x]` in config and `[x]`
 * in credentials are one profile with both files' keys merged, dotted names
 * such as `acme.prod` are kept whole, and AWS_CONFIG_FILE /
 * AWS_SHARED_CREDENTIALS_FILE are honored. `ignoreCache` makes each call
 * re-read the files, so "Refresh profiles" picks up edits.
 */
const readProfiles = () => parseKnownFiles({ ignoreCache: true })

/** Config sections that sit next to profiles but are not profiles. */
const NON_PROFILE_SECTIONS = ["sso-session.", "services."]

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
        const profiles = await readProfiles()
        return Object.entries(profiles)
          .filter(([name]) => !NON_PROFILE_SECTIONS.some((prefix) => name.startsWith(prefix)))
          .map(([name, block]) => classifyProfile(name, block))
      },
      catch: (err) => new AwsConfigError({ message: `Failed to list AWS profiles: ${err}` }),
    }),

  authenticateProfile: (profileName: string) =>
    Effect.tryPromise({
      try: async (): Promise<AwsCredentials> => {
        // Dynamic import to avoid bundling credential-providers when not needed
        const { fromIni } = await import("@aws-sdk/credential-providers")
        // ignoreCache: the files as they are now, the same ones listProfiles read.
        const provider = fromIni({ profile: profileName, ignoreCache: true })
        const resolved = await provider()

        // The profile's region, from whichever of the two files sets it.
        const region = (await readProfiles())[profileName]?.region ?? "us-east-1"

        // No STS call here: callers validate the credentials (see AwsClientShape).
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
        // The OIDC client was registered in the SSO region, so CreateToken has
        // to go to that region's endpoint, whatever the ambient region is.
        const oidcClient = new SSOOIDCClient({ region: params.region })

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
          // Both mean "not approved yet": SlowDown is the device flow asking
          // the client to poll less often, not a failure.
          if (
            err instanceof Error &&
            (err.name === "AuthorizationPendingException" || err.name === "SlowDownException")
          ) {
            return { pending: true }
          }
          throw err
        }
      },
      catch: (err) => new AwsSsoError({ message: describeSsoTokenError(err), cause: err }),
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

  listSsoAccounts: (accessToken: string, region: string) =>
    Effect.tryPromise({
      try: async (): Promise<SsoAccount[]> => {
        const ssoClient = new SSOClient({ region })
        const accounts: SsoAccount[] = []
        // Paginated: an organization's accounts can span several pages.
        let nextToken: string | undefined
        do {
          const resp = await ssoClient.send(
            new ListAccountsCommand({ accessToken, nextToken }),
          )
          for (const a of resp.accountList ?? []) {
            accounts.push({
              accountId: a.accountId ?? "",
              accountName: a.accountName ?? "",
              emailAddress: a.emailAddress,
            })
          }
          nextToken = resp.nextToken
        } while (nextToken)
        return accounts
      },
      catch: (err) => new AwsSsoError({ message: `Failed to list SSO accounts: ${err}`, cause: err }),
    }),

  listSsoRoles: (accessToken: string, accountId: string, region: string) =>
    Effect.tryPromise({
      try: async (): Promise<SsoRole[]> => {
        const ssoClient = new SSOClient({ region })
        const roles: SsoRole[] = []
        let nextToken: string | undefined
        do {
          const resp = await ssoClient.send(
            new ListAccountRolesCommand({ accessToken, accountId, nextToken }),
          )
          for (const r of resp.roleList ?? []) {
            roles.push({
              roleName: r.roleName ?? "",
              accountId: r.accountId ?? accountId,
            })
          }
          nextToken = resp.nextToken
        } while (nextToken)
        return roles
      },
      catch: (err) => new AwsSsoError({ message: `Failed to list SSO roles: ${err}`, cause: err }),
    }),

  checkRegion: (region: string, creds: AwsCredentials) =>
    Effect.tryPromise(async (): Promise<boolean> => {
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
    }).pipe(
      // Fail OPEN: a missing account:GetRegionOptStatus permission, an SCP or a
      // network blip says nothing about the region, so it must not put a
      // "region is not enabled" warning on the success card.
      Effect.orElseSucceed(() => true),
    ),
}

function classifyProfile(name: string, block: Record<string, string | undefined>): ProfileInfo {
  const base = { name, region: block.region }

  // Legacy SSO profiles carry sso_start_url; `aws configure sso` (CLI v2.9+)
  // writes sso_session, pointing at an [sso-session ...] section instead.
  if (block.sso_start_url || block.sso_session) {
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
  if (block.role_arn && (block.source_profile || block.credential_source)) {
    return { ...base, authType: "assume_role" as const }
  }
  return { ...base, authType: "unsupported" as const }
}

export const AwsSdkClientLive = Layer.succeed(AwsClient, impl)
