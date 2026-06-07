// ---------------------------------------------------------------------------
// Provider-neutral Git auth types (canonical)
// ---------------------------------------------------------------------------

export type GitProvider = 'github' | 'gitlab'

export type GitAuthMethod = 'pat' | 'oauth'
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
  /**
   * GitLab only: pin the GitLab instance to authenticate against (e.g.
   * "gitlab.gruntwork.io"). When set, the host picker is hidden and detection
   * targets this host. When omitted, the block enumerates the hosts the user is
   * logged into via glab and shows a picker if there is more than one.
   */
  host?: string
  /** Reference to one or more Inputs by ID for template expressions in props */
  inputsId?: string | string[]
}

// API response types
export interface GitCliCredentialsResponse {
  found?: boolean
  valid?: boolean
  token?: string
  user?: GitUserInfo
  scopes?: string[]
  tokenType?: GitTokenType
  error?: string
  /** HTTP status when validation failed (e.g. 401/403) — used to flag found-but-invalid. */
  status?: number
  /** The GitLab host this credential was detected/validated against. */
  host?: string
}

// Helper functions for CLI credentials response
export const isCliAuthFound = (r: GitCliCredentialsResponse): boolean =>
  r.user != null && !r.error

// ---------------------------------------------------------------------------
// Locked-provider wrapper props
//
// The <GitHubAuth>/<GitLabAuth> wrappers reuse GitAuthProps without the
// provider controls.
// ---------------------------------------------------------------------------

/** Props for the legacy <GitHubAuth> block (no provider/hideProviderSelect). */
export type GitHubAuthProps = Omit<GitAuthProps, 'provider' | 'hideProviderSelect'>
/** Props for the <GitLabAuth> block (no provider/hideProviderSelect). */
export type GitLabAuthProps = Omit<GitAuthProps, 'provider' | 'hideProviderSelect'>
