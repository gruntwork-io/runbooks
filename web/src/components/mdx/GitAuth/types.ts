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

// ---------------------------------------------------------------------------
// Tri-state validation outcomes (vcs-auth-v2-design.md §2.0)
// ---------------------------------------------------------------------------

/** Tri-state outcome reported by the detection/validation channels. */
export type GitAuthOutcome = 'valid' | 'invalid' | 'unreachable' | 'absent'

/** Transport-failure classification — selects the TLS/server-cert/network card. */
export type GitErrorKind = 'tls' | 'server-cert' | 'network'

/**
 * Everything the error card needs when a host is unreachable. An unreachable
 * outcome stops the credential chain WITHOUT consuming sources — it must never
 * render as "Invalid credentials detected".
 */
export interface GitUnreachableInfo {
  errorKind: GitErrorKind
  /** The host that could not be reached (github.com, gitlab.com, or a self-hosted instance). */
  host: string
  /**
   * For errorKind 'tls': false when the cold out-of-process trust-refresh
   * child failed, degrading the card copy to "…then restart Runbooks".
   */
  coldReadOk?: boolean
}

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
  /** Tri-state outcome (§2.0). */
  outcome?: GitAuthOutcome
  /** Set when outcome is 'unreachable'. */
  errorKind?: GitErrorKind
  /** For errorKind 'tls': whether the cold trust-refresh child succeeded. */
  coldReadOk?: boolean
  /** The env var the token came from (drives exact chip copy). */
  envVar?: string
  /** Exact warning-chip copy from main, rendered verbatim (§7 contracts). */
  warning?: string
  /** Manual-UI hint line (e.g. keyring-blocked copy) — informational, never a chip. */
  hint?: string
  /** §2.1 both-set-and-differ visibility hint. */
  divergenceHint?: string
  /** Which source produced the credential (cli-channel results may be 'config'). */
  source?: 'env' | 'cli' | 'config'
  /** 'cli' marks §2.4 probe-validated degraded auth. */
  validatedVia?: 'direct' | 'cli'
  /** §8: validation succeeded but main's session-env write failed (success-card warning). */
  sessionEnvWarning?: string
}

/** vcs:cli-status result (install/version state of gh/glab + git TLS backend). */
export interface VcsCliStatusResult {
  gh: { installed: boolean; version?: string; meetsFloor: boolean }
  glab: { installed: boolean; version?: string; meetsFloor: boolean }
  git?: { sslBackend?: string }
}

/** One entry of the §4 merged GitLab host union (gitlab:enumerate-hosts). */
export interface GitLabHostEntry {
  host: string
  /** Provenance badges: where this host is known from. */
  sources: Array<'glab' | 'env' | 'session' | 'recent'>
  /** Offline-only check: credential FOUND (not yet validated). */
  hasCredential: boolean
}

/** Sentinel option value for the "Other instance…" dropdown row (§4 item 3). */
export const OTHER_INSTANCE_SENTINEL = '__other__'

/** Provenance metadata for the success card's source/transport lines (§5). */
export interface GitSuccessMeta {
  /** Which source produced the credential. */
  source?: 'env' | 'cli' | 'config'
  /** The env var the token came from (source line: "Detected from GITHUB_TOKEN"). */
  envVar?: string
  /** 'cli' marks §2.4 probe-validated degraded auth (transport line). */
  validatedVia?: 'direct' | 'cli'
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
