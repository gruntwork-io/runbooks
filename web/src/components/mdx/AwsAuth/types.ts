export type AuthMethod = 'credentials' | 'sso' | 'profile'
export type AuthStatus = 'pending' | 'authenticating' | 'authenticated' | 'failed' | 'select_account' | 'select_role'

// =============================================================================
// Credential Detection Types (new pattern matching GitHubAuth)
// =============================================================================

/** Status of credential detection process */
export type AwsDetectionStatus = 'pending' | 'detected' | 'done'

/** Source where credentials were detected from */
export type AwsDetectionSource = 'env' | 'block' | 'default-profile' | null

/**
 * Credential source configuration for auto-detection.
 * Sources are tried in order until one succeeds.
 */
export type AwsCredentialSource =
  | 'env'                              // Check AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, etc.
  | { env: { prefix: string } }        // Check PREFIX_AWS_ACCESS_KEY_ID, etc.
  | { block: string }                  // From Command block output
  | 'default-profile'                  // Check ~/.aws/credentials default profile

/**
 * Detected credentials awaiting user confirmation.
 * Contains metadata about the detected credentials but NOT the actual secrets.
 */
export interface DetectedAwsCredentials {
  accountId: string
  /** Account alias, if available (best-effort) */
  accountName?: string
  arn: string
  region: string
  source: AwsDetectionSource
  /** Whether the credentials include a session token (temporary credentials) */
  hasSessionToken: boolean
}

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
  /**
   * Credential detection configuration.
   * - `false`: Disable auto-detection, show manual auth only
   * - Array of sources: Try each source in order until one succeeds
   * - Default: `['env']` - auto-detect from environment variables
   * 
   * Unlike GitHubAuth, detected credentials require user confirmation before use
   * to prevent accidental operations against the wrong AWS account.
   */
  detectCredentials?: false | AwsCredentialSource[]
}

export interface AccountInfo {
  accountId?: string
  /** Account alias, if available (best-effort) */
  accountName?: string
  arn?: string
}

export interface AwsCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  region: string
}
