/**
 * A GoogleAuth block's export for electron/main/ipc/google.ts: the env a
 * script that names the block in `envFrom` runs with.
 *
 * Pure, like ./google-credential-registry.ts, so the rule it encodes can be
 * exercised without an Electron `ipcMain`: a block's credential, account,
 * project, region, zone and gcloud configuration are exported together, and
 * the export clears every other Google variable, so nothing from another
 * block or from the environment the app started with mixes with them.
 */
import { authEnvExport, type EnvExport } from "../../../src/domain/exec/authEnv.ts"
import { activeCredentialFor, type ActiveGoogleCredential } from "./google-credential-registry.ts"

/**
 * The export's vars that name a credentials file. A file this app wrote is
 * deleted at quit (cleanupGoogleCredentialFiles), so a session resumed in a
 * later run drops an export whose file is gone.
 */
export const GOOGLE_CREDENTIAL_FILE_ENV_VARS = [
  "GOOGLE_APPLICATION_CREDENTIALS",
  "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE",
] as const

interface GoogleEnvInput {
  readonly credentialsPath?: string | undefined
  /** §8.4 only: a bearer the environment ALREADY contained. We never mint one. */
  readonly accessToken?: string | undefined
  readonly projectId?: string | undefined
  readonly principal?: string | undefined
  readonly region?: string | undefined
  readonly zone?: string | undefined
  readonly configuration?: string | undefined
}

/**
 * The variables a Google sign-in sets (§7.1).
 *
 * Nothing is set empty: a GOOGLE_APPLICATION_CREDENTIALS that names a bogus
 * path is a hard error in every Google client library. Inline key material
 * (`GOOGLE_CREDENTIALS` and friends) is never exported: the credential reaches
 * the script as a 0600 file path.
 */
function buildGoogleEnv(input: GoogleEnvInput): Record<string, string> {
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

/** The export of `env`, which buildGoogleEnv only ever fills with Google variables. */
function googleExport(env: Record<string, string>): EnvExport {
  const result = authEnvExport("google", env)
  if (!result.ok) throw new Error(`buildGoogleEnv set a variable outside Google's: ${result.error}`)
  return result.export
}

/** A block's export for its credential: file or access token, account, project, region, zone and configuration. */
export function exportForCredential(credential: ActiveGoogleCredential): EnvExport {
  return googleExport(
    buildGoogleEnv({
      credentialsPath: credential.credentialsPath,
      accessToken: credential.ref.kind === "access_token" ? credential.ref.accessToken : undefined,
      projectId: credential.projectId,
      principal: credential.principal,
      region: credential.region,
      zone: credential.zone,
      configuration: credential.configuration,
    }),
  )
}

/** A project pinned on a block, and the block's export with it. */
export interface ProjectCommit {
  readonly envExport: EnvExport
  /** Region/zone now in force for the block: what the block publishes. */
  readonly region?: string
  readonly zone?: string
}

/**
 * Pin a project on the CALLING block's credential (`google:set-project`).
 *
 * Only that block's credential and export change: picking a project in one
 * GoogleAuth block must not rewrite another block's. A region or zone the
 * renderer did not send keeps the one the block authenticated with (a gcloud
 * configuration's compute defaults, say).
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
    // project alone is all there is to export.
    return {
      envExport: googleExport(
        buildGoogleEnv({ projectId: params.projectId, region: params.region, zone: params.zone }),
      ),
      ...(params.region ? { region: params.region } : {}),
      ...(params.zone ? { zone: params.zone } : {}),
    }
  }

  active.projectId = params.projectId
  if (params.region) active.region = params.region
  if (params.zone) active.zone = params.zone
  return {
    envExport: exportForCredential(active),
    ...(active.region ? { region: active.region } : {}),
    ...(active.zone ? { zone: active.zone } : {}),
  }
}
