/** Which authentication tab is active. Maps 1:1 onto AwsAuth's three tabs:
 *  `service_account` <- `credentials`, `oauth` <- `sso`, `gcloud` <- `profile`. */
export type GoogleAuthMethod = 'service_account' | 'oauth' | 'gcloud'

/**
 * One sub-selection state, not two: GCP has no account -> role two-step, so
 * AwsAuth's `select_account` + `select_role` collapse into `select_project`.
 */
export type GoogleAuthStatus =
  | 'pending'
  | 'authenticating'
  | 'authenticated'
  | 'failed'
  | 'select_project'

// =============================================================================
// Credential Detection Types (same pattern as AwsAuth / GitAuth)
// =============================================================================

/** Status of the credential detection process. */
export type GoogleDetectionStatus = 'pending' | 'detected' | 'done'

/** Where the detected credentials came from. */
export type GoogleDetectionSource = 'env' | 'adc' | 'gcloud' | 'block' | null

/**
 * Credential source configuration for auto-detection. Sources are tried in the
 * order the author wrote them until one succeeds.
 *
 * IMPORTANT: only one { block: string } source is allowed in the array.
 */
export type GoogleCredentialSource =
  | 'env'                        // GOOGLE_APPLICATION_CREDENTIALS / GOOGLE_CREDENTIALS / access token
  | { env: { prefix?: string } } // PREFIX_GOOGLE_APPLICATION_CREDENTIALS, ...
  | 'adc'                        // ~/.config/gcloud/application_default_credentials.json
  | 'gcloud'                     // the ACTIVE gcloud configuration (account + project + ADC)
  | { block: string }            // Command block output (only one allowed)

/**
 * How a credential was obtained. Mirrors the `type` field of a Google
 * credentials JSON document, plus the two shapes that have no file form.
 */
export type GoogleCredentialType =
  | 'service_account'
  | 'authorized_user'
  | 'external_account'
  | 'impersonated_service_account'
  | 'access_token'
  | 'gce_metadata'

/**
 * Detected credentials awaiting user confirmation. Metadata about the
 * credential — never the credential itself.
 */
export interface DetectedGoogleCredentials {
  projectId: string
  /** Project display name, best-effort. */
  projectName?: string
  /** Service-account or user email. The `arn` analogue. */
  principal: string
  credentialType: GoogleCredentialType
  source: GoogleDetectionSource
  quotaProjectId?: string
  /** Which env var supplied it (source 'env'). */
  envVar?: string
  /** The prefix used (source { env: { prefix } }). */
  envPrefix?: string
  /** Credential file path, when the source was a file. Not a secret. */
  path?: string
  /** The named gcloud configuration (source 'gcloud'). */
  configuration?: string
  /**
   * Required scopes this credential is missing. When present the block shows
   * the insufficient-scopes recovery card instead of "Use These Credentials".
   */
  missingScopes?: string[]
  /** Scopes tokeninfo reported on the detected credential, when known. */
  grantedScopes?: string[]
}

// =============================================================================
// Project / gcloud configuration types
// =============================================================================

/** <- SSOAccount. The project picker's row type. */
export interface GoogleProjectInfo {
  projectId: string
  displayName: string
  projectNumber?: string
  state?: string
}

/** <- ProfileInfo. One `config_*` file under the gcloud config root. */
export interface GcloudConfigInfo {
  name: string
  isActive: boolean
  account?: string
  project?: string
  region?: string
  zone?: string
  authType: 'adc-user' | 'adc-service-account' | 'adc-external' | 'config-only' | 'unsupported'
}

/** Metadata about the well-known application_default_credentials.json. */
export interface AdcInfo {
  path: string
  type: GoogleCredentialType
  clientEmail?: string
  quotaProjectId?: string
}

/** <- AccountInfo. What the success card renders. */
export interface GoogleAccountInfo {
  projectId?: string
  projectName?: string
  principal?: string
  accountType?: 'service_account' | 'user'
  credentialType?: GoogleCredentialType
  scopes?: string[]
  /** Absolute path of the credentials file backing this session. Not a secret. */
  credentialsPath?: string
}

// =============================================================================
// Block props
// =============================================================================

export interface GoogleAuthProps {
  id: string
  title?: string
  description?: string
  /**
   * GCP project to authenticate against — the analogue of `ssoAccountId`. When
   * set, the project picker is skipped and this project is pinned.
   */
  project?: string
  /**
   * OAuth scopes for Google Sign-In, and — when set — required of any
   * auto-detected or gcloud user ADC this block will accept. Default (Sign-In
   * only, not enforced on ambient ADC): cloud-platform + userinfo.email + openid.
   */
  scopes?: string[]
  /** Custom OAuth client id for the installed-app flow. Main owns the default. */
  oauthClientId?: string
  /**
   * Client "secret" for a custom installed-app OAuth client. Per RFC 8252 this
   * is not confidential; it is required only because Google issues one with
   * every Desktop client.
   */
  oauthClientSecret?: string
  /** SECONDARY, optional: default compute region -> CLOUDSDK_COMPUTE_REGION. */
  defaultRegion?: string
  /** SECONDARY, optional: default compute zone -> CLOUDSDK_COMPUTE_ZONE. */
  defaultZone?: string
  /** Pin the named gcloud configuration used by the third tab. */
  gcloudConfiguration?: string
  /**
   * Credential detection configuration.
   * - `false`: disable auto-detection, show manual auth only
   * - Array of sources: try each source in order until one succeeds
   * - Default: `['env', 'adc']`
   *
   * Like AwsAuth (and unlike GitAuth), detected credentials require user
   * confirmation before use, so a runbook never silently operates against the
   * wrong GCP project.
   */
  detectCredentials?: false | GoogleCredentialSource[]
  /** Reference to one or more Inputs by ID for template expressions in props. */
  inputsId?: string | string[]
}
