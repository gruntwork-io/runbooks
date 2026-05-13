/**
 * AWS authentication logic.
 */
import { Effect } from "effect"
import { AwsClient } from "../../services/AwsClient.ts"
import type { AwsCredentials, SsoPollParams, SsoCompleteParams } from "../../services/AwsClient.ts"
import { Environment } from "../../services/Environment.ts"
import { AwsAuthError } from "../../errors/index.ts"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** STS calls always use us-east-1 regardless of the user's configured region. */
const STS_REGION = "us-east-1"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EnvCredentials {
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly sessionToken?: string
  readonly region?: string
}

// ---------------------------------------------------------------------------
// Credential Validation
// ---------------------------------------------------------------------------

/**
 * Validate AWS credentials by calling STS GetCallerIdentity.
 * Always uses us-east-1 for the STS call regardless of the provided region.
 */
export const validateCredentials = (creds: AwsCredentials, _region: string) =>
  Effect.gen(function* () {
    const awsClient = yield* AwsClient
    return yield* awsClient.validateCredentials(creds, STS_REGION)
  })

// ---------------------------------------------------------------------------
// Environment Credential Detection
// ---------------------------------------------------------------------------

/**
 * Detect AWS credentials from environment variables.
 * Checks AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN, and
 * AWS_DEFAULT_REGION. Returns undefined if the required key ID and secret are
 * not both present.
 *
 * An optional `envVarName` can be provided to check for a custom env var name
 * that holds the access key ID.
 */
export const detectEnvCredentials = (envVarName?: string) =>
  Effect.gen(function* () {
    const env = yield* Environment

    const accessKeyId = yield* env.get(envVarName ?? "AWS_ACCESS_KEY_ID")
    const secretAccessKey = yield* env.get("AWS_SECRET_ACCESS_KEY")

    if (!accessKeyId || !secretAccessKey) {
      return undefined
    }

    const sessionToken = yield* env.get("AWS_SESSION_TOKEN")
    const region = yield* env.get("AWS_DEFAULT_REGION")

    const result: EnvCredentials = {
      accessKeyId,
      secretAccessKey,
      ...(sessionToken ? { sessionToken } : {}),
      ...(region ? { region } : {}),
    }

    return result
  })

/**
 * Validate credentials detected from environment variables and return them
 * as full AwsCredentials. Fails with AwsAuthError if no env credentials are
 * found.
 */
export const confirmEnvCredentials = () =>
  Effect.gen(function* () {
    const awsClient = yield* AwsClient

    const envCreds = yield* detectEnvCredentials()

    if (!envCreds) {
      return yield* new AwsAuthError({
        message: "No AWS credentials found in environment variables",
      })
    }

    const creds: AwsCredentials = {
      accessKeyId: envCreds.accessKeyId,
      secretAccessKey: envCreds.secretAccessKey,
      sessionToken: envCreds.sessionToken,
      region: envCreds.region ?? STS_REGION,
    }

    // Validate them via STS
    yield* awsClient.validateCredentials(creds, STS_REGION)

    return creds
  })

// ---------------------------------------------------------------------------
// Profile-based Authentication
// ---------------------------------------------------------------------------

/**
 * List all AWS profiles from ~/.aws/config and ~/.aws/credentials.
 */
export const listProfiles = () =>
  Effect.gen(function* () {
    const awsClient = yield* AwsClient
    return yield* awsClient.listProfiles()
  })

/**
 * Authenticate using a named AWS profile.
 */
export const authenticateProfile = (profileName: string) =>
  Effect.gen(function* () {
    const awsClient = yield* AwsClient
    return yield* awsClient.authenticateProfile(profileName)
  })

// ---------------------------------------------------------------------------
// SSO Authentication
// ---------------------------------------------------------------------------

/**
 * Start an SSO device authorization flow. Returns the verification URI and
 * user code that should be displayed to the user.
 */
export const startSsoFlow = (startUrl: string, region: string) =>
  Effect.gen(function* () {
    const awsClient = yield* AwsClient
    return yield* awsClient.startSsoDeviceAuth(startUrl, region)
  })

/**
 * Poll for the SSO token after the user has completed browser-based auth.
 */
export const pollSsoToken = (params: SsoPollParams) =>
  Effect.gen(function* () {
    const awsClient = yield* AwsClient
    return yield* awsClient.pollSsoToken(params)
  })

/**
 * Complete SSO authentication by exchanging the access token for temporary
 * credentials for the specified account and role.
 */
export const completeSsoAuth = (params: SsoCompleteParams) =>
  Effect.gen(function* () {
    const awsClient = yield* AwsClient
    return yield* awsClient.completeSsoAuth(params)
  })

/**
 * List AWS accounts accessible via SSO.
 */
export const listSsoAccounts = (accessToken: string) =>
  Effect.gen(function* () {
    const awsClient = yield* AwsClient
    return yield* awsClient.listSsoAccounts(accessToken)
  })

/**
 * List roles available for a specific SSO account.
 */
export const listSsoRoles = (accessToken: string, accountId: string) =>
  Effect.gen(function* () {
    const awsClient = yield* AwsClient
    return yield* awsClient.listSsoRoles(accessToken, accountId)
  })

// ---------------------------------------------------------------------------
// Region
// ---------------------------------------------------------------------------

/**
 * Check whether a region is valid / accessible with the given credentials.
 */
export const checkRegion = (region: string, creds: AwsCredentials) =>
  Effect.gen(function* () {
    const awsClient = yield* AwsClient
    return yield* awsClient.checkRegion(region, creds)
  })
