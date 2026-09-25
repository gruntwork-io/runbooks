/**
 * What the session env should hold for a Google credential, for
 * electron/main/ipc/google.ts.
 *
 * Pure: this module decides WHICH keys to set and delete, and google.ts applies
 * the change to the session. Split out of the IPC module, like
 * ./google-credential-registry.ts, so the rule it encodes can be exercised
 * without an Electron `ipcMain`: the session env always describes ONE block's
 * whole credential. The documented multi-project pattern puts
 * `<GoogleAuth id="source"/>` next to `<GoogleAuth id="target"/>`, and writing
 * only a project there pairs one block's credential and account with the
 * other block's project.
 */
import { activeCredentialFor, type ActiveGoogleCredential } from "./google-credential-registry.ts"

interface SessionEnvInput {
  readonly credentialsPath?: string
  /** §8.4 only: a bearer the environment ALREADY contained. We never mint one. */
  readonly accessToken?: string
  readonly projectId?: string
  readonly principal?: string
  readonly region?: string
  readonly zone?: string
  readonly configuration?: string
}

/**
 * The session env every successful Google authentication writes (§7.1).
 *
 * Nothing is ever written empty: an unset-but-present
 * GOOGLE_APPLICATION_CREDENTIALS pointing at a bogus path is a hard error in
 * every Google client library and would break every subsequent `<Command>`.
 * Inline key material (`GOOGLE_CREDENTIALS` and friends) is never written at
 * all — the credential reaches the child process as a 0600 file path.
 */
function buildGoogleSessionEnv(input: SessionEnvInput): Record<string, string> {
  const env: Record<string, string> = {}

  if (input.credentialsPath) {
    env.GOOGLE_APPLICATION_CREDENTIALS = input.credentialsPath
    // Bridges to the `gcloud` CLI's OWN credential store, which is separate
    // from ADC and — whenever any `gcloud auth login` account is already
    // configured on the machine — takes precedence over it. Without this, a
    // bare `gcloud` invocation silently ignores this block's credential and
    // uses whatever CLI login already exists, failing non-interactively the
    // moment that login is stale. Routing through this property keeps gcloud
    // on its normal refreshable-credential code path; a static bearer token
    // would look like the same fix but some legacy v1 APIs (e.g. Cloud
    // Resource Manager's Organizations.SearchOrganizations) reject one
    // outright with ACCESS_TOKEN_TYPE_UNSUPPORTED.
    env.CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE = input.credentialsPath
  } else if (input.accessToken) {
    // The single documented exception to D6: an access token the user's
    // environment already supplied, re-exported under its canonical names.
    env.GOOGLE_OAUTH_ACCESS_TOKEN = input.accessToken
    env.CLOUDSDK_AUTH_ACCESS_TOKEN = input.accessToken
  }

  if (input.projectId) {
    env.GOOGLE_CLOUD_PROJECT = input.projectId
    env.CLOUDSDK_CORE_PROJECT = input.projectId
    // The Terraform/OpenTofu `google` provider's first-choice variable.
    env.GOOGLE_PROJECT = input.projectId
  }
  if (input.principal) env.CLOUDSDK_CORE_ACCOUNT = input.principal
  if (input.region) {
    env.GOOGLE_CLOUD_REGION = input.region
    env.CLOUDSDK_COMPUTE_REGION = input.region
    env.GOOGLE_REGION = input.region
  }
  if (input.zone) {
    env.CLOUDSDK_COMPUTE_ZONE = input.zone
    env.GOOGLE_ZONE = input.zone
  }
  // The AWS_PROFILE analogue — gcloud tab only.
  if (input.configuration) env.CLOUDSDK_ACTIVE_CONFIG_NAME = input.configuration

  return env
}

/** A change to the session env: keys to set, then keys to delete. */
export interface GoogleSessionEnvChange {
  readonly set: Record<string, string>
  readonly clear: readonly string[]
}

/**
 * Point the whole session env at ONE block's credential: its credentials file
 * (or bare access token), principal, project, region, zone and gcloud
 * configuration, together. Every write that makes a block the session default
 * goes through here.
 */
export function sessionEnvForCredential(credential: ActiveGoogleCredential): GoogleSessionEnvChange {
  return {
    set: buildGoogleSessionEnv({
      credentialsPath: credential.credentialsPath,
      accessToken: credential.ref.kind === "access_token" ? credential.ref.accessToken : undefined,
      projectId: credential.projectId,
      principal: credential.principal,
      region: credential.region,
      zone: credential.zone,
      configuration: credential.configuration,
    }),
    // A bare access token has no file to bridge with. Without this, the SAME
    // block re-authenticating from a file-backed credential to an access token
    // (or a later block in the same session doing so) would leave gcloud
    // routed through the previous credential's file via a now-stale override.
    clear: credential.credentialsPath ? [] : ["CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE"],
  }
}

/** A project pinned on a block, and the session env that goes with it. */
export interface ProjectCommit {
  readonly env: GoogleSessionEnvChange
  /** Region/zone now in force for the block: what the block publishes. */
  readonly region?: string
  readonly zone?: string
}

/**
 * Pin a project on the CALLING block's credential (`google:set-project`).
 *
 * Only that block's credential is repointed: picking a project in one
 * GoogleAuth block must not rewrite another block's. A region or zone the
 * renderer did not send keeps the one the block authenticated with (a gcloud
 * configuration's compute defaults, say).
 *
 * A project pick commits the block the way an authentication does, so the
 * session is re-pointed at the block's WHOLE credential, not just its project.
 * Writing the project alone left bare commands running with whichever block
 * authenticated last's credential and account, against this block's project.
 */
export function commitBlockProject(params: {
  blockId?: string
  projectId: string
  region?: string
  zone?: string
}): ProjectCommit {
  const active = activeCredentialFor(params.blockId)
  if (!active) {
    // No credential registered for the block, which nothing in-tree does: a
    // project alone is all there is to write.
    return {
      env: {
        set: buildGoogleSessionEnv({
          projectId: params.projectId,
          region: params.region,
          zone: params.zone,
        }),
        clear: [],
      },
      ...(params.region ? { region: params.region } : {}),
      ...(params.zone ? { zone: params.zone } : {}),
    }
  }

  active.projectId = params.projectId
  if (params.region) active.region = params.region
  if (params.zone) active.zone = params.zone
  return {
    env: sessionEnvForCredential(active),
    ...(active.region ? { region: active.region } : {}),
    ...(active.zone ? { zone: active.zone } : {}),
  }
}
