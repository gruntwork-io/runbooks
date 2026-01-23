export type AuthMethod = 'credentials' | 'sso' | 'profile'
export type AuthStatus = 'pending' | 'authenticating' | 'authenticated' | 'failed' | 'select_account' | 'select_role'
export type PrefillStatus = 'pending' | 'success' | 'failed' | 'not-configured'
export type PrefilledCredentialsType = 'env' | 'block' | 'static'

// Credential pre-filling types
export interface EnvPrefilledCredentials {
  type: 'env'
  /** Optional prefix for env var names (e.g., "PROD_" → PROD_AWS_ACCESS_KEY_ID) */
  prefix?: string
}

export interface BlockPrefilledCredentials {
  type: 'block'
  /** ID of a Command block that outputs credentials */
  blockId: string
}

export interface StaticPrefilledCredentials {
  type: 'static'
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  region?: string
}

export type PrefilledCredentials = 
  | EnvPrefilledCredentials 
  | BlockPrefilledCredentials 
  | StaticPrefilledCredentials

// SSO account and role types
export interface SSOAccount {
  accountId: string
  accountName: string
  emailAddress: string
}

export interface SSORole {
  roleName: string
}

// Profile info from backend with auth type
export interface ProfileInfo {
  name: string
  authType: 'sso' | 'static' | 'assume_role' | 'unsupported'
}

export interface AwsAuthProps {
  id: string
  title?: string
  description?: string
  /** AWS SSO start URL for SSO authentication */
  ssoStartUrl?: string
  /** AWS SSO region - the region where your IAM Identity Center is configured */
  ssoRegion?: string
  /** AWS SSO account ID to select after authentication */
  ssoAccountId?: string
  /** AWS SSO role name to assume */
  ssoRoleName?: string
  /** Default AWS region for CLI commands that don't specify a region */
  defaultRegion?: string
  /** Pre-fill credentials from environment, block output, or static values */
  prefilledCredentials?: PrefilledCredentials
  /** Allow user to override prefilled credentials (default: true) */
  allowOverridePrefilled?: boolean
}

export interface AccountInfo {
  accountId?: string
  arn?: string
}

export interface AwsCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  region: string
}
