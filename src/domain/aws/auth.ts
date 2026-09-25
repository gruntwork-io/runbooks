/**
 * AWS authentication logic.
 */
import { Effect } from "effect"
import { AwsClient } from "../../services/AwsClient.ts"
import type { AwsCredentials, SsoPollParams, SsoCompleteParams } from "../../services/AwsClient.ts"
import { Environment } from "../../services/Environment.ts"
import { AwsAuthError } from "../../errors/index.ts"
import { ENV_PREFIX_PATTERN } from "../env-prefix.ts"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** STS calls always use us-east-1 regardless of the user's configured region. */
const STS_REGION = "us-east-1"

/**
 * Working region for env credentials when neither the environment nor the
 * block's defaultRegion names one. Kept apart from STS_REGION: that is only
 * the endpoint GetCallerIdentity is sent to, not a region to hand the user.
 */
const FALLBACK_REGION = "us-east-1"

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
 * Detect AWS credentials from environment variables: AWS_ACCESS_KEY_ID and
 * AWS_SECRET_ACCESS_KEY (both required), the optional AWS_SESSION_TOKEN, and
 * a region from AWS_REGION, then AWS_DEFAULT_REGION. Returns undefined if the
 * key ID and secret are not both present.
 *
 * With a `prefix` (the `{env:{prefix}}` variant) every name is looked up with
 * the prefix prepended (PROD_AWS_ACCESS_KEY_ID, ...). The prefix MUST already
 * be allowlist-validated (ENV_PREFIX_PATTERN) by the caller in main; an
 * invalid prefix yields undefined here as defense in depth, and never falls
 * back to the unprefixed names — that would hand over a credential the author
 * did not ask for.
 */
export const detectEnvCredentials = (prefix?: string) =>
  Effect.gen(function* () {
    const env = yield* Environment

    if (prefix !== undefined && prefix !== "" && !ENV_PREFIX_PATTERN.test(prefix)) {
      return undefined
    }
    const p = prefix ?? ""

    const accessKeyId = yield* env.get(`${p}AWS_ACCESS_KEY_ID`)
    const secretAccessKey = yield* env.get(`${p}AWS_SECRET_ACCESS_KEY`)

    if (!accessKeyId || !secretAccessKey) {
      return undefined
    }

    const sessionToken = yield* env.get(`${p}AWS_SESSION_TOKEN`)
    const region = (yield* env.get(`${p}AWS_REGION`)) || (yield* env.get(`${p}AWS_DEFAULT_REGION`))

    const result: EnvCredentials = {
      accessKeyId,
      secretAccessKey,
      ...(sessionToken ? { sessionToken } : {}),
      ...(region ? { region } : {}),
    }

    return result
  })

/**
 * Validate detected env credentials via STS and return them as full
 * AwsCredentials together with the identity they belong to. The working
 * region is the environment's, then the block's `defaultRegion`, then
 * FALLBACK_REGION.
 */
export const validateEnvCredentials = (envCreds: EnvCredentials, defaultRegion?: string) =>
  Effect.gen(function* () {
    const awsClient = yield* AwsClient

    const credentials: AwsCredentials = {
      accessKeyId: envCreds.accessKeyId,
      secretAccessKey: envCreds.secretAccessKey,
      sessionToken: envCreds.sessionToken,
      region: envCreds.region || defaultRegion || FALLBACK_REGION,
    }

    const identity = yield* awsClient.validateCredentials(credentials, STS_REGION)

    return { credentials, identity }
  })

/**
 * Re-detect the env credentials for `prefix` at confirm time and validate
 * them (see validateEnvCredentials). Fails with AwsAuthError if no env
 * credentials are found.
 */
export const confirmEnvCredentials = (prefix?: string, defaultRegion?: string) =>
  Effect.gen(function* () {
    const envCreds = yield* detectEnvCredentials(prefix)

    if (!envCreds) {
      const p = prefix ?? ""
      return yield* new AwsAuthError({
        message: `No AWS credentials found in ${p}AWS_ACCESS_KEY_ID / ${p}AWS_SECRET_ACCESS_KEY`,
      })
    }

    return yield* validateEnvCredentials(envCreds, defaultRegion)
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
