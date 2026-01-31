export type GitHubAuthMethod = 'pat' | 'oauth' | 'env'
export type GitHubAuthStatus = 'pending' | 'authenticating' | 'authenticated' | 'failed'
export type GitHubPrefillStatus = 'pending' | 'success' | 'failed' | 'not-configured'

// Credential pre-filling types
export interface EnvPrefilledGitHubCredentials {
  type: 'env'
  /** Optional prefix for env var names (e.g., "PROD_" → PROD_GITHUB_TOKEN) */
  prefix?: string
  /** Override: use specific env var name instead of GITHUB_TOKEN/GH_TOKEN */
  envVar?: string
}

export interface OutputsPrefilledGitHubCredentials {
  type: 'outputs'
  /** ID of a Command block that outputs GITHUB_TOKEN */
  blockId: string
}

export interface StaticPrefilledGitHubCredentials {
  type: 'static'
  token: string
}

export type PrefilledGitHubCredentials =
  | EnvPrefilledGitHubCredentials
  | OutputsPrefilledGitHubCredentials
  | StaticPrefilledGitHubCredentials

export interface GitHubAuthProps {
  id: string
  title?: string
  description?: string
  /** GitHub OAuth App client ID (defaults to Gruntwork's app) */
  oauthClientId?: string
  /** OAuth scopes to request (default: ['repo']) */
  oauthScopes?: string[]
  /** Pre-fill credentials from environment, block output, or static values */
  prefilledCredentials?: PrefilledGitHubCredentials
  /** Allow user to override prefilled credentials (default: true) */
  allowOverridePrefilled?: boolean
}

export interface GitHubUserInfo {
  login: string
  name?: string
  avatarUrl?: string
  email?: string
}

export interface GitHubCredentials {
  token: string
  user: GitHubUserInfo
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
export interface GitHubValidateResponse {
  valid: boolean
  user?: GitHubUserInfo
  error?: string
}

export interface GitHubEnvCredentialsResponse {
  found: boolean
  valid?: boolean
  user?: GitHubUserInfo
  error?: string
}
