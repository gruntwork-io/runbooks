export type AuthMethod = 'credentials' | 'sso' | 'profile'
export type AuthStatus = 'pending' | 'authenticating' | 'authenticated' | 'failed' | 'select_account' | 'select_role'

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
