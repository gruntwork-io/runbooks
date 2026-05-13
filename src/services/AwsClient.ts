import { Context, Effect } from "effect"
import type { AwsAuthError, AwsConfigError, AwsSsoError } from "../errors/index.ts"

export interface AwsCredentials {
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly sessionToken?: string
  readonly region: string
}

export interface AwsIdentity {
  readonly accountId: string
  readonly accountName?: string
  readonly arn: string
}

export interface ProfileInfo {
  readonly name: string
  readonly authType: "sso" | "static" | "assume_role" | "unsupported"
  readonly ssoStartUrl?: string
  readonly ssoRegion?: string
  readonly region?: string
}

export interface SsoDeviceAuth {
  readonly verificationUri: string
  readonly userCode: string
  readonly deviceCode: string
  readonly clientId: string
  readonly clientSecret: string
}

export interface SsoPollParams {
  readonly clientId: string
  readonly clientSecret: string
  readonly deviceCode: string
}

export interface SsoTokenResult {
  readonly accessToken?: string
  readonly pending?: boolean
}

export interface SsoCompleteParams {
  readonly accessToken: string
  readonly accountId: string
  readonly roleName: string
  readonly region: string
}

export interface SsoAccount {
  readonly accountId: string
  readonly accountName: string
  readonly emailAddress?: string
}

export interface SsoRole {
  readonly roleName: string
  readonly accountId: string
}

export interface AwsClientShape {
  readonly validateCredentials: (creds: AwsCredentials, region: string) => Effect.Effect<AwsIdentity, AwsAuthError>
  readonly listProfiles: () => Effect.Effect<ProfileInfo[], AwsConfigError>
  readonly authenticateProfile: (profileName: string) => Effect.Effect<AwsCredentials, AwsAuthError>
  readonly startSsoDeviceAuth: (startUrl: string, region: string) => Effect.Effect<SsoDeviceAuth, AwsSsoError>
  readonly pollSsoToken: (params: SsoPollParams) => Effect.Effect<SsoTokenResult, AwsSsoError>
  readonly completeSsoAuth: (params: SsoCompleteParams) => Effect.Effect<AwsCredentials, AwsSsoError>
  readonly listSsoAccounts: (accessToken: string) => Effect.Effect<SsoAccount[], AwsSsoError>
  readonly listSsoRoles: (accessToken: string, accountId: string) => Effect.Effect<SsoRole[], AwsSsoError>
  readonly checkRegion: (region: string, creds: AwsCredentials) => Effect.Effect<boolean, AwsAuthError>
}

export class AwsClient extends Context.Tag("AwsClient")<AwsClient, AwsClientShape>() {}
