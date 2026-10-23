/**
 * The env vars an auth block gives a script for one run. A Command or Check
 * that names a block with awsAuthId, githubAuthId, gitAuthId or googleAuthId
 * gets these from the block's outputs, and a run's `envVarsOverride` carries
 * nothing else. The renderer builds the overrides from these lists, and the
 * main process refuses any other name, so no caller can set PATH, BASH_ENV,
 * LD_PRELOAD, NODE_OPTIONS or a runbook-managed var such as RUNBOOK_OUTPUT
 * for a run.
 *
 * The renderer bundles this module directly, so it must stay free of imports.
 */

/** What an awsAuthId reference passes, and all an <AwsAuth> block writes to the session env. */
export const AWS_AUTH_ENV_VARS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_REGION",
  "AWS_SESSION_TOKEN",
] as const

/** What a githubAuthId reference passes. */
export const GITHUB_AUTH_ENV_VARS = ["GITHUB_TOKEN", "GITHUB_USER"] as const

/** What a gitAuthId reference passes: whichever of these the GitAuth block emitted. */
export const GIT_AUTH_ENV_VARS = [...GITHUB_AUTH_ENV_VARS, "GITLAB_TOKEN", "GITLAB_USER"] as const

/**
 * What a googleAuthId reference passes. `GOOGLE_APPLICATION_CREDENTIALS` is
 * the credential itself; the rest pin the project/account/region/zone that
 * gcloud, the client libraries, and the OpenTofu `google` provider each read
 * under a different name.
 */
export const GOOGLE_AUTH_ENV_VARS = [
  "GOOGLE_APPLICATION_CREDENTIALS",
  "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE",
  "GOOGLE_CLOUD_PROJECT",
  "CLOUDSDK_CORE_PROJECT",
  "GOOGLE_PROJECT",
  "CLOUDSDK_CORE_ACCOUNT",
  "GOOGLE_CLOUD_REGION",
  "CLOUDSDK_COMPUTE_REGION",
  "GOOGLE_REGION",
  "CLOUDSDK_COMPUTE_ZONE",
  "GOOGLE_ZONE",
] as const

const AUTH_ENV_VARS: readonly string[] = [
  ...AWS_AUTH_ENV_VARS,
  ...GIT_AUTH_ENV_VARS,
  ...GOOGLE_AUTH_ENV_VARS,
]

/** The names in `env` that `allowed` doesn't list, sorted. By default, those no auth block passes. */
export function disallowedEnvVars(
  env: Record<string, string>,
  allowed: readonly string[] = AUTH_ENV_VARS,
): string[] {
  const ok = new Set(allowed)
  return Object.keys(env)
    .filter((name) => !ok.has(name))
    .sort()
}
