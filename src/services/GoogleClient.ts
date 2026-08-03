import { Context, Effect } from "effect"
import type { GoogleAuthError, GoogleConfigError, GoogleOAuthError } from "../errors/index.ts"

/**
 * How a credential was obtained. Mirrors the `type` field of a Google
 * credentials JSON document, plus the two shapes that have no file form.
 */
export type GoogleCredentialType =
  | "service_account"
  | "authorized_user"
  | "external_account"
  | "impersonated_service_account"
  | "access_token"
  | "gce_metadata"

/**
 * A credential the layer can turn into a google-auth-library client. Secret
 * material stays inside main + the layer; this type never crosses IPC.
 */
export type GoogleCredentialRef =
  | { readonly kind: "service_account"; readonly keyJson: string }
  | { readonly kind: "authorized_user"; readonly adcJson: string }
  | { readonly kind: "access_token"; readonly accessToken: string }
  | { readonly kind: "file"; readonly path: string }

/** The GetCallerIdentity analogue: who the credential proves you are. */
export interface GoogleIdentity {
  readonly email: string
  readonly uniqueId?: string
  readonly accountType: "service_account" | "user"
  readonly credentialType: GoogleCredentialType
  /** Project bound to the credential (key's project_id, quota project, or an override). */
  readonly projectId?: string
  /** Display name — best-effort enrichment, undefined when the caller cannot read the project. */
  readonly projectName?: string
  readonly scopes?: readonly string[]
}

/**
 * Whether a credential can read a project.
 *
 * Deliberately three-valued rather than a boolean. `AwsSdkClient.checkRegion`
 * uses `catch: () => true` — it FAILS OPEN so a transient error never produces
 * a false "that region is disabled" warning. The same discipline applies here,
 * but the reason matters: a project that answers 404/PERMISSION_DENIED is a
 * real `denied`, while a disabled Resource Manager API, an insufficient scope,
 * or a dropped connection is `unknown` and must not be reported to the user as
 * an inaccessible project.
 */
export type GoogleProjectAccess = "accessible" | "denied" | "unknown"

/** A project visible to the credential. The SsoAccount analogue. */
export interface GoogleProject {
  readonly projectId: string
  readonly displayName: string
  readonly projectNumber?: string
  readonly state?: string
}

/** Metadata about an on-disk credentials JSON. NEVER carries secret fields. */
export interface AdcInfo {
  readonly path: string
  readonly type: GoogleCredentialType
  readonly clientEmail?: string
  readonly quotaProjectId?: string
}

/** One `~/.config/gcloud/configurations/config_*` file. The ProfileInfo analogue. */
export interface GcloudConfiguration {
  readonly name: string
  readonly isActive: boolean
  readonly account?: string
  readonly project?: string
  readonly region?: string
  readonly zone?: string
  readonly authType:
    | "adc-user"
    | "adc-service-account"
    | "adc-external"
    | "config-only"
    | "unsupported"
}

export interface GcloudConfigListing {
  readonly configurations: readonly GcloudConfiguration[]
  readonly activeConfiguration?: string
  /** Resolved config root, for the "no gcloud config found at X" copy. */
  readonly configRoot: string
  /** Present when application_default_credentials.json exists. */
  readonly adc?: AdcInfo
}

export interface OAuthStartParams {
  readonly clientId: string
  readonly clientSecret?: string
  readonly scopes: readonly string[]
  readonly loginHint?: string
}

export interface OAuthFlowStart {
  /** Opaque handle for poll/cancel. Never a token, never guessable. */
  readonly flowId: string
  readonly authUrl: string
  readonly redirectUri: string
  readonly expiresInSeconds: number
}

export interface OAuthFlowResult {
  readonly status: "pending" | "complete" | "expired" | "failed"
  /**
   * On "complete": a full authorized_user ADC document
   * ({type, client_id, client_secret, refresh_token}). Carries the refresh
   * token — stays main-side, materialised to a 0600 file, never crosses IPC.
   */
  readonly adcJson?: string
  /** On "complete": the freshly minted access token, used only to read identity. */
  readonly accessToken?: string
  readonly scopes?: readonly string[]
  readonly error?: string
}

export interface GoogleClientShape {
  /** <- AwsClient.validateCredentials. Parses + JWT-authorizes a service-account key. */
  readonly validateServiceAccountKey: (
    keyJson: string,
    projectIdOverride?: string,
  ) => Effect.Effect<GoogleIdentity, GoogleAuthError>

  /** <- AwsClient.validateCredentials for the OAuth/ADC paths (oauth2 tokeninfo). */
  readonly validateAccessToken: (
    accessToken: string,
    projectIdOverride?: string,
  ) => Effect.Effect<GoogleIdentity, GoogleAuthError>

  /** authorized_user / external_account / impersonated ADC: refresh, then tokeninfo. */
  readonly validateAdcDocument: (
    adcJson: string,
    projectIdOverride?: string,
  ) => Effect.Effect<GoogleIdentity, GoogleAuthError>

  /** Read + classify a credentials JSON path. Metadata only — no secrets returned. */
  readonly readCredentialFile: (
    filePath: string,
  ) => Effect.Effect<AdcInfo, GoogleConfigError>

  /** Read a credentials JSON path in full (secret material) for validation/materialisation. */
  readonly readCredentialFileContents: (
    filePath: string,
  ) => Effect.Effect<string, GoogleConfigError>

  /** <- AwsClient.listProfiles. Pure disk reads of the gcloud config root. */
  readonly listGcloudConfigurations: () => Effect.Effect<GcloudConfigListing, GoogleConfigError>

  /** The well-known application_default_credentials.json, metadata only. */
  readonly readApplicationDefaultCredentials: () => Effect.Effect<
    AdcInfo | undefined,
    GoogleConfigError
  >

  /** <- AwsClient.startSsoDeviceAuth. Opens the loopback listener; see plan §5. */
  readonly startOAuthFlow: (
    params: OAuthStartParams,
  ) => Effect.Effect<OAuthFlowStart, GoogleOAuthError>

  /** <- AwsClient.pollSsoToken. Returns {status:"pending"} until the callback lands. */
  readonly pollOAuthFlow: (
    flowId: string,
  ) => Effect.Effect<OAuthFlowResult, GoogleOAuthError>

  /** No AWS analogue: closes the loopback server and drops the flow record. */
  readonly cancelOAuthFlow: (flowId: string) => Effect.Effect<void>

  /** <- AwsClient.listSsoAccounts. Cloud Resource Manager v3 projects:search. */
  readonly listProjects: (
    creds: GoogleCredentialRef,
    query?: string,
    pageSize?: number,
  ) => Effect.Effect<GoogleProject[], GoogleAuthError>

  /**
   * <- AwsClient.checkRegion. Confirms the project exists AND is readable.
   * Fails only when the credential cannot produce a client at all; every
   * request-level outcome is reported through `GoogleProjectAccess`.
   */
  readonly checkProject: (
    projectId: string,
    creds: GoogleCredentialRef,
  ) => Effect.Effect<GoogleProjectAccess, GoogleAuthError>
}

export class GoogleClient extends Context.Tag("GoogleClient")<GoogleClient, GoogleClientShape>() {}
