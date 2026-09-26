/**
 * AWS authentication logic.
 */
import { Effect } from "effect"
import { AwsClient } from "../../services/AwsClient.ts"
import type {
  AwsCredentials,
  AwsIdentity,
  SsoAccount,
  SsoPollParams,
  SsoCompleteParams,
} from "../../services/AwsClient.ts"
import { Environment } from "../../services/Environment.ts"
import { AwsAuthError, AwsSsoError } from "../../errors/index.ts"
import { ENV_PREFIX_PATTERN } from "../env-prefix.ts"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EnvCredentials {
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly sessionToken?: string
  readonly region?: string
}

/** One poll of the SSO device flow with the block's optional pinned account and role. */
export interface SsoFlowPollParams extends SsoPollParams {
  readonly accountId?: string
  readonly roleName?: string
}

/**
 * Where the SSO device flow stands after one poll. The block's aws:sso-poll
 * reply is built from this; failures travel in the error channel.
 */
export type SsoPollOutcome =
  | { readonly status: "pending" }
  | {
      readonly status: "select_account"
      readonly accessToken: string
      readonly accounts: readonly SsoAccount[]
    }
  | {
      readonly status: "success"
      readonly credentials: AwsCredentials
      readonly identity: AwsIdentity
    }

// ---------------------------------------------------------------------------
// Working Region
// ---------------------------------------------------------------------------

/**
 * The working region, or `missing` as an AwsAuthError when nothing named one.
 * The region also picks the partition credentials are validated in, so a
 * guessed default would send GovCloud credentials to commercial STS.
 */
const resolveRegion = (region: string | undefined, missing: string) =>
  region ? Effect.succeed(region) : Effect.fail(new AwsAuthError({ message: missing }))

// ---------------------------------------------------------------------------
// Credential Validation
// ---------------------------------------------------------------------------

/**
 * Validate AWS credentials by calling STS GetCallerIdentity. `region` is the
 * working region; the client sends the call to its partition's STS.
 */
export const validateCredentials = (creds: AwsCredentials, region: string) =>
  Effect.gen(function* () {
    const awsClient = yield* AwsClient
    return yield* awsClient.validateCredentials(creds, region)
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
 * region is the environment's, then the block's `defaultRegion`; with
 * neither, it fails rather than guess one.
 */
export const validateEnvCredentials = (envCreds: EnvCredentials, defaultRegion?: string) =>
  Effect.gen(function* () {
    const credentials: AwsCredentials = {
      accessKeyId: envCreds.accessKeyId,
      secretAccessKey: envCreds.secretAccessKey,
      sessionToken: envCreds.sessionToken,
      region: yield* resolveRegion(
        envCreds.region || defaultRegion,
        "No AWS region for the environment credentials: set AWS_REGION (with the block's prefix, if it uses one) or give the AwsAuth block a defaultRegion",
      ),
    }

    const identity = yield* validateCredentials(credentials, credentials.region)

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
 * Resolve a named AWS profile's credentials. The region is the profile's own,
 * then the block's `defaultRegion`. Does not validate them: callers run
 * validateCredentials.
 */
export const authenticateProfile = (profileName: string, defaultRegion?: string) =>
  Effect.gen(function* () {
    const awsClient = yield* AwsClient
    const credentials = yield* awsClient.authenticateProfile(profileName)
    const region = yield* resolveRegion(
      credentials.region || defaultRegion,
      `No AWS region for profile "${profileName}": set region in its AWS config or give the AwsAuth block a defaultRegion`,
    )
    return { ...credentials, region }
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
 * Exchange the SSO access token for the role's credentials and confirm them
 * via STS in the partition of the IAM Identity Center region. Returns the
 * credentials together with the identity they belong to.
 */
export const signInWithSsoRole = (params: SsoCompleteParams) =>
  Effect.gen(function* () {
    const credentials = yield* completeSsoAuth(params)
    const identity = yield* validateCredentials(credentials, params.region)
    return { credentials, identity }
  })

/**
 * List AWS accounts accessible via SSO. `region` is where the IAM Identity
 * Center instance lives.
 */
export const listSsoAccounts = (accessToken: string, region: string) =>
  Effect.gen(function* () {
    const awsClient = yield* AwsClient
    return yield* awsClient.listSsoAccounts(accessToken, region)
  })

/**
 * List roles available for a specific SSO account. `region` is where the IAM
 * Identity Center instance lives.
 */
export const listSsoRoles = (accessToken: string, accountId: string, region: string) =>
  Effect.gen(function* () {
    const awsClient = yield* AwsClient
    return yield* awsClient.listSsoRoles(accessToken, accountId, region)
  })

/**
 * One poll of the SSO device flow, carried as far as it can go without the
 * user:
 * - not approved yet → pending;
 * - approved, with the block's account and role both pinned → sign in to
 *   that role;
 * - otherwise list the accounts: none fails; exactly one account with exactly
 *   one role signs in to it; anything else asks the user to choose.
 *
 * Every SSO call goes to `params.region`, where the device flow was started.
 */
export const pollSsoFlow = (
  params: SsoFlowPollParams,
): Effect.Effect<SsoPollOutcome, AwsSsoError | AwsAuthError, AwsClient> =>
  Effect.gen(function* () {
    const token = yield* pollSsoToken(params)
    if (token.pending) {
      return { status: "pending" } as const
    }
    const accessToken = token.accessToken
    if (!accessToken) {
      return yield* new AwsSsoError({ message: "SSO sign-in finished without an access token" })
    }

    const { region } = params
    let accountId = params.accountId
    let roleName = params.roleName

    if (!accountId || !roleName) {
      const accounts = yield* listSsoAccounts(accessToken, region)
      if (accounts.length === 0) {
        return yield* new AwsSsoError({ message: "No AWS accounts are available to you in IAM Identity Center" })
      }
      const selectAccount = { status: "select_account", accessToken, accounts } as const
      if (accounts.length > 1) {
        return selectAccount
      }

      const [account] = accounts
      const roles = yield* listSsoRoles(accessToken, account.accountId, region)
      if (roles.length === 0) {
        return yield* new AwsSsoError({ message: `No roles are available to you in account ${account.accountId}` })
      }
      if (roles.length > 1) {
        return selectAccount
      }
      accountId = account.accountId
      roleName = roles[0].roleName
    }

    const { credentials, identity } = yield* signInWithSsoRole({ accessToken, accountId, roleName, region })
    return { status: "success", credentials, identity } as const
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
