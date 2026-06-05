// ---------------------------------------------------------------------------
// Provider-neutral Git auth types (canonical)
// ---------------------------------------------------------------------------

export type GitProvider = 'github' | 'gitlab'

export type GitAuthMethod = 'pat' | 'oauth' | 'env' | 'cli'
export type GitAuthStatus = 'pending' | 'authenticating' | 'authenticated' | 'failed'
export type GitDetectionStatus = 'pending' | 'done'

// Token type as detected by prefix. 'pat' is the generic GitLab access-token
// classification; the remaining values are GitHub-specific.
export type GitTokenType =
  | 'classic_pat'
  | 'fine_grained_pat'
  | 'oauth'
  | 'github_app'
  | 'pat'
  | 'unknown'

// Credential detection source types
export type GitCredentialSource =
  | 'env'                                                   // Check the provider's token env vars
  | { env: { prefix?: string } }                            // Check PREFIX_<TOKEN>, etc.
  | 'cli'                                                   // Check the provider's CLI (gh / glab)
  | { block: string }                                       // From block output

// Detection source for UI badges
export type GitDetectionSource = 'env' | 'cli' | 'block' | null

export interface GitUserInfo {
  login: string
  name?: string
  avatarUrl?: string
  email?: string
}

export interface GitCredentials {
  token: string
  user: GitUserInfo
}

export interface GitAuthProps {
  id: string
  title?: string
  description?: string
  /** Initial selected provider (default: 'github'). */
  provider?: GitProvider
  /** When true, the provider picker is hidden and the provider is locked. */
  hideProviderSelect?: boolean
  /**
   * Self-hosted GitLab instance URL (e.g. `https://gitlab.example.com`). GitLab
   * only. Seeds the editable "Instance URL" field in the PAT form and is used to
   * validate the token against that instance. Defaults to gitlab.com.
   */
  instanceUrl?: string
  /** GitHub OAuth App client ID (defaults to Gruntwork's app). GitHub only. */
  oauthClientId?: string
  /** OAuth scopes to request (GitHub default: ['repo']). */
  oauthScopes?: string[]
  /** Credential detection configuration (default: ['env', 'cli']). */
  detectCredentials?: false | GitCredentialSource[]
  /** Reference to one or more Inputs by ID for template expressions in props */
  inputsId?: string | string[]
}

// OAuth device flow types
export interface OAuthDeviceCodeResponse {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

export interface OAuthPollResponse {
  status: 'pending' | 'complete' | 'expired' | 'error'
  accessToken?: string
  error?: string
}

// API response types
export interface GitValidateResponse {
  valid: boolean
  user?: GitUserInfo
  scopes?: string[]
  tokenType?: GitTokenType
  error?: string
}

export interface GitEnvCredentialsResponse {
  found: boolean
  valid?: boolean
  user?: GitUserInfo
  scopes?: string[]
  tokenType?: GitTokenType
  error?: string
}

export interface GitCliCredentialsResponse {
  user?: GitUserInfo
  scopes?: string[]
  error?: string
}

// Helper functions for CLI credentials response
export const isCliAuthFound = (r: GitCliCredentialsResponse): boolean =>
  r.user != null && !r.error

export const hasRepoScope = (r: GitCliCredentialsResponse): boolean =>
  r.scopes?.includes('repo') ?? false

// ---------------------------------------------------------------------------
// Backward-compatible GitHub* aliases
//
// The legacy <GitHubAuth> wrapper and any external importers continue to use
// these names. They are exact aliases of the neutral types above.
// ---------------------------------------------------------------------------

/** Props for the legacy <GitHubAuth> block (no provider/hideProviderSelect). */
export type GitHubAuthProps = Omit<GitAuthProps, 'provider' | 'hideProviderSelect'>
/** Props for the <GitLabAuth> block (no provider/hideProviderSelect). */
export type GitLabAuthProps = Omit<GitAuthProps, 'provider' | 'hideProviderSelect'>
export type GitHubAuthMethod = GitAuthMethod
export type GitHubAuthStatus = GitAuthStatus
export type GitHubDetectionStatus = GitDetectionStatus
export type GitHubTokenType = GitTokenType
export type GitHubCredentialSource = GitCredentialSource
export type GitHubDetectionSource = GitDetectionSource
export type GitHubUserInfo = GitUserInfo
export type GitHubCredentials = GitCredentials
export type GitHubValidateResponse = GitValidateResponse
export type GitHubEnvCredentialsResponse = GitEnvCredentialsResponse
export type GitHubCliCredentialsResponse = GitCliCredentialsResponse
