export type GitHubAuthMethod = 'pat' | 'oauth' | 'env' | 'cli'
export type GitHubAuthStatus = 'pending' | 'authenticating' | 'authenticated' | 'failed'
export type GitHubDetectionStatus = 'pending' | 'done'

// Token type as detected by prefix
export type GitHubTokenType = 
  | 'classic_pat'
  | 'fine_grained_pat'
  | 'oauth'
  | 'github_app'
  | 'unknown'

// Credential detection source types
export type GitHubCredentialSource =
  | 'env'                                                   // Check GITHUB_TOKEN, GH_TOKEN
  | { env: { prefix?: string; testPrefix?: string } }       // Check PREFIX_GITHUB_TOKEN, etc. testPrefix is for tests only
  | 'cli'                                                   // Check gh auth token
  | { block: string }                                       // From block output (expects GITHUB_TOKEN)

// Detection source for UI badges
export type GitHubDetectionSource = 'env' | 'cli' | 'block' | null

export interface GitHubAuthProps {
  id: string
  title?: string
  description?: string
  /** GitHub OAuth App client ID (defaults to Gruntwork's app) */
  oauthClientId?: string
  /** OAuth scopes to request (default: ['repo']) */
  oauthScopes?: string[]
  /** Credential detection configuration (default: ['env', 'cli']) */
  detectCredentials?: false | GitHubCredentialSource[]
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
  scopes?: string[]
  tokenType?: GitHubTokenType
  error?: string
}

export interface GitHubEnvCredentialsResponse {
  found: boolean
  valid?: boolean
  user?: GitHubUserInfo
  scopes?: string[]
  tokenType?: GitHubTokenType
  error?: string
}

export interface GitHubCliCredentialsResponse {
  user?: GitHubUserInfo
  scopes?: string[]
  error?: string
}

// Helper functions for CLI credentials response
export const isCliAuthFound = (r: GitHubCliCredentialsResponse): boolean =>
  r.user != null && !r.error

export const hasRepoScope = (r: GitHubCliCredentialsResponse): boolean =>
  r.scopes?.includes('repo') ?? false
